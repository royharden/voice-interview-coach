import { useState } from "react";
import { motion } from "framer-motion";
import { Briefcase, Brain, MessageSquareText, Sparkles } from "lucide-react";
import { DEFAULT_SETTINGS, type SessionConfig } from "@/lib/types";

export function SetupScreen({
  onStart,
  onDemo,
}: {
  onStart: (config: SessionConfig) => void;
  onDemo: (config: SessionConfig, scriptIndex: number) => void;
}) {
  const [role, setRole] = useState("Software Engineer");
  const [seniority, setSeniority] = useState("Mid-level");
  const [interviewType, setInterviewType] = useState("behavioral");
  const [questionCount, setQuestionCount] = useState(4);
  const [jobDescription, setJobDescription] = useState("");
  const [interviewerMode, setInterviewerMode] = useState<"live" | "mock">("live");
  const [voice, setVoice] = useState<"browser" | "openai">("browser");
  const [demoIndex, setDemoIndex] = useState(0);

  const buildConfig = (): SessionConfig => ({
    role,
    seniority,
    interviewType,
    jobDescription: jobDescription.trim(),
    questionCount,
    interviewerMode,
    voice,
    settings: { ...DEFAULT_SETTINGS },
  });

  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-sky-400" />
          </div>
          <h1 className="text-3xl font-semibold text-slate-100">Voice Interview Coach</h1>
        </div>
        <p className="text-slate-400 leading-relaxed mb-8">
          A mock interviewer that speaks its questions, listens to your spoken answers, and uses a
          semantic end-of-turn model so it never cuts you off mid-thought. Your answers are scored
          on the STAR rubric with one follow-up and a final report.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
        className="space-y-5 bg-slate-900/60 border border-slate-800 rounded-2xl p-6"
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Role" icon={<Briefcase className="w-4 h-4" />}>
            <input
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Frontend Engineer"
            />
          </Field>
          <Field label="Seniority" icon={<Brain className="w-4 h-4" />}>
            <select className="input" value={seniority} onChange={(e) => setSeniority(e.target.value)}>
              {["Intern", "Junior", "Mid-level", "Senior", "Staff", "Lead"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Interview type">
          <div className="grid grid-cols-3 gap-2">
            {["behavioral", "technical", "mixed"].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setInterviewType(t)}
                className={`rounded-lg px-3 py-2 text-sm capitalize border transition-colors ${
                  interviewType === t
                    ? "bg-sky-500/15 border-sky-500/50 text-sky-300"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid sm:grid-cols-2 gap-4">
          <Field label={`Questions: ${questionCount}`}>
            <input
              type="range"
              min={3}
              max={8}
              value={questionCount}
              onChange={(e) => setQuestionCount(Number(e.target.value))}
              className="w-full accent-sky-500"
            />
          </Field>
          <Field label="Voice">
            <select className="input" value={voice} onChange={(e) => setVoice(e.target.value as "browser" | "openai")}>
              <option value="browser">Browser voice</option>
              <option value="openai">OpenAI voice (if configured)</option>
            </select>
          </Field>
        </div>

        <Field label="Interviewer" icon={<MessageSquareText className="w-4 h-4" />}>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { v: "live", label: "Live interviewer (LLM)", hint: "Needs an API key" },
                { v: "mock", label: "Mock interviewer", hint: "Question bank, Jev still live" },
              ] as const
            ).map(({ v, label, hint }) => (
              <button
                key={v}
                type="button"
                onClick={() => setInterviewerMode(v)}
                className={`rounded-lg px-3 py-2 text-left text-sm border transition-colors ${
                  interviewerMode === v
                    ? "bg-sky-500/15 border-sky-500/50 text-sky-300"
                    : "bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600"
                }`}
              >
                <div className="font-medium">{label}</div>
                <div className="text-xs text-slate-500">{hint}</div>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Job description (optional)">
          <textarea
            className="input h-24 resize-none"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value)}
            placeholder="Paste the job posting to tailor the questions…"
          />
        </Field>

        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <button
            type="button"
            onClick={() => onStart(buildConfig())}
            className="flex-1 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold px-5 py-3 transition-colors"
          >
            Start interview
          </button>
          <div className="flex-1 rounded-xl border border-slate-700 bg-slate-900 p-2">
            <div className="flex items-center gap-2">
              <select
                className="bg-transparent text-xs text-slate-400 flex-1 outline-none"
                value={demoIndex}
                onChange={(e) => setDemoIndex(Number(e.target.value))}
              >
                <option value={0}>Demo replay: checkout bug</option>
                <option value={1}>Demo replay: learning fast</option>
              </select>
              <button
                type="button"
                onClick={() => onDemo(buildConfig(), demoIndex)}
                className="rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium px-4 py-2 transition-colors"
              >
                Watch demo
              </button>
            </div>
          </div>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed">
          Speech recognition uses your browser's built-in engine (Chrome recommended — Chrome may
          process audio on Google's servers). This app itself only stores and sends text. Firefox
          users get a typed-input mode with the same flow.
        </p>
      </motion.div>
    </div>
  );
}

function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400 mb-1.5">
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}
