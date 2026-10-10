import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  PolarAngleAxis,
  PolarGrid,
  Radar as RadarShape,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { Flag, Send, SlidersHorizontal, Volume2 } from "lucide-react";
import { Orb, Chip, TypedBadge, type OrbPhase } from "@/components/Orb";
import { EndOfTurnChart } from "@/components/EndOfTurnChart";
import { StarBars } from "@/components/StarBars";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useTts } from "@/hooks/useTts";
import { useInterview } from "@/hooks/useInterview";
import { DEMO_SCRIPTS } from "@/lib/demoScripts";
import type { SessionConfig, TurnState } from "@/lib/types";

export function InterviewRoom({
  config,
  demoScript,
  onExit,
}: {
  config: SessionConfig;
  demoScript: number | null;
  onExit: () => void;
}) {
  const interview = useInterview(config);
  const stt = useSpeechRecognition();
  const tts = useTts();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [minPause, setMinPause] = useState(config.settings.minPauseMs);
  const [maxPause, setMaxPause] = useState(config.settings.maxPauseMs);
  const [threshold, setThreshold] = useState(config.settings.threshold);
  const [voiceUri, setVoiceUri] = useState<string>("");
  const [rate, setRate] = useState(1);
  const [orbPhase, setOrbPhase] = useState<OrbPhase>("idle");
  const demoActiveRef = useRef(false);

  const settings = useMemo(
    () => ({ ...config.settings, minPauseMs: minPause, maxPauseMs: maxPause, threshold }),
    [config.settings, minPause, maxPause, threshold],
  );
  // keep the live policy in sync with the drawer
  config.settings.minPauseMs = minPause;
  config.settings.maxPauseMs = maxPause;
  config.settings.threshold = threshold;

  const useTypedMode = !stt.supported;

  // ------------------------------------------------------------------
  // Orb phase
  // ------------------------------------------------------------------
  useEffect(() => {
    if (interview.phase === "asking") setOrbPhase("speaking");
    else if (interview.phase === "answering") setOrbPhase(demoActiveRef.current ? "thinking" : "listening");
    else if (interview.phase === "scoring") setOrbPhase("thinking");
    else setOrbPhase("idle");
  }, [interview.phase]);

  // ------------------------------------------------------------------
  // Speak the question, then listen
  // ------------------------------------------------------------------
  const spokenForRef = useRef<number>(-1);
  useEffect(() => {
    const turn = interview.currentTurn;
    if (!turn || spokenForRef.current === turn.idx) return;
    spokenForRef.current = turn.idx;
    (async () => {
      await tts.speak(turn.question, {
        engine: config.voice,
        voiceUri: voiceUri || undefined,
        rate,
      });
      if (demoScript != null) {
        runDemoReplay(turn);
      } else {
        if (!useTypedMode) stt.start();
        interview.startListening();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interview.currentTurn]);

  useEffect(() => {
    if (!tts.speaking && !useTypedMode && interview.phase === "answering" && demoScript == null && !stt.listening) {
      stt.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tts.speaking]);

  // Pause recognition while the coach speaks.
  useEffect(() => {
    if (tts.speaking && stt.listening) stt.stop();
  }, [tts.speaking, stt]);

  // Feed interim text into the interview loop.
  useEffect(() => {
    interview.notifyTranscript();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stt.interimTranscript, stt.finalTranscript]);

  // ------------------------------------------------------------------
  // Manual end: Done button + spacebar
  // ------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && interview.phase === "answering") {
        const target = e.target as HTMLElement;
        if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") return;
        e.preventDefault();
        interview.endTurnManual();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [interview.phase, interview.endTurnManual]);

  // Stop mic when turn ends.
  useEffect(() => {
    if (interview.phase === "scoring" || interview.phase === "report") stt.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interview.phase]);

  // ------------------------------------------------------------------
  // Demo replay: feed a scripted answer through the real loop
  // ------------------------------------------------------------------
  function runDemoReplay(turn: TurnState) {
    if (demoScript == null) return;
    const script = DEMO_SCRIPTS[demoScript];
    if (!script || script.question !== turn.question) {
      // fallback: still run the loop with whatever the script has
    }
    const active = DEMO_SCRIPTS.find((s) => s.question === turn.question) ?? script;
    demoActiveRef.current = true;
    interview.startListening();
    let i = 0;
    const step = () => {
      if (!demoActiveRef.current) return;
      if (i >= active.tokens.length) {
        demoActiveRef.current = false;
        interview.endTurnManual();
        return;
      }
      const token = active.tokens[i++];
      if (typeof token === "string") {
        interview.feedDemoToken(token);
        setTimeout(step, 260 + Math.random() * 160);
      } else {
        setTimeout(step, token.pause);
      }
    };
    setTimeout(step, 400);
    void turn;
  }

  // ------------------------------------------------------------------
  // Submit typed answer
  // ------------------------------------------------------------------
  function submitTyped() {
    const base = interview.currentTurn;
    if (!base) return;
    base.transcript = typed.trim();
    setTyped("");
    interview.endTurnManual();
  }

  // ------------------------------------------------------------------
  // Derived UI state
  // ------------------------------------------------------------------
  const lastAnswered = [...interview.turns].reverse().find((t) => t.transcript);
  const showPerAnswer = lastAnswered && interview.phase === "asking";
  const lastType = lastAnswered?.star?.answerType?.choice;

  if (interview.phase === "report" && interview.report) {
    return <ReportView report={interview.report} onExit={onExit} />;
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 grid lg:grid-cols-[1fr_320px] gap-6">
      {/* Main column */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>{config.role}</span>
            <span>·</span>
            <span>{config.seniority}</span>
            <span>·</span>
            <span className="capitalize">{config.interviewType}</span>
            {config.interviewerMode === "mock" && <Chip>mock interviewer</Chip>}
            {interview.engine === "heuristic" && <Chip tone="amber">Heuristic (not Jev)</Chip>}
          </div>
          <button
            type="button"
            onClick={() => {
              demoActiveRef.current = false;
              tts.cancel();
              stt.stop();
              interview.endInterviewNow();
            }}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            End & report
          </button>
        </div>

        <div className="flex flex-col items-center gap-5 bg-slate-900/50 border border-slate-800 rounded-2xl p-8">
          <Orb phase={orbPhase} />
          <AnimatePresence mode="wait">
            <motion.p
              key={interview.currentTurn?.question ?? "none"}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="text-lg sm:text-xl text-slate-100 text-center leading-relaxed max-w-lg"
            >
              {interview.currentTurn?.question ?? "…"}
            </motion.p>
          </AnimatePresence>
          {interview.lastCheckLatency != null && (
            <p className="text-xs text-slate-500">last Jev check: {interview.lastCheckLatency} ms</p>
          )}
        </div>

        {/* Live transcript */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-2xl p-5 min-h-28">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-slate-300">Your answer</h3>
            {useTypedMode && <TypedBadge />}
          </div>
          {useTypedMode ? (
            <div className="flex gap-2">
              <textarea
                className="input h-20 resize-none"
                placeholder="Type your answer…"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitTyped();
                }}
              />
              <button
                type="button"
                onClick={submitTyped}
                disabled={interview.phase !== "answering" || !typed.trim()}
                className="self-end rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 px-4 py-2 text-sm font-semibold transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <p className="text-slate-300 leading-relaxed">
              {(interview.currentTurn?.transcript ?? "") && (
                <span>{interview.currentTurn?.transcript} </span>
              )}
              {stt.interimTranscript && <span className="text-slate-500">{stt.interimTranscript}</span>}
              {!interview.currentTurn?.transcript && !stt.interimTranscript && (
                <span className="text-slate-600">
                  {interview.phase === "answering" ? "Listening…" : "Waiting for the question…"}
                </span>
              )}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={interview.endTurnManual}
              disabled={interview.phase !== "answering"}
              className="rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 border border-slate-700 text-slate-200 text-sm font-medium px-4 py-1.5 transition-colors"
            >
              <Flag className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              Done <span className="text-slate-500 text-xs">(space)</span>
            </button>
          </div>
        </div>

        {/* Per-answer card */}
        <AnimatePresence>
          {showPerAnswer && (
            <motion.div
              key={lastAnswered.idx}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-200">Last answer scored</h3>
                <div className="flex items-center gap-2">
                  {lastType && (
                    <Chip tone={lastType === "real_example" ? "emerald" : "amber"}>
                      {lastType.replace("_", " ")}
                    </Chip>
                  )}
                </div>
              </div>
              <StarBars star={lastAnswered.star ?? {}} />
              <div className="flex flex-wrap gap-4 text-xs text-slate-400">
                <span>composite: <b className="text-slate-200">{lastAnswered.composite?.toFixed(0) ?? "—"}</b>/100</span>
                <span>wpm: {lastAnswered.wpm ?? "—"}</span>
                <span>fillers: {lastAnswered.fillerCount ?? "—"}</span>
                <span>ended: {lastAnswered.endReason ?? "—"}</span>
              </div>
              {lastAnswered.targetDimension && (
                <p className="text-xs text-slate-400">
                  follow-up asked, targeting <b className="text-slate-200">{lastAnswered.targetDimension}</b>
                </p>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Side column */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setDrawerOpen((v) => !v)}
          className="w-full flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 text-sm py-2.5 transition-colors lg:hidden"
        >
          <SlidersHorizontal className="w-4 h-4" /> Tuning drawer
        </button>

        <div className={`${drawerOpen ? "block" : "hidden"} lg:block space-y-4`}>
          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-medium text-slate-200 flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-slate-400" /> Turn-taking
            </h3>
            <RangeRow label={`min pause: ${minPause} ms`} min={300} max={2000} step={50} value={minPause} onChange={setMinPause} />
            <RangeRow label={`max silence: ${maxPause} ms`} min={2000} max={10000} step={250} value={maxPause} onChange={setMaxPause} />
            <RangeRow label={`threshold: ${threshold.toFixed(2)}`} min={0.3} max={0.95} step={0.05} value={threshold} onChange={setThreshold} />
          </div>

          <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5 space-y-4">
            <h3 className="text-sm font-medium text-slate-200 flex items-center gap-2">
              <Volume2 className="w-4 h-4 text-slate-400" /> Voice
            </h3>
            <select className="input" value={voiceUri} onChange={(e) => setVoiceUri(e.target.value)}>
              <option value="">Default browser voice</option>
              {tts.voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            <RangeRow label={`rate: ${rate.toFixed(1)}x`} min={0.6} max={1.6} step={0.1} value={rate} onChange={setRate} />
          </div>
        </div>

        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
          <EndOfTurnChart checks={interview.checks} threshold={threshold} />
        </div>
      </div>
    </div>
  );
}

function RangeRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 mb-1 block">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-sky-500"
      />
    </label>
  );
}

// ------------------------------------------------------------------
// Report
// ------------------------------------------------------------------
function ReportView({
  report,
  onExit,
}: {
  report: {
    overallScore: number | null;
    feedback: { feedback: string; source: string } | null;
    turns: TurnState[];
    interruptionsAvoided: number;
    jevCostUsd: number;
  };
  onExit: () => void;
}) {
  const [llmCostPerQuestion, setLlmCostPerQuestion] = useState(0.01);
  const radarData = useMemo(() => {
    const dims = ["situation", "task", "action", "result", "relevance"] as const;
    const sums: Record<string, { total: number; n: number }> = {};
    for (const t of report.turns) {
      for (const d of dims) {
        const s = t.star?.[d]?.score;
        if (s != null) {
          sums[d] = sums[d] ?? { total: 0, n: 0 };
          sums[d].total += s;
          sums[d].n += 1;
        }
      }
    }
    return dims.map((d) => ({
      dimension: d.charAt(0).toUpperCase() + d.slice(1),
      score: sums[d] ? Math.round((sums[d].total / sums[d].n) * 33.3) : 0,
    }));
  }, [report.turns]);

  const answered = report.turns.filter((t) => t.transcript);

  return (
    <div className="max-w-3xl mx-auto px-4 py-10 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-100">Session report</h1>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-sm font-semibold px-4 py-2 transition-colors"
        >
          New interview
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <StatCard label="Overall score" value={report.overallScore != null ? `${report.overallScore}/100` : "—"} />
        <StatCard label="Interruptions avoided" value={String(report.interruptionsAvoided)} />
        <StatCard label="Jev cost" value={`$${report.jevCostUsd.toFixed(5)}`} />
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
        <h2 className="text-sm font-medium text-slate-200 mb-4">STAR profile</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} outerRadius="75%">
              <PolarGrid stroke="#1e293b" />
              <PolarAngleAxis dataKey="dimension" tick={{ fill: "#94a3b8", fontSize: 12 }} />
              <RadarShape dataKey="score" stroke="#0ea5e9" fill="#0ea5e9" fillOpacity={0.35} />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {report.feedback && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-medium text-slate-200">Coach feedback</h2>
            <Chip tone={report.feedback.source === "llm" ? "sky" : "slate"}>
              {report.feedback.source === "llm" ? "LLM" : "template"}
            </Chip>
          </div>
          <div className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">
            {report.feedback.feedback}
          </div>
        </div>
      )}

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h2 className="text-sm font-medium text-slate-200">Scored transcript</h2>
        {answered.map((t) => (
          <div key={t.idx} className="border-t border-slate-800 pt-4 first:border-0 first:pt-0">
            <div className="flex items-start justify-between gap-3 mb-2">
              <p className="text-sm text-sky-300">{t.question}</p>
              {t.composite != null && <Chip tone="slate">{t.composite.toFixed(0)}/100</Chip>}
            </div>
            <p className="text-sm text-slate-400 leading-relaxed">{t.transcript}</p>
            {t.star && <div className="mt-3"><StarBars star={t.star} /></div>}
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
              <span>wpm: {t.wpm ?? "—"}</span>
              <span>fillers: {t.fillerCount ?? "—"}</span>
              <span>ended: {t.endReason ?? "—"}</span>
              {t.targetDimension && <span>follow-up: {t.targetDimension}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6">
        <h2 className="text-sm font-medium text-slate-200 mb-2">Jev vs LLM-judge cost</h2>
        <label className="text-xs text-slate-400 block mb-2">
          Estimated LLM-judge cost per question: ${llmCostPerQuestion.toFixed(3)}
          <input
            type="range"
            min={0.001}
            max={0.05}
            step={0.001}
            value={llmCostPerQuestion}
            onChange={(e) => setLlmCostPerQuestion(Number(e.target.value))}
            className="w-full accent-sky-500 mt-2"
          />
        </label>
        <p className="text-sm text-slate-300">
          This session: <b>${report.jevCostUsd.toFixed(5)}</b> with Jev vs{" "}
          <b>${(answered.length * llmCostPerQuestion).toFixed(4)}</b> with a typical LLM judge.
        </p>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="text-2xl font-semibold text-slate-100 tabular-nums">{value}</div>
    </div>
  );
}

// re-export for typing convenience
export type { SessionConfig };
