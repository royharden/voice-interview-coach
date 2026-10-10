import { motion } from "framer-motion";
import { Mic, MicOff, Type } from "lucide-react";

export type OrbPhase = "idle" | "speaking" | "listening" | "thinking";

const PHASE_LABEL: Record<OrbPhase, string> = {
  idle: "Ready",
  speaking: "Speaking",
  listening: "Listening",
  thinking: "Thinking",
};

const PHASE_COLOR: Record<OrbPhase, { from: string; to: string; ring: string }> = {
  idle: { from: "#334155", to: "#1e293b", ring: "rgba(148,163,184,0.25)" },
  speaking: { from: "#0ea5e9", to: "#0369a1", ring: "rgba(14,165,233,0.35)" },
  listening: { from: "#10b981", to: "#047857", ring: "rgba(16,185,129,0.35)" },
  thinking: { from: "#f59e0b", to: "#b45309", ring: "rgba(245,158,11,0.35)" },
};

export function Orb({ phase }: { phase: OrbPhase }) {
  const c = PHASE_COLOR[phase];
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative w-40 h-40 sm:w-48 sm:h-48">
        <motion.div
          className="absolute inset-0 rounded-full blur-2xl"
          style={{ background: c.ring }}
          animate={{ opacity: phase === "idle" ? 0.4 : 1, scale: phase === "idle" ? 0.9 : 1.05 }}
          transition={{ duration: 0.8 }}
        />
        <motion.div
          className="absolute inset-3 rounded-full"
          style={{
            background: `radial-gradient(circle at 35% 30%, ${c.from}, ${c.to})`,
          }}
          animate={
            phase === "speaking"
              ? { scale: [1, 1.07, 1, 0.97, 1] }
              : phase === "listening"
                ? { scale: [1, 1.03, 1] }
                : phase === "thinking"
                  ? { rotate: [0, 180, 360], scale: 1.02 }
                  : { scale: 1 }
          }
          transition={
            phase === "speaking"
              ? { repeat: Infinity, duration: 0.9, ease: "easeInOut" }
              : phase === "listening"
                ? { repeat: Infinity, duration: 2.4, ease: "easeInOut" }
                : phase === "thinking"
                  ? { repeat: Infinity, duration: 3, ease: "linear" }
                  : { duration: 0.4 }
          }
        />
        <div className="absolute inset-3 rounded-full ring-1 ring-white/10" />
      </div>
      <div className="flex items-center gap-2 text-sm text-slate-300">
        {phase === "listening" ? (
          <Mic className="w-4 h-4 text-emerald-400" />
        ) : phase === "idle" ? (
          <MicOff className="w-4 h-4 text-slate-500" />
        ) : null}
        <span className="font-medium tracking-wide">{PHASE_LABEL[phase]}</span>
      </div>
    </div>
  );
}

export function TypedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-0.5 text-xs text-slate-300 border border-slate-700">
      <Type className="w-3 h-3" /> typed mode
    </span>
  );
}

export function Chip({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "slate" | "sky" | "emerald" | "amber" | "rose";
}) {
  const tones: Record<string, string> = {
    slate: "bg-slate-800 text-slate-300 border-slate-700",
    sky: "bg-sky-950 text-sky-300 border-sky-800",
    emerald: "bg-emerald-950 text-emerald-300 border-emerald-800",
    amber: "bg-amber-950 text-amber-300 border-amber-800",
    rose: "bg-rose-950 text-rose-300 border-rose-800",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}
