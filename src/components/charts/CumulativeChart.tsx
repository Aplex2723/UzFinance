"use client";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMXN } from "@/lib/money";

type Pt = { day: number; current: number | null; previous: number | null };

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown }>; label?: unknown; curLabel: string; prevLabel: string };

function Tip({ active, payload, label, curLabel, prevLabel }: TipProps) {
  if (!active || !payload?.length) return null;
  const cur = payload.find((p) => p.dataKey === "current")?.value;
  const prev = payload.find((p) => p.dataKey === "previous")?.value;
  return (
    <div className="glass !rounded-xl px-3 py-2 text-[11px]">
      <p className="mb-1 text-muted">Día {String(label)}</p>
      {cur != null && <p><span className="text-accent">●</span> {curLabel}: <b className="num">{formatMXN(cur as number)}</b></p>}
      {prev != null && <p><span className="text-white">●</span> {prevLabel}: <b className="num">{formatMXN(prev as number)}</b></p>}
    </div>
  );
}

export function CumulativeChart({ points, cutoff, curLabel, prevLabel }: { points: Pt[]; cutoff: number; curLabel: string; prevLabel: string }) {
  const [sel, setSel] = useState(cutoff);
  const selected = points.find((p) => p.day === sel);
  const maxDay = points.length;

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="num text-3xl font-semibold" aria-live="polite">{formatMXN(selected?.current ?? selected?.previous ?? 0, { compact: true })}</p>
        <p className="text-muted">acumulado al día {sel}</p>
        <p className="ml-auto flex items-center gap-3 text-[11px] text-muted">
          <span><span className="text-accent">●</span> {curLabel}</span>
          <span><span className="text-white">●</span> {prevLabel}</span>
        </p>
      </div>
      <div className="h-[220px] w-full" role="img" aria-label={`Gasto acumulado de ${curLabel} contra ${prevLabel}`}>
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 220 }}>
          <LineChart data={points} margin={{ top: 10, right: 8, bottom: 0, left: 8 }} onClick={(s) => { const d = Number(s?.activeLabel); if (d) setSel(d); }}>
            <CartesianGrid stroke="rgb(255 255 255 / .06)" strokeDasharray="2 4" />
            <XAxis dataKey="day" tick={{ fill: "#5a5a62", fontSize: 10 }} axisLine={false} tickLine={false} interval={4} />
            <YAxis hide domain={[0, "dataMax"]} />
            <Tooltip content={(p) => <Tip active={p.active} payload={p.payload} label={p.label} curLabel={curLabel} prevLabel={prevLabel} />} cursor={{ stroke: "rgb(255 255 255 / .15)" }} />
            <Line type="monotone" dataKey="previous" stroke="#f5f5f5" strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />
            <Line type="monotone" dataKey="current" stroke="#ff4d1c" strokeWidth={2.2} dot={false} connectNulls={false} isAnimationActive={false} />
            {selected?.current != null && <ReferenceDot x={sel} y={selected.current} r={5} fill="#ff4d1c" stroke="rgb(255 77 28 / .35)" strokeWidth={6} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Seleccionar día del mes">
        {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setSel(d)}
            aria-pressed={d === sel}
            disabled={d > cutoff}
            className={`h-6 min-w-6 shrink-0 rounded-md border text-[10px] ${d === sel ? "border-white/60 bg-white/15 text-white" : "border-line bg-surface text-muted hover:text-fg"} disabled:opacity-30`}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}
