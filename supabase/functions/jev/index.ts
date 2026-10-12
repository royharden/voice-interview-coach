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

const FN_NAME = "jev";
const MODEL = "jev-1.13.0";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000; // output tokens are free

// Request limits, enforced before any paid call.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUESTION_CHARS = 1000;
const MAX_ANSWER_CHARS = 12_000;
// Turn checks only send the tail of the transcript to Jev.
const TURN_WINDOW_WORDS = 80;
const TURN_WINDOW_CHARS = 1000;

// Retry only on 429/529 or network errors, at most 2 attempts in total.
const MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 400;
const JEV_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Daily cap. Every paid Jev fetch (retries included) is counted through
// increment_usage, which only service_role can execute.
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
// Body parsing with a hard byte limit
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

type NoulAnswer = { type: "noul"; noul: number };
type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};
type ChoiceAnswer = { type: "choice"; choice: string; confidence?: number };
type JevAnswer = NoulAnswer | ScoreAnswer | ChoiceAnswer;

type JevResponse = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

interface TurnCheckState {
  mode: "turn_check";
  question: string;
  answer_so_far: string;
}

interface StarScoreState {
  mode: "star_score";
  question: string;
  answer: string;
}

type JevState = TurnCheckState | StarScoreState;

const TURN_CHECK_QUESTIONS = {
  finished: {
    type: "noul",
    instructions:
      "Has the candidate finished answering `question`, so that `answer_so_far` is a complete response the interviewer can reply to?",
    criteria: {
      true: "The answer is complete and ends at a natural stopping point.",
      false: "The candidate is still mid-answer or mid-thought.",
    },
  },
  mid_sentence: {
    type: "noul",
    instructions: "Does `answer_so_far` end in the middle of a sentence?",
    criteria: {
      true: "The last sentence is cut off or unfinished.",
      false: "The last sentence is complete.",
    },
  },
};

const STAR_4 = ["Missing", "Vague", "Clear", "Specific and vivid"];
const ACTION_4 = ["Missing", "Generic", "Concrete", "Concrete with reasoning"];
const RESULT_4 = ["Missing", "Vague", "Stated", "Measured with numbers or evidence"];
const RELEVANCE_4 = ["Off-topic", "Partly", "Mostly", "Directly"];

const STAR_QUESTIONS = {
  situation: {
    type: "score",
    instructions: "How clearly does `answer` describe the specific situation or context?",
    criteria: STAR_4,
  },
  task: {
    type: "score",
    instructions: "How clearly does `answer` state the candidate's own responsibility or goal?",
    criteria: STAR_4,
  },
  action: {
    type: "score",
    instructions: "How concretely does `answer` describe the steps the candidate personally took?",
    criteria: ACTION_4,
  },
  result: {
    type: "score",
    instructions: "How clearly does `answer` state the outcome?",
    criteria: RESULT_4,
  },
  relevance: {
    type: "score",
    instructions: "How directly does `answer` address `question`?",
    criteria: RELEVANCE_4,
  },
  owns_actions: {
    type: "noul",
    instructions:
      "Does `answer` describe actions the candidate took personally, using 'I' rather than only 'we'?",
    criteria: {
      true: "The candidate describes what they personally did, using 'I'.",
      false: "The candidate only describes what 'we' or the team did, or is unclear.",
    },
  },
  answer_type: {
    type: "choice",
    instructions: "What kind of answer is `answer`?",
    criteria: {
      real_example: "Describes a specific past experience.",
      hypothetical: "Describes what they would do.",
      generic: "General statements with no example.",
      uncertain: "Can't tell.",
    },
  },
};

type JevOutcome =
  | { kind: "ok"; response: JevResponse; latencyMs: number }
  | { kind: "capped" }
  | { kind: "counter_error" }
  | { kind: "upstream_error" };

async function callJev(
  admin: SupabaseClient,
  apiKey: string,
  state: JevState,
  questions: unknown,
): Promise<JevOutcome> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));

    // Count right before every paid fetch, including retries. Never retry
    // past the cap.
    const counted = await countPaidCall(admin);
    if (counted === "capped") return { kind: "capped" };
    if (counted === "error") return { kind: "counter_error" };

    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(JEV_URL, {
        method: "POST",
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
      });
    } catch (err) {
      console.error(`Jev request failed (attempt ${attempt}):`, err);
      // fetch throws TypeError on network errors; timeouts are not retried.
      if (err instanceof TypeError && attempt < MAX_ATTEMPTS) continue;
      return { kind: "upstream_error" };
    }
    const latencyMs = Math.round(performance.now() - started);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Jev HTTP ${res.status} (attempt ${attempt}):`, text.slice(0, 500));
      const retriable = res.status === 429 || res.status === 529;
      if (retriable && attempt < MAX_ATTEMPTS) continue;
      return { kind: "upstream_error" };
    }

    try {
      const body = (await res.json()) as JevResponse;
      if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") {
        console.error("Jev response missing answers");
        return { kind: "upstream_error" };
      }
      console.log("jev response model:", body.model);
      return { kind: "ok", response: body, latencyMs };
    } catch (err) {
      console.error("Jev response was not JSON:", err);
      return { kind: "upstream_error" };
    }
  }
  return { kind: "upstream_error" };
}

function turnWindow(answer: string): string {
  const words = answer.split(/\s+/);
  const tail = words.length > TURN_WINDOW_WORDS ? words.slice(-TURN_WINDOW_WORDS).join(" ") : answer;
  return tail.length > TURN_WINDOW_CHARS ? tail.slice(-TURN_WINDOW_CHARS).trim() : tail;
}

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

    const mode = body.mode ?? "turn_check";
    if (mode !== "turn_check" && mode !== "star_score") {
      return json({ error: "invalid_mode" }, 400);
    }
    const rawQuestion = body.question ?? "";
    const rawAnswer = (mode === "star_score" ? body.answer : body.answer_so_far) ?? "";
    if (typeof rawQuestion !== "string" || typeof rawAnswer !== "string") {
      return json({ error: "invalid_field_type" }, 400);
    }
    const question = rawQuestion.trim();
    const answer = rawAnswer.trim();
    if (!question || !answer) {
      return json({ error: "question and answer are required" }, 400);
    }
    if (question.length > MAX_QUESTION_CHARS || answer.length > MAX_ANSWER_CHARS) {
      return json({ error: "field_too_long" }, 422);
    }

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) {
      return json({ error: "not_configured" }, 503);
    }

    const state: JevState =
      mode === "star_score"
        ? { mode: "star_score", question, answer }
        : { mode: "turn_check", question, answer_so_far: turnWindow(answer) };
    const questions = mode === "star_score" ? STAR_QUESTIONS : TURN_CHECK_QUESTIONS;

    const outcome = await callJev(admin, apiKey, state, questions);
    if (outcome.kind === "capped") {
      return json({ error: "daily_limit", message: "Daily Jev call cap reached." }, 429);
    }
    if (outcome.kind === "counter_error") {
      return json({ error: "usage_counter_unavailable" }, 503);
    }
    if (outcome.kind === "upstream_error") {
      return json({ error: "upstream_error" }, 502);
    }

    const { response, latencyMs } = outcome;
    const usage = {
      input_tokens: Number(response.usage?.input_tokens) || 0,
      output_tokens: Number(response.usage?.output_tokens) || 0,
    };
    const costUsd = usage.input_tokens * COST_PER_INPUT_TOKEN;

    return json({
      answers: response.answers,
      model: response.model,
      usage,
      latency_ms: latencyMs,
      cost_usd: costUsd,
    });
  } catch (err) {
    console.error("jev failed:", err);
    return json({ error: "internal_error" }, 500);
  }
});
