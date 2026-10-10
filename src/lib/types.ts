export type TurnKind = "question" | "follow_up";

export type EndReason = "jev" | "max_silence" | "manual";

export type CheckDecision = "keep_listening" | "end_turn" | "stale" | "aborted";

export interface TurnCheck {
  tMs: number;
  words: number;
  finishedP: number;
  midSentenceP: number;
  endProb: number;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: number | null;
  decision: CheckDecision;
}

export interface StarDimension {
  score: number;
  confidence?: number;
}

export interface StarResult {
  situation?: StarDimension;
  task?: StarDimension;
  action?: StarDimension;
  result?: StarDimension;
  relevance?: StarDimension;
  ownsActions?: { noul: number };
  answerType?: { choice: string; confidence?: number };
  raw?: unknown;
}

export interface TurnState {
  id?: string;
  idx: number;
  kind: TurnKind;
  question: string;
  transcript: string;
  startedAt: number;
  endedAt?: number;
  endReason?: EndReason;
  durationMs?: number;
  wpm?: number;
  fillerCount?: number;
  star?: StarResult;
  composite?: number;
  targetDimension?: string | null;
}

export interface SessionSettings {
  minPauseMs: number;
  maxPauseMs: number;
  threshold: number;
  weights: { situation: number; task: number; action: number; result: number };
}

export interface SessionConfig {
  role: string;
  seniority: string;
  interviewType: string;
  jobDescription: string;
  questionCount: number;
  interviewerMode: "live" | "mock";
  voice: "browser" | "openai";
  settings: SessionSettings;
}

export interface JevCheckResult {
  answers: { finished?: { noul: number }; mid_sentence?: { noul: number } };
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

export interface InterviewQuestionsResult {
  questions: string[];
  source: "llm" | "bank" | "template";
}

export interface FollowUpResult {
  question: string;
  source: "llm" | "template";
}

export interface FeedbackResult {
  feedback: string;
  source: "llm" | "template";
}

export const DEFAULT_SETTINGS: SessionSettings = {
  minPauseMs: 700,
  maxPauseMs: 4000,
  threshold: 0.75,
  weights: { situation: 0.15, task: 0.15, action: 0.35, result: 0.35 },
};

export const FILLER_WORDS = ["um", "uh", "like", "you know"];
