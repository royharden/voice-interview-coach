import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TurnCheck } from "@/lib/types";

export function EndOfTurnChart({
  checks,
  threshold,
}: {
  checks: TurnCheck[];
  threshold: number;
}) {
  const data = useMemo(
    () =>
      checks.map((c, i) => ({
        i,
        t: Math.round(c.tMs / 100) / 10,
        endProb: Math.round(c.endProb * 1000) / 1000,
        decision: c.decision,
      })),
    [checks],
  );
  const chartRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (stick && chartRef.current) {
      chartRef.current.scrollTop = chartRef.current.scrollHeight;
    }
  }, [data.length, stick]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-200">End-of-turn checks</h3>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={stick} onChange={(e) => setStick(e.target.checked)} className="accent-sky-500" />
          follow
        </label>
      </div>
      <div ref={chartRef} className="h-44 overflow-y-auto rounded-lg bg-slate-900/60 border border-slate-800">
        <div className="h-44">
          <ResponsiveContainer width="100%" height={data.length ? Math.max(176, data.length * 14) : 176}>
            <LineChart data={data} margin={{ top: 10, right: 16, bottom: 4, left: -18 }}>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis dataKey="t" tick={{ fill: "#64748b", fontSize: 10 }} unit="s" />
              <YAxis domain={[0, 1]} tick={{ fill: "#64748b", fontSize: 10 }} />
              <Tooltip
                contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, fontSize: 12 }}
                labelFormatter={(v) => `t=${v}s`}
                formatter={(value) => [Number(value ?? 0).toFixed(2), "endProb"]}
              />
              <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="6 4" />
              <Line type="stepAfter" dataKey="endProb" stroke="#0ea5e9" strokeWidth={2} dot={{ r: 2.5, fill: data.length && data[data.length - 1].decision === "end_turn" ? "#10b981" : "#0ea5e9" }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Dashed line = threshold ({threshold.toFixed(2)}). Each point is one Jev check.
      </p>
    </div>
  );
}
