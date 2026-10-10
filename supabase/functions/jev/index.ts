import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MODEL = "jev-1.13.0";
const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000; // output tokens are free

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

async function callJev(
  state: JevState,
  questions: unknown,
  retries: number,
  signal?: AbortSignal,
): Promise<{ response: JevResponse; latencyMs: number }> {
  const apiKey = Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not configured");

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = 400 * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
    const started = performance.now();
    try {
      const res = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
      });
      const latencyMs = Math.round(performance.now() - started);
      if (!res.ok) {
        const text = await res.text();
        const retriable = res.status === 429 || res.status === 529;
        if (retriable && attempt < retries) {
          lastErr = new Error(`Jev HTTP ${res.status}`);
          continue;
        }
        throw new Error(`Jev HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as JevResponse;
      if (!json || !json.answers) {
        throw new Error("Jev response missing answers");
      }
      console.log("jev response model:", json.model);
      return { response: json, latencyMs };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr.message;
      if (!(msg.includes("HTTP 429") || msg.includes("HTTP 529")) || attempt >= retries) {
        throw lastErr;
      }
    }
  }
  throw lastErr ?? new Error("Jev call failed");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as {
      mode?: string;
      question?: string;
      answer_so_far?: string;
      answer?: string;
      retries?: number;
    };
    const mode = body.mode === "star_score" ? "star_score" : "turn_check";
    const question = (body.question ?? "").trim();
    const rawAnswer = mode === "star_score" ? (body.answer ?? "") : (body.answer_so_far ?? "");
    const answer = rawAnswer.trim();
    if (!question || !answer) {
      return new Response(JSON.stringify({ error: "question and answer are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let state: JevState;
    let questions: unknown;
    let retries: number;
    if (mode === "star_score") {
      state = { mode: "star_score", question, answer };
      questions = STAR_QUESTIONS;
      retries = Math.min(Math.max(body.retries ?? 3, 0), 5);
    } else {
      // Keep the window tiny: last ~80 words of the transcript.
      const words = answer.split(/\s+/);
      const window = words.length > 80 ? words.slice(-80).join(" ") : answer;
      state = { mode: "turn_check", question, answer_so_far: window };
      questions = TURN_CHECK_QUESTIONS;
      retries = Math.min(Math.max(body.retries ?? 2, 0), 5);
    }

    const { response, latencyMs } = await callJev(state, questions, retries);
    const inputTokens = response.usage?.input_tokens ?? 0;
    const costUsd = inputTokens * COST_PER_INPUT_TOKEN;

    return new Response(
      JSON.stringify({
        answers: response.answers,
        model: response.model,
        usage: response.usage,
        latency_ms: latencyMs,
        cost_usd: costUsd,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
