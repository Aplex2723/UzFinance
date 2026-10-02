"use client";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { StartedRow } from "@/lib/msi";

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: StartedRow }> };

function Tip({ active, payload }: TipProps) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="glass !rounded-xl px-3 py-2 text-[11px]">
      <p className="mb-1 text-muted">{monthLabel(r.month)}</p>
      <p>Compras a MSI: <b className="num">{r.count}</b></p>
      <p>Monto: <b className="num">{formatMXN(r.cents)}</b></p>
    </div>
  );
}

/** Monto de compras a meses por mes de compra (el mes en curso resaltado). */
export function MsiStartedChart({ rows, month }: { rows: StartedRow[]; month: string }) {
  const max = Math.max(...rows.map((r) => r.cents), 1);
  return (
    <div className="h-[200px] w-full" role="img" aria-label="Compras nuevas a meses sin intereses por mes de compra" data-testid="msi-started">
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 200 }}>
        <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
          <CartesianGrid stroke="rgb(255 255 255 / .06)" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m: string) => monthLabel(m, true).split(" ")[0]} tick={{ fill: "#8b8b92", fontSize: 10 }} axisLine={false} tickLine={false} interval={0} />
          <YAxis hide domain={[0, max * 1.12]} />
          <Tooltip content={(p) => <Tip active={p.active} payload={p.payload as TipProps["payload"]} />} cursor={{ fill: "rgb(255 255 255 / .04)" }} />
          <Bar dataKey="cents" radius={[6, 6, 0, 0]} isAnimationActive={false}>
            {rows.map((r) => <Cell key={r.month} fill={r.month === month ? "#ff4d1c" : "rgb(255 255 255 / .22)"} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
