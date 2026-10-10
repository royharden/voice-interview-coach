// Scripted demo replay: a candidate answer fed word by word with realistic
// mid-sentence pauses, driving the real turn-taking loop without a mic.

export interface ReplayScript {
  question: string;
  // tokens: words or pause markers like { pause: 1400 }
  tokens: Array<string | { pause: number }>;
}

export const DEMO_SCRIPTS: ReplayScript[] = [
  {
    question: "Tell me about a time you fixed a critical production bug.",
    tokens: [
      "So", "the", "situation", "was,", "um,", { pause: 1400 },
      "we", "had", "a", "checkout", "bug", "on", "Black", "Friday", "that", "was,", "uh,", { pause: 1200 },
      "losing", "us", "orders", "every", "few", "minutes.", { pause: 900 },
      "I", "was", "the", "on-call", "engineer,", "so", "I", "owned", "the", "response.",
      "First", "I", "checked", "the", "error", "dashboard,", "then", "I", "bisected", "the", "deploys",
      "and", "found", "a", "cart", "service", "change", "from", "the", "night", "before.", { pause: 1000 },
      "I", "rolled", "it", "back", "within", "15", "minutes,", "then", "added", "a", "regression", "test",
      "and", "a", "staging", "checkout", "check.", { pause: 800 },
      "Checkout", "errors", "went", "from", "12%", "to", "0.2%", "and", "we", "recovered",
      "about", "$40k", "in", "orders", "that", "night.",
    ],
  },
  {
    question: "Describe a time you had to learn something new quickly under deadline pressure.",
    tokens: [
      "Yeah,", "um,", { pause: 1300 },
      "so,", "my", "team", "needed", "a", "dashboard", "in", "React,", "and", "I", "had",
      "only", "written", "backend", "code", "before.", { pause: 1000 },
      "I", "took", "a", "two-day", "course,", "paired", "with", "a", "frontend", "engineer,",
      "and", "shipped", "the", "dashboard", "on", "time.", { pause: 800 },
      "It", "was", "used", "by", "the", "whole", "support", "team", "after", "that,",
      "and", "they", "cut", "their", "reporting", "time", "in", "half.",
    ],
  },
];

export function scriptToWords(script: ReplayScript): string {
  return script.tokens
    .map((t) => (typeof t === "string" ? t : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
