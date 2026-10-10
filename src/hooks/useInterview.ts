import { useCallback, useEffect, useRef, useState } from "react";
import {
  generateFeedback,
  generateFollowUp,
  generateQuestions,
  jevScore,
  jevTurnCheck,
  parseStar,
} from "@/lib/api";
import {
  computeComposite,
  computeEndProb,
  decideTurn,
  finalizeTurnMetrics,
  needsFollowUp,
  shouldEndTurn,
  summarizeChecks,
} from "@/lib/policy";
import { heuristicShouldEnd, heuristicStar } from "@/lib/heuristic";
import { supabase } from "@/lib/supabaseClient";
import {
  type FeedbackResult,
  type SessionConfig,
  type TurnCheck,
  type TurnState,
} from "@/lib/types";

export type RoomPhase = "asking" | "answering" | "scoring" | "report";

export interface ReportData {
  overallScore: number | null;
  feedback: FeedbackResult | null;
  turns: TurnState[];
  interruptionsAvoided: number;
  jevCostUsd: number;
}

const TICK_MS = 120;

export function useInterview(config: SessionConfig) {
  const [phase, setPhase] = useState<RoomPhase>("asking");
  const [turns, setTurns] = useState<TurnState[]>([]);
  const [currentTurn, setCurrentTurn] = useState<TurnState | null>(null);
  const [checks, setChecks] = useState<TurnCheck[]>([]);
  const [lastCheckLatency, setLastCheckLatency] = useState<number | null>(null);
  const [engine, setEngine] = useState<"jev" | "heuristic">("jev");
  const [report, setReport] = useState<ReportData | null>(null);

  const currentTurnRef = useRef<TurnState | null>(null);
  const turnIdxRef = useRef(0);
  const askedCountRef = useRef(0);
  const checksRef = useRef<TurnCheck[]>([]);
  const turnsRef = useRef<TurnState[]>([]);
  const lastChangeRef = useRef(Date.now());
  const interimRef = useRef("");
  const lastCheckAtRef = useRef(0);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const finishedRef = useRef(false);
  const endingRef = useRef(false);
  const engineRef = useRef<"jev" | "heuristic">("jev");
  const phaseRef = useRef<RoomPhase>("asking");
  const configRef = useRef(config);
  const sessionIdRef = useRef<string | null>(null);
  const followUpForRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  useEffect(() => {
    checksRef.current = checks;
  }, [checks]);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("sessions")
        .insert({
          role: config.role,
          seniority: config.seniority,
          interview_type: config.interviewType,
          job_description: config.jobDescription || null,
          settings: config.settings,
          interviewer_mode: config.interviewerMode,
        })
        .select("id")
        .maybeSingle();
      if (error) console.error("session insert failed:", error.message);
      else if (data) sessionIdRef.current = data.id;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const transcriptSoFar = useCallback((): string => {
    const base = currentTurnRef.current;
    if (!base) return "";
    return (base.transcript + (base.transcript && interimRef.current ? " " : "") + interimRef.current).trim();
  }, []);

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  const persistTurn = useCallback(async (turn: TurnState) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const { data, error } = await supabase
        .from("turns")
        .insert({
          session_id: sid,
          idx: turn.idx,
          kind: turn.kind,
          question: turn.question,
          transcript: turn.transcript || null,
          started_at: new Date(turn.startedAt).toISOString(),
          ended_at: turn.endedAt ? new Date(turn.endedAt).toISOString() : null,
          end_reason: turn.endReason ?? null,
          duration_ms: turn.durationMs ?? null,
          wpm: turn.wpm ?? null,
          filler_count: turn.fillerCount ?? null,
          star: turn.star ?? null,
          composite: turn.composite ?? null,
          jev_response: (turn.star?.raw as object) ?? null,
        })
        .select("id")
        .maybeSingle();
      if (error) throw error;
      if (data && checksRef.current.length) {
        const rows = checksRef.current.map((c) => ({
          turn_id: data.id,
          t_ms: Math.round(c.tMs),
          words: c.words,
          finished_p: c.finishedP,
          mid_sentence_p: c.midSentenceP,
          end_prob: c.endProb,
          latency_ms: c.latencyMs,
          input_tokens: c.inputTokens,
          cost_usd: c.costUsd,
          decision: c.decision,
        }));
        await supabase.from("turn_checks").insert(rows);
      }
    } catch (err) {
      console.error("persist failed:", err);
    }
  }, []);

  // ------------------------------------------------------------------
  // Question / follow-up flow
  // ------------------------------------------------------------------
  const askQuestion = useCallback(
    (question: string, kind: "question" | "follow_up") => {
      const turn: TurnState = {
        idx: turnIdxRef.current++,
        kind,
        question,
        transcript: "",
        startedAt: Date.now(),
      };
      askedCountRef.current += 1;
      setCurrentTurn(turn);
      currentTurnRef.current = turn;
      interimRef.current = "";
      setChecks([]);
      checksRef.current = [];
      finishedRef.current = false;
      endingRef.current = false;
      inFlightRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      lastChangeRef.current = Date.now();
      lastCheckAtRef.current = 0;
      setPhase("asking");
    },
    [],
  );

  const nextQuestion = useCallback(async () => {
    const cfg = configRef.current;
    if (askedCountRef.current >= cfg.questionCount) {
      void finishSession();
      return;
    }
    try {
      const res = await generateQuestions({
        role: cfg.role,
        seniority: cfg.seniority,
        interviewType: cfg.interviewType,
        jobDescription: cfg.jobDescription,
        count: 1,
        mock: cfg.interviewerMode === "mock",
      });
      const used = new Set(turnsRef.current.map((t) => t.question));
      const fresh = res.questions.find((q) => !used.has(q));
      if (!fresh) {
        void finishSession();
        return;
      }
      askQuestion(fresh, "question");
    } catch (err) {
      console.error("question generation failed:", err);
      void finishSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askQuestion]);

  // ------------------------------------------------------------------
  // Turn completion: Jev STAR scoring + follow-up decision
  // ------------------------------------------------------------------
  const completeTurn = useCallback(
    async (endReason: "jev" | "max_silence" | "manual") => {
      const base = currentTurnRef.current;
      if (!base || endingRef.current) return;
      endingRef.current = true;
      finishedRef.current = true;
      abortRef.current?.abort();

      const transcript = transcriptSoFar();
      const endedAt = Date.now();
      const durationMs = Math.max(0, endedAt - base.startedAt);
      setPhase("scoring");

      let star;
      let composite: number | null = null;
      let followUp: string | null = null;
      let targetDim: string | null = null;

      if (transcript) {
        if (engineRef.current === "jev") {
          try {
            const raw = await jevScore(base.question, transcript);
            star = parseStar(raw);
          } catch (err) {
            console.error("jev scoring failed, heuristic fallback:", err);
            engineRef.current = "heuristic";
            setEngine("heuristic");
            star = heuristicStar(base.question, transcript);
          }
        } else {
          star = heuristicStar(base.question, transcript);
        }
        composite = computeComposite(star, configRef.current.settings.weights).composite;

        const already = followUpForRef.current.has(base.idx) || base.kind === "follow_up";
        const dim = needsFollowUp(star, star.answerType?.confidence, already);
        if (dim) {
          targetDim = dim;
          try {
            const fu = await generateFollowUp({
              question: base.question,
              answer: transcript,
              targetDimension: dim,
              mock: configRef.current.interviewerMode === "mock",
            });
            followUp = fu.question;
          } catch {
            followUp = null;
          }
        }
      }

      const turn = finalizeTurnMetrics({
        ...base,
        transcript,
        endedAt,
        endReason,
        durationMs,
        star,
        composite: composite ?? undefined,
        targetDimension: targetDim,
      });
      setTurns((t) => [...t, turn]);
      void persistTurn(turn);

      if (followUp && askedCountRef.current < configRef.current.questionCount + 1) {
        followUpForRef.current.add(base.idx);
        setTimeout(() => {
          askQuestion(followUp, "follow_up");
        }, 500);
      } else {
        setTimeout(() => {
          void nextQuestion();
        }, 500);
      }
      setCurrentTurn(null);
      currentTurnRef.current = null;
    },
    [askQuestion, nextQuestion, persistTurn, transcriptSoFar],
  );

  const endTurnManual = useCallback(() => {
    if (phaseRef.current !== "answering" || endingRef.current) return;
    void completeTurn("manual");
  }, [completeTurn]);

  const startListening = useCallback(() => {
    if (currentTurnRef.current) {
      currentTurnRef.current.startedAt = Date.now();
    }
    lastChangeRef.current = Date.now();
    setPhase("answering");
  }, []);

  /** Room calls this on every interim/final transcript change. */
  const notifyTranscript = useCallback(() => {
    lastChangeRef.current = Date.now();
  }, []);

  /** Demo replay: append one scripted word to the current turn's transcript. */
  const feedDemoToken = useCallback((token: string) => {
    const base = currentTurnRef.current;
    if (!base) return;
    base.transcript = (base.transcript + (base.transcript ? " " : "") + token).trim();
    setCurrentTurn({ ...base });
    lastChangeRef.current = Date.now();
  }, []);

  // ------------------------------------------------------------------
  // Turn-taking tick
  // ------------------------------------------------------------------
  useEffect(() => {
    const id = setInterval(async () => {
      if (phaseRef.current !== "answering" || finishedRef.current || endingRef.current) return;
      const now = Date.now();
      const cfg = configRef.current;
      const transcript = transcriptSoFar();
      const words = transcript.split(/\s+/).filter(Boolean).length;
      const silence = now - lastChangeRef.current;

      const decision = decideTurn(
        {
          wordsSoFar: words,
          silenceMs: silence,
          inFlight: inFlightRef.current,
          sinceLastCheck: now - lastCheckAtRef.current,
        },
        cfg.settings,
      );

      if (decision.action === "end_turn") {
        void completeTurn("max_silence");
        return;
      }
      if (decision.action !== "send_check") return;

      lastCheckAtRef.current = now;
      const tMs = Math.round(now - (currentTurnRef.current?.startedAt ?? now));
      inFlightRef.current = true;

      if (engineRef.current === "heuristic") {
        const end = heuristicShouldEnd(transcript, silence);
        setChecks((c) => [
          ...c,
          {
            tMs,
            words,
            finishedP: end ? 0.9 : 0.1,
            midSentenceP: 0.1,
            endProb: end ? 0.81 : 0.09,
            latencyMs: 0,
            inputTokens: null,
            costUsd: null,
            decision: end ? "end_turn" : "keep_listening",
          },
        ]);
        inFlightRef.current = false;
        if (end) void completeTurn("jev");
        return;
      }

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const question = currentTurnRef.current?.question ?? "";
        const res = await jevTurnCheck(question, transcript, ac.signal);
        if (ac.signal.aborted || finishedRef.current) return;
        const finishedP = res.answers.finished?.noul ?? 0;
        const midP = res.answers.mid_sentence?.noul ?? 0;
        const endProb = computeEndProb(finishedP, midP);
        const end = shouldEndTurn(endProb, cfg.settings.threshold);
        setLastCheckLatency(res.latency_ms);
        setChecks((c) => [
          ...c,
          {
            tMs,
            words,
            finishedP,
            midSentenceP: midP,
            endProb,
            latencyMs: res.latency_ms,
            inputTokens: res.usage.input_tokens,
            costUsd: res.cost_usd,
            decision: end ? "end_turn" : "keep_listening",
          },
        ]);
        if (end) void completeTurn("jev");
      } catch (err) {
        if (!ac.signal.aborted) {
          console.error("jev check failed:", err);
          engineRef.current = "heuristic";
          setEngine("heuristic");
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        inFlightRef.current = false;
      }
    }, TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completeTurn, transcriptSoFar]);

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------
  const finishSession = useCallback(async () => {
    if (endingRef.current && phaseRef.current === "report") return;
    finishedRef.current = true;
    abortRef.current?.abort();
    setPhase("report");

    const scored = turnsRef.current.filter((t) => t.composite != null);
    const overall =
      scored.length > 0
        ? Math.round(scored.reduce((s, t) => s + (t.composite ?? 0), 0) / scored.length)
        : null;
    const { interruptionsAvoided, totalCostUsd } = summarizeChecks(checksRef.current);

    let feedback: FeedbackResult | null = null;
    try {
      feedback = await generateFeedback({
        turns: turnsRef.current.map((t) => ({
          question: t.question,
          kind: t.kind,
          transcript: t.transcript,
          star: t.star,
          composite: t.composite,
          wpm: t.wpm,
          filler_count: t.fillerCount,
        })),
        mock: configRef.current.interviewerMode === "mock",
      });
    } catch (err) {
      console.error("feedback failed:", err);
    }

    setReport({
      overallScore: overall,
      feedback,
      turns: turnsRef.current,
      interruptionsAvoided,
      jevCostUsd: totalCostUsd,
    });

    if (sessionIdRef.current) {
      await supabase
        .from("sessions")
        .update({ overall_score: overall, feedback: feedback?.feedback ?? null })
        .eq("id", sessionIdRef.current);
    }
  }, []);

  const endInterviewNow = useCallback(() => {
    void finishSession();
  }, [finishSession]);

  return {
    phase,
    setPhase,
    turns,
    currentTurn,
    checks,
    lastCheckLatency,
    engine,
    report,
    interimRef,
    notifyTranscript,
    feedDemoToken,
    askQuestion,
    startListening,
    endTurnManual,
    endInterviewNow,
  };
}
