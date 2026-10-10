const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

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

function templatedFeedback(turns: unknown[]): string {
  const answered = turns.filter((t) => (t as { composite?: number }).composite != null) as Array<{
    question: string;
    transcript?: string;
    star?: Record<string, unknown>;
    composite?: number;
    wpm?: number;
    filler_count?: number;
  }>;
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
      const dim = t.star?.[label] as { score?: number } | undefined;
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

function openAiConfig() {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const baseUrl = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-6-luna";
  return { apiKey, baseUrl, model };
}

async function callOpenAi(
  messages: Array<{ role: string; content: string }>,
  maxTokens = 900,
): Promise<string> {
  const { apiKey, baseUrl, model } = openAiConfig();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.7 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("Empty completion");
  return content;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const body = (await req.json()) as {
      mode?: string;
      role?: string;
      seniority?: string;
      interview_type?: string;
      job_description?: string;
      count?: number;
      question?: string;
      answer?: string;
      target_dimension?: string;
      turns?: unknown[];
      mock?: boolean;
    };
    const mode = body.mode ?? "questions";

    if (mode === "questions") {
      if (!body.mock && openAiConfig().apiKey) {
        try {
          const prompt = [
            `You are a senior interviewer. Generate ${body.count ?? 5} interview questions for a ${body.seniority ?? "mid-level"} ${body.role ?? "software engineer"} role.`,
            `Interview type: ${body.interview_type ?? "mixed"}.`,
            body.job_description ? `Job description:\n${body.job_description.slice(0, 2000)}` : "",
            "Return ONLY a JSON array of question strings, no numbering, no commentary.",
          ]
            .filter(Boolean)
            .join("\n");
          const content = await callOpenAi([{ role: "user", content }], 700);
          const match = content.match(/\[[\s\S]*\]/);
          const parsed = match ? JSON.parse(match[0]) : null;
          if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((q) => typeof q === "string")) {
            return new Response(JSON.stringify({ questions: parsed.slice(0, body.count ?? 5), source: "llm" }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          throw new Error("Could not parse questions");
        } catch (err) {
          console.log("question generation fell back to bank:", err instanceof Error ? err.message : err);
        }
      }
      return new Response(
        JSON.stringify({
          questions: pickQuestions(body.interview_type ?? "mixed", body.count ?? 5),
          source: "bank",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (mode === "follow_up") {
      const dim = body.target_dimension ?? "action";
      if (!body.mock && openAiConfig().apiKey) {
        try {
          const prompt = [
            `You are a senior interviewer. The candidate just answered: "${body.question}".`,
            `Their answer: ${(body.answer ?? "").slice(0, 3000)}`,
            `Write ONE short, natural spoken follow-up question that probes the ${dim} part of their story. Keep it under 30 words. Return only the question.`,
          ].join("\n");
          const content = await callOpenAi([{ role: "user", content }], 120);
          return new Response(JSON.stringify({ question: content.trim(), source: "llm" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          console.log("follow-up fell back to template:", err instanceof Error ? err.message : err);
        }
      }
      return new Response(
        JSON.stringify({ question: FOLLOW_UP_TEMPLATES[dim] ?? FOLLOW_UP_TEMPLATES.action, source: "template" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (mode === "feedback") {
      if (!body.mock && openAiConfig().apiKey) {
        try {
          const prompt = [
            "You are an interview coach. Below are the interview turns with STAR scores (0-3 per dimension, composite 0-100).",
            JSON.stringify(body.turns ?? [], null, 1).slice(0, 8000),
            "Write feedback with three labeled sections exactly: 'Strengths:', 'Top 3 improvements:' (three bullets), and 'Stronger answer:' (a rewritten stronger answer for the weakest turn, citing its scores). Be specific and cite the scores.",
          ].join("\n");
          const content = await callOpenAi([{ role: "user", content }], 900);
          return new Response(JSON.stringify({ feedback: content, source: "llm" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (err) {
          console.log("feedback fell back to template:", err instanceof Error ? err.message : err);
        }
      }
      return new Response(
        JSON.stringify({ feedback: templatedFeedback(body.turns ?? []), source: "template" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: `Unknown mode: ${mode}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
