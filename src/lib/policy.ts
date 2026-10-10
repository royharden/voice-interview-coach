import {
  FILLER_WORDS,
  type CheckDecision,
  type SessionSettings,
  type StarResult,
  type TurnCheck,
  type TurnState,
} from "./types";

export interface TurnPolicyInput {
  wordsSoFar: number;
  silenceMs: number;
  inFlight: boolean;
  sinceLastCheck: number;
}

export interface TurnPolicyAction {
  action: "wait" | "send_check" | "end_turn";
  reason?: "max_silence" | "already_resolved";
  endReason?: "jev" | "max_silence" | "manual";
}

/**
 * Pure turn-taking decision. Returns one of:
 * - send_check: silence >= minPauseMs and no in-flight check
 * - end_turn: max-silence safety net fired
 * - wait: keep listening
 */
export function decideTurn(
  input: TurnPolicyInput,
  settings: Pick<SessionSettings, "minPauseMs" | "maxPauseMs">,
): TurnPolicyAction {
  const silence = input.silenceMs;

  // Safety net: hard silence cap ends the turn regardless of Jev.
  if (silence >= settings.maxPauseMs) {
    return { action: "end_turn", reason: "max_silence", endReason: "max_silence" };
  }

  // An answer under 5 words never auto-ends.
  if (input.wordsSoFar < 5) return { action: "wait" };

  if (input.inFlight) return { action: "wait" };

  // Rate-limit checks while silence keeps growing.
  if (input.sinceLastCheck < settings.minPauseMs) return { action: "wait" };

  if (silence >= settings.minPauseMs) {
    return { action: "send_check" };
  }

  return { action: "wait" };
}

export function computeEndProb(finishedP: number, midSentenceP: number): number {
  return finishedP * (1 - midSentenceP);
}

export function shouldEndTurn(endProb: number, threshold: number): boolean {
  return endProb >= threshold;
}

const FILLER_SET = new Set<string>(["um", "uh", "uhh", "umm", "erm"]);
const LIKE_SET = new Set<string>(["like"]);
const YOU_KNOW = ["you know"];

export function countFillers(text: string): number {
  const lower = text.toLowerCase();
  let count = 0;
  const tokens = lower.split(/[^a-z']+/).filter(Boolean);
  for (const t of tokens) {
    if (FILLER_SET.has(t) || LIKE_SET.has(t)) count++;
  }
  for (const phrase of YOU_KNOW) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      count++;
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
  }
  return count;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function computeWpm(transcript: string, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const words = countWords(transcript);
  return Math.round((words / (durationMs / 1000)) * 60);
}

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

export interface CompositeResult {
  composite: number | null;
  relevanceMultiplier: number;
}

export function computeComposite(
  star: StarResult,
  weights: SessionSettings["weights"],
): CompositeResult {
  const dims: Array<["situation" | "task" | "action" | "result", StarDimensionLike | undefined]> = [
    ["situation", star.situation],
    ["task", star.task],
    ["action", star.action],
    ["result", star.result],
  ];

  let weighted = 0;
  let weightSum = 0;
  for (const [name, dim] of dims) {
    if (!dim || dim.score == null) continue;
    weighted += dim.score * weights[name];
    weightSum += weights[name];
  }
  if (weightSum === 0) return { composite: null, relevanceMultiplier: 1 };

  const relevanceScore = star.relevance?.score;
  // relevance (0..3) -> multiplier in [0.5, 1.0]
  const relevanceMultiplier =
    relevanceScore != null ? 0.5 + relevanceScore / 6 : 1;

  const normalized = (weighted / weightSum) * (100 / 3);
  return {
    composite: Math.max(0, Math.min(100, normalized * relevanceMultiplier)),
    relevanceMultiplier,
  };
}

interface StarDimensionLike {
  score: number;
  confidence?: number;
}

export function confidenceFromScore(dim: StarDimensionLike | undefined): number | undefined {
  if (!dim) return undefined;
  if (dim.confidence != null) return dim.confidence;
  // Compute |2p - 1| from probabilities when the API omits confidence.
  return dim.confidence;
}

export function needsFollowUp(
  star: StarResult,
  answerTypeConfidence: number | undefined,
  hasFollowUp: boolean,
): string | null {
  if (hasFollowUp) return null;
  const dims: Array<["situation" | "task" | "action" | "result", number | undefined]> = [
    ["situation", star.situation?.score],
    ["task", star.task?.score],
    ["action", star.action?.score],
    ["result", star.result?.score],
  ];
  const weakest = dims
    .filter(([, s]) => s != null)
    .sort((a, b) => (a[1] as number) - (b[1] as number))[0];

  const type = star.answerType?.choice;
  const typeFails = type !== undefined && type !== "real_example" && (answerTypeConfidence ?? 0) >= 0.6;

  if (weakest && (weakest[1] as number) < 1.5) return weakest[0];
  if (typeFails) return weakest ? weakest[0] : "action";
  return null;
}

export function finalizeTurnMetrics(turn: TurnState): TurnState {
  const durationMs = turn.durationMs ?? (turn.endedAt ? turn.endedAt - turn.startedAt : 0);
  return {
    ...turn,
    durationMs,
    wpm: computeWpm(turn.transcript, durationMs),
    fillerCount: countFillers(turn.transcript),
  };
}

export function summarizeChecks(checks: TurnCheck[]): {
  interruptionsAvoided: number;
  totalCostUsd: number;
  totalTokens: number;
} {
  let interruptionsAvoided = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;
  for (const c of checks) {
    if (c.decision === "keep_listening") interruptionsAvoided++;
    totalCostUsd += c.costUsd ?? 0;
    totalTokens += c.inputTokens ?? 0;
  }
  return { interruptionsAvoided, totalCostUsd, totalTokens };
}

export { FILLER_WORDS };
