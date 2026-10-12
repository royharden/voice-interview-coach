import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const FN_NAME = "interviewer";

// Request limits, enforced before any paid call or prompt building.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_ROLE_CHARS = 200;
const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 3000;
const MAX_JOB_DESCRIPTION_CHARS = 2000;
const MAX_TURNS = 20;
const MAX_FEEDBACK_CHARS = 8000;
const OPENAI_TIMEOUT_MS = 30_000;
// Sessions can only get their score/feedback saved shortly after creation.
const SESSION_SAVE_WINDOW_MS = 24 * 60 * 60 * 1000;

const SENIORITIES = ["Intern", "Junior", "Mid-level", "Senior", "Staff", "Lead"] as const;
const INTERVIEW_TYPES = ["behavioral", "technical", "mixed", "frontend", "pm", "data"] as const;
const DIMENSIONS = ["situation", "task", "action", "result", "relevance"] as const;
const ANSWER_TYPES = ["real_example", "hypothetical", "generic", "uncertain"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Daily cap. Every paid OpenAI fetch is counted through increment_usage,
// which only service_role can execute.
// ---------------------------------------------------------------------------

const DEFAULT_DAILY_CAP = 200;

function dailyCap(): number {
  const raw = (Deno.env.get("DAILY_CALL_LIMIT") ?? "").trim();
  if (!/^\d{1,10}$/.test(raw)) return DEFAULT_DAILY_CAP;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : DEFAULT_DAILY_CAP;
}

let adminClient: SupabaseClient | null = null;

// Service-role client built only from env; null if either var is missing.
function getAdminClient(): SupabaseClient | null {
  if (adminClient) return adminClient;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  adminClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return adminClient;
}

type CountResult = "ok" | "capped" | "error";

// Fails closed: only a literal `true` from the RPC allows the call.
async function countPaidCall(admin: SupabaseClient): Promise<CountResult> {
  const cap = dailyCap();
  if (cap <= 0) return "capped";
  try {
    const { data, error } = await admin.rpc("increment_usage", { p_fn: FN_NAME, p_cap: cap });
    if (error) {
      console.error("increment_usage error:", error.message);
      return "error";
    }
    return data === true ? "ok" : "capped";
  } catch (err) {
    console.error("increment_usage failed:", err);
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Body parsing with a hard byte limit, and field clamping
// ---------------------------------------------------------------------------

type BodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

async function readJsonBody(req: Request, maxBytes: number): Promise<BodyResult> {
  const tooLarge = (): BodyResult => ({ ok: false, response: json({ error: "payload_too_large" }, 413) });
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, response: json({ error: "invalid_json" }, 400) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, response: json({ error: "invalid_body" }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v) ?? fallback;
}

type Dimension = (typeof DIMENSIONS)[number];

interface CleanStar {
  situation?: { score: number; confidence?: number };
  task?: { score: number; confidence?: number };
  action?: { score: number; confidence?: number };
  result?: { score: number; confidence?: number };
  relevance?: { score: number; confidence?: number };
  ownsActions?: { noul: number };
  answerType?: { choice: string; confidence?: number };
}

interface CleanTurn {
  question: string;
  kind: "question" | "follow_up";
  transcript: string;
  star?: CleanStar;
  composite?: number;
  wpm?: number;
  filler_count?: number;
}

function sanitizeStar(value: unknown): CleanStar | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  const star: CleanStar = {};
  for (const dim of DIMENSIONS) {
    const d = s[dim];
    if (!d || typeof d !== "object") continue;
    const score = boundedNumber((d as Record<string, unknown>).score, 0, 3);
    if (score === undefined) continue;
    const confidence = boundedNumber((d as Record<string, unknown>).confidence, 0, 1);
    star[dim] = confidence === undefined ? { score } : { score, confidence };
  }
  const owns = s.ownsActions as Record<string, unknown> | undefined;
  const noul = owns && typeof owns === "object" ? boundedNumber(owns.noul, 0, 1) : undefined;
  if (noul !== undefined) star.ownsActions = { noul };
  const at = s.answerType as Record<string, unknown> | undefined;
  if (at && typeof at === "object" && ANSWER_TYPES.includes(at.choice as (typeof ANSWER_TYPES)[number])) {
    const confidence = boundedNumber(at.confidence, 0, 1);
    star.answerType = { choice: at.choice as string, ...(confidence === undefined ? {} : { confidence }) };
  }
  return star;
}

// Whitelists and bounds every turn field; anything else (e.g. raw Jev
// responses) is dropped before the turns reach a prompt.
function sanitizeTurns(value: unknown): CleanTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TURNS).flatMap((raw): CleanTurn[] => {
    if (!raw || typeof raw !== "object") return [];
    const t = raw as Record<string, unknown>;
    const question = clampText(t.question, MAX_QUESTION_CHARS);
    if (!question) return [];
    const turn: CleanTurn = {
      question,
      kind: t.kind === "follow_up" ? "follow_up" : "question",
      transcript: clampText(t.transcript, MAX_ANSWER_CHARS),
    };
    const star = sanitizeStar(t.star);
    if (star) turn.star = star;
    const composite = boundedNumber(t.composite, 0, 100);
    if (composite !== undefined) turn.composite = composite;
    const wpm = boundedNumber(t.wpm, 0, 100_000);
    if (wpm !== undefined) turn.wpm = wpm;
    const fillers = boundedNumber(t.filler_count, 0, 100_000);
    if (fillers !== undefined) turn.filler_count = Math.round(fillers);
    return [turn];
  });
}

const QUESTION_BANK: Record<string, string[]> = {
  behavioral: [
    "Tell me about a time you fixed a critical production bug.",
    "Describe a situation where you disagreed with a teammate. How did you resolve it?",
    "Tell me about a project you're most proud of. What was your role?",
    "Describe a time you had to learn something new quickly under deadline pressure.",
    "Tell me about a time you received hard feedback. What did you do with it?",
    "Describe a time when you had to prioritize between two urgent tasks.",
    "Tell me about a failure and what you learned from it.",
  ],
  frontend: [
    "Walk me through how you'd make a slow page load faster. Where do you start?",
    "Tell me about a time you had to refactor a messy component. How did you approach it?",
    "Describe how you'd design a complex form with many dynamic fields and validation.",
    "Tell me about a tricky cross-browser or accessibility issue you've solved.",
    "How would you decide what state belongs in a global store versus local component state?",
  ],
  pm: [
    "Tell me about a time you shipped a feature that didn't move the metric. What did you do next?",
    "How do you decide what NOT to build when everything seems important?",
    "Describe a time you aligned stakeholders who wanted conflicting things.",
    "Tell me about a time you used data to change a roadmap decision.",
    "How would you prioritize a bug fix against a revenue feature in the same sprint?",
  ],
  data: [
    "Tell me about an analysis you did that changed a decision. What made it convincing?",
    "Describe a time you found a data quality problem. How did you handle it?",
    "How would you design an experiment to know if a feature actually worked?",
    "Tell me about a time you had to explain a complex finding to a non-technical audience.",
  ],
};

const FOLLOW_UP_TEMPLATES: Record<string, string> = {
  situation: "Can you set the scene a bit more? What was going on, and why did it matter?",
  task: "What exactly were YOU responsible for in that situation?",
  action: "Walk me through the specific steps you took, and why those steps?",
  result: "What changed because of that, and how did you measure it?",
  relevance: "Let's tie this back to the question I asked — how does what you described answer it directly?",
};

const QUESTION_POOL_KEYS = ["behavioral", "frontend", "pm", "data"];

function bankFor(interviewType: string): string[] {
  if (interviewType === "behavioral") return QUESTION_BANK.behavioral;
  if (interviewType === "frontend") return [...QUESTION_BANK.behavioral.slice(0, 2), ...QUESTION_BANK.frontend];
  if (interviewType === "pm") return [...QUESTION_BANK.behavioral.slice(0, 2), ...QUESTION_BANK.pm];
  if (interviewType === "data") return [...QUESTION_BANK.behavioral.slice(0, 2), ...QUESTION_BANK.data];
  return QUESTION_POOL_KEYS.flatMap((k) => QUESTION_BANK[k]);
}

function pickQuestions(interviewType: string, count: number): string[] {
  const pool = bankFor(interviewType);
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function templatedFeedback(turns: CleanTurn[]): string {
  const answered = turns.filter((t) => t.composite != null);
  if (answered.length === 0) return "No scored answers in this session.";

  const labels: Record<string, string> = {
    situation: "setting the situation",
    task: "stating your own responsibility",
    action: "describing concrete actions",
    result: "giving measured results",
  };
  const strengths: string[] = [];
  const improvements: string[] = [];

  for (const label of Object.keys(labels)) {
    let total = 0;
    let n = 0;
    for (const t of answered) {
      const dim = t.star?.[label as Dimension];
      if (dim?.score != null) {
        total += dim.score;
        n++;
      }
    }
    if (n === 0) continue;
    const avg = total / n;
    if (avg >= 1.5) strengths.push(`${labels[label]} (avg ${avg.toFixed(1)}/3)`);
    else improvements.push(`${labels[label]} — scores averaged ${avg.toFixed(1)}/3, so interviewers heard too little here`);
  }

  const weakest = [...answered].sort((a, b) => (a.composite ?? 0) - (b.composite ?? 0))[0];
  const stronger = weakest
    ? `Stronger answer for "${weakest.question}": state the situation in one sentence, name what you personally owned, list 2–3 concrete actions with your reasoning, then close with a measured result (numbers, timeline, or who confirmed it). Your current answer scored ${weakest.composite?.toFixed(0)}/100 on the STAR composite.`
    : "";

  const parts = [
    `Strengths: ${strengths.length ? strengths.join("; ") : "none scored above the midpoint yet — keep practicing."}`,
    `Top improvements: ${improvements.length ? improvements.join("; ") + "." : "Refine timing — your structure is working, tighten delivery."}`,
    stronger,
  ];
  return parts.filter(Boolean).join("\n\n");
}

// Same formula as the client report: mean composite of scored turns.
function overallScore(turns: CleanTurn[]): number | null {
  const scored = turns.filter((t) => t.composite != null);
  if (scored.length === 0) return null;
  return Math.round(scored.reduce((s, t) => s + (t.composite ?? 0), 0) / scored.length);
}

// Writes the end-of-session score and feedback with the service-role client.
// Only these two columns, only once (feedback still null), and only for a
// recently created session; anon has no UPDATE on sessions.
async function saveSessionResult(
  admin: SupabaseClient,
  sessionId: string,
  score: number | null,
  feedback: string,
): Promise<void> {
  const since = new Date(Date.now() - SESSION_SAVE_WINDOW_MS).toISOString();
  const { error } = await admin
    .from("sessions")
    .update({ overall_score: score, feedback: feedback.slice(0, MAX_FEEDBACK_CHARS) })
    .eq("id", sessionId)
    .is("feedback", null)
    .gte("created_at", since);
  if (error) console.error("session save failed:", error.message);
}

// Model and base URL come only from env, never from the request.
function openAiConfig() {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-6-luna";
  return { apiKey, baseUrl, model };
}

type LlmResult =
  | { kind: "ok"; content: string }
  | { kind: "capped" }
  | { kind: "counter_error" }
  | { kind: "failed" };

// One counted OpenAI fetch. No retries: on failure the caller falls back to
// the bank/template.
async function callOpenAi(
  admin: SupabaseClient,
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 900,
): Promise<LlmResult> {
  const { baseUrl, model } = openAiConfig();

  const counted = await countPaidCall(admin);
  if (counted === "capped") return { kind: "capped" };
  if (counted === "error") return { kind: "counter_error" };

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`OpenAI HTTP ${res.status}:`, text.slice(0, 500));
      return { kind: "failed" };
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      console.error("OpenAI returned an empty completion");
      return { kind: "failed" };
    }
    return { kind: "ok", content };
  } catch (err) {
    console.error("OpenAI request failed:", err);
    return { kind: "failed" };
  }
}

function parseQuestions(content: string): string[] | null {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((q) => typeof q === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

const counterUnavailable = () => json({ error: "usage_counter_unavailable" }, 503);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const admin = getAdminClient();
  if (!admin) {
    console.error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return json({ error: "server_not_configured" }, 503);
  }

  try {
    const parsed = await readJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const mode = body.mode ?? "questions";
    const mock = Boolean(body.mock);
    const apiKey = openAiConfig().apiKey;
    const useLlm = !mock && !!apiKey;

    if (mode === "questions") {
      const count = clampInt(body.count, 1, 10, 5);
      const role = clampText(body.role, MAX_ROLE_CHARS) || "software engineer";
      const seniority = oneOf(body.seniority, SENIORITIES, "Mid-level");
      const interviewType = oneOf(body.interview_type, INTERVIEW_TYPES, "mixed");
      const jobDescription = clampText(body.job_description, MAX_JOB_DESCRIPTION_CHARS);

      if (useLlm) {
        const prompt = [
          `You are a senior interviewer. Generate ${count} interview questions for a ${seniority} ${role} role.`,
          `Interview type: ${interviewType}.`,
          jobDescription ? `Job description:\n${jobDescription}` : "",
          "Return ONLY a JSON array of question strings, no numbering, no commentary.",
        ]
          .filter(Boolean)
          .join("\n");
        const llm = await callOpenAi(admin, apiKey, [{ role: "user", content: prompt }], 700);
        if (llm.kind === "counter_error") return counterUnavailable();
        const questions = llm.kind === "ok" ? parseQuestions(llm.content) : null;
        if (questions) {
          return json({ questions: questions.slice(0, count), source: "llm" });
        }
        console.log("question generation fell back to bank:", llm.kind === "ok" ? "unparseable" : llm.kind);
      }
      return json({ questions: pickQuestions(interviewType, count), source: "bank" });
    }

    if (mode === "follow_up") {
      const dim = oneOf(body.target_dimension, DIMENSIONS, "action");
      if (useLlm) {
        const question = clampText(body.question, MAX_QUESTION_CHARS);
        const answer = clampText(body.answer, MAX_ANSWER_CHARS);
        const prompt = [
          `You are a senior interviewer. The candidate just answered: "${question}".`,
          `Their answer: ${answer}`,
          `Write ONE short, natural spoken follow-up question that probes the ${dim} part of their story. Keep it under 30 words. Return only the question.`,
        ].join("\n");
        const llm = await callOpenAi(admin, apiKey, [{ role: "user", content: prompt }], 120);
        if (llm.kind === "counter_error") return counterUnavailable();
        if (llm.kind === "ok") {
          return json({ question: llm.content.trim(), source: "llm" });
        }
        console.log("follow-up fell back to template:", llm.kind);
      }
      return json({ question: FOLLOW_UP_TEMPLATES[dim] ?? FOLLOW_UP_TEMPLATES.action, source: "template" });
    }

    if (mode === "feedback") {
      const turns = sanitizeTurns(body.turns);
      const sessionId =
        typeof body.session_id === "string" && UUID_RE.test(body.session_id) ? body.session_id : null;

      let result: { feedback: string; source: "llm" | "template" } | null = null;
      if (useLlm) {
        const prompt = [
          "You are an interview coach. Below are the interview turns with STAR scores (0-3 per dimension, composite 0-100).",
          JSON.stringify(turns, null, 1),
          "Write feedback with three labeled sections exactly: 'Strengths:', 'Top 3 improvements:' (three bullets), and 'Stronger answer:' (a rewritten stronger answer for the weakest turn, citing its scores). Be specific and cite the scores.",
        ].join("\n");
        const llm = await callOpenAi(admin, apiKey, [{ role: "user", content: prompt }], 900);
        if (llm.kind === "counter_error") return counterUnavailable();
        if (llm.kind === "ok") result = { feedback: llm.content, source: "llm" };
        else console.log("feedback fell back to template:", llm.kind);
      }
      result ??= { feedback: templatedFeedback(turns), source: "template" };

      if (sessionId) await saveSessionResult(admin, sessionId, overallScore(turns), result.feedback);
      return json(result);
    }

    return json({ error: "unknown_mode" }, 400);
  } catch (err) {
    console.error("interviewer failed:", err);
    return json({ error: "internal_error" }, 500);
  }
});
