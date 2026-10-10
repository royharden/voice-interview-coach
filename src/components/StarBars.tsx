import { motion } from "framer-motion";
import type { StarResult } from "@/lib/types";

const DIMENSIONS: Array<{ key: keyof StarResult; label: string }> = [
  { key: "situation", label: "Situation" },
  { key: "task", label: "Task" },
  { key: "action", label: "Action" },
  { key: "result", label: "Result" },
  { key: "relevance", label: "Relevance" },
];

function barColor(score: number): string {
  if (score < 1) return "bg-rose-500";
  if (score < 2) return "bg-amber-500";
  return "bg-emerald-500";
}

export function StarBars({ star }: { star: StarResult }) {
  return (
    <div className="space-y-2">
      {DIMENSIONS.map(({ key, label }) => {
        const dim = star[key] as { score?: number; confidence?: number } | undefined;
        const score = dim?.score;
        const conf = dim?.confidence;
        return (
          <div key={key} className="flex items-center gap-3">
            <span className="w-20 text-xs text-slate-400">{label}</span>
            <div className="flex-1 h-2 rounded-full bg-slate-800 overflow-hidden">
              {score != null && (
                <motion.div
                  className={`h-full rounded-full ${barColor(score)}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${(score / 3) * 100}%` }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              )}
            </div>
            <span className="w-16 text-right text-xs text-slate-300 tabular-nums">
              {score != null ? `${score.toFixed(1)}${conf != null ? ` · ${(conf * 100).toFixed(0)}%` : ""}` : "—"}
            </span>
          </div>
        );
      })}
    </div>
  );
}
