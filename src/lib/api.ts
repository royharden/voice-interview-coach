import type {
  FeedbackResult,
  FollowUpResult,
  InterviewQuestionsResult,
  JevCheckResult,
  StarResult,
} from "./types";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

function fnHeaders(): HeadersInit {
  return {
    Authorization: `Bearer ${anonKey}`,
    "Content-Type": "application/json",
  };
}

async function postJson<T>(fn: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${url}/functions/v1/${fn}`, {
    method: "POST",
    headers: fnHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = typeof j?.error === "string" ? j.error : "";
    } catch {
      // ignore body parse errors
    }
    throw new Error(`${fn} failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
  const json = await res.json();
  return json as T;
}

export async function jevTurnCheck(
  question: string,
  answerSoFar: string,
  signal?: AbortSignal,
): Promise<JevCheckResult> {
  return postJson<JevCheckResult>("jev", { mode: "turn_check", question, answer_so_far: answerSoFar }, signal);
}

export interface JevStarRaw {
  answers: Record<string, unknown>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

export async function jevScore(question: string, answer: string): Promise<JevStarRaw> {
  return postJson<JevStarRaw>("jev", { mode: "star_score", question, answer });
}

export async function generateQuestions(opts: {
  role: string;
  seniority: string;
  interviewType: string;
  jobDescription: string;
  count: number;
  mock: boolean;
}): Promise<InterviewQuestionsResult> {
  return postJson<InterviewQuestionsResult>("interviewer", { mode: "questions", ...opts });
}

export async function generateFollowUp(opts: {
  question: string;
  answer: string;
  targetDimension: string;
  mock: boolean;
}): Promise<FollowUpResult> {
  return postJson<FollowUpResult>("interviewer", {
    mode: "follow_up",
    question: opts.question,
    answer: opts.answer,
    target_dimension: opts.targetDimension,
    mock: opts.mock,
  });
}

export async function generateFeedback(opts: {
  turns: unknown[];
  mock: boolean;
}): Promise<FeedbackResult> {
  return postJson<FeedbackResult>("interviewer", { mode: "feedback", turns: opts.turns, mock: opts.mock });
}

export async function openAiTts(text: string): Promise<ArrayBuffer> {
  const res = await fetch(`${url}/functions/v1/tts`, {
    method: "POST",
    headers: fnHeaders(),
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`tts failed (${res.status})`);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// Score parsing: Jev StarScore -> StarResult
// ---------------------------------------------------------------------------

function parseScoreAnswer(raw: unknown): { score: number; confidence?: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { type?: string; score?: number; confidence?: number };
  if (r.type !== "score" || typeof r.score !== "number") return undefined;
  const out: { score: number; confidence?: number } = { score: r.score };
  if (typeof r.confidence === "number") out.confidence = r.confidence;
  return out;
}

function parseNoul(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { type?: string; noul?: number };
  if (r.type === "noul" && typeof r.noul === "number") return r.noul;
  return undefined;
}

export function parseStar(raw: JevStarRaw): StarResult {
  const a = raw.answers ?? {};
  const result: StarResult = { raw };
  const situation = parseScoreAnswer(a.situation);
  if (situation) result.situation = situation;
  const task = parseScoreAnswer(a.task);
  if (task) result.task = task;
  const action = parseScoreAnswer(a.action);
  if (action) result.action = action;
  const result_ = parseScoreAnswer(a.result);
  if (result_) result.result = result_;
  const relevance = parseScoreAnswer(a.relevance);
  if (relevance) result.relevance = relevance;
  const owns = parseNoul(a.owns_actions);
  if (owns != null) result.ownsActions = { noul: owns };
  const at = a.answer_type;
  if (at && typeof at === "object") {
    const r = at as { type?: string; choice?: string; confidence?: number };
    if (r.type === "choice" && typeof r.choice === "string") {
      result.answerType = { choice: r.choice, confidence: r.confidence };
    }
  }
  return result;
}

export function isHeuristicStar(star: StarResult | undefined): boolean {
  return star == null || star.situation == null;
}
