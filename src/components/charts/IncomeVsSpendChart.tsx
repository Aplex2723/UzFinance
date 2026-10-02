"use client";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { HistoryRow } from "@/lib/repo/insights";

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: HistoryRow }> };

function Tip({ active, payload }: TipProps) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="glass !rounded-xl px-3 py-2 text-[11px]">
      <p className="mb-1 text-muted">{monthLabel(r.month)}</p>
      <p>Gasto: <b className="num">{formatMXN(r.spent)}</b></p>
      {r.usedPct !== null && <p>{r.usedPct.toFixed(0)}% del ingreso</p>}
      {r.income > 0 && <p className={r.saved >= 0 ? "text-up" : "text-down"}>{r.saved >= 0 ? "Ahorro" : "Déficit"}: <b className="num">{formatMXN(Math.abs(r.saved))}</b></p>}
    </div>
  );
}

/** 12 meses de gasto contra la línea de ingreso: las barras que la pasan se pintan en rojo. */
export function IncomeVsSpendChart({ rows, month, income }: { rows: HistoryRow[]; month: string; income: number }) {
  const max = Math.max(income, ...rows.map((r) => r.spent), 1);
  return (
    <div className="h-[240px] w-full" role="img" aria-label="Gasto mensual de los últimos 12 meses contra tu ingreso" data-testid="income-chart">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 240 }}>
        <BarChart data={rows} margin={{ top: 14, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="rgb(255 255 255 / .06)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => monthLabel(m, true).split(" ")[0]} tick={{ fill: "#8b8b92", fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
          <YAxis hide domain={[0, max * 1.12]} />
          <Tooltip content={(p) => <Tip active={p.active} payload={p.payload as TipProps["payload"]} />} cursor={{ fill: "rgb(255 255 255 / .04)" }} />
          {income > 0 && <ReferenceLine y={income} stroke="#22c55e" strokeDasharray="5 4" label={{ value: "Ingreso", position: "insideTopLeft", fill: "#22c55e", fontSize: 10 }} />}
          <Bar dataKey="spent" radius={[6, 6, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.month} fill={income > 0 && r.spent > income ? "#ef4444" : r.month === month ? "#ff4d1c" : "rgb(255 255 255 / .22)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
