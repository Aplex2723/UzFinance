"use client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { ScheduleRow } from "@/lib/msi";

type Card = { id: number; name: string; color: string };
type Row = { month: string; total: number; past: boolean } & Record<string, number | string | boolean>;
type TipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: Row }> };

function Tip({ active, payload, cards }: TipProps & { cards: Card[] }) {
  const r = payload?.[0]?.payload;
  if (!active || !r) return null;
  return (
    <div className="glass !rounded-xl px-3 py-2 text-[11px]">
      <p className="mb-1 text-muted">{monthLabel(r.month)}</p>
      <p>Se cobran: <b className="num">{formatMXN(r.total)}</b></p>
      {cards.filter((c) => Number(r[`c${c.id}`]) > 0).map((c) => (
        <p key={c.id} className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />{c.name}: <span className="num">{formatMXN(Number(r[`c${c.id}`]))}</span></p>
      ))}
    </div>
  );
}

/** Mensualidades de MSI por mes natural, apiladas por tarjeta: se ve cuándo baja la carga. */
export function MsiTimelineChart({ rows, cards }: { rows: ScheduleRow[]; cards: Card[] }) {
  const data: Row[] = rows.map((r) => ({ month: r.month, total: r.total, past: r.past, ...Object.fromEntries(cards.map((c) => [`c${c.id}`, r.byCard[c.id] ?? 0])) }));
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <div>
      <div className="h-[240px] w-full" role="img" aria-label="Mensualidades a meses sin intereses por mes" data-testid="msi-timeline">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height: 240 }}>
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="rgb(255 255 255 / .06)" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="month" tickFormatter={(m: string) => monthLabel(m, true).split(" ")[0]} tick={{ fill: "#8b8b92", fontSize: 10 }} axisLine={false} tickLine={false} interval={0} minTickGap={2} />
            <YAxis hide domain={[0, max * 1.1]} />
            <Tooltip content={(p) => <Tip active={p.active} payload={p.payload as TipProps["payload"]} cards={cards} />} cursor={{ fill: "rgb(255 255 255 / .04)" }} />
            {cards.map((c, i) => (
              <Bar key={c.id} dataKey={`c${c.id}`} stackId="msi" fill={c.color} radius={i === cards.length - 1 ? [5, 5, 0, 0] : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
        {cards.map((c) => <li key={c.id} className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: c.color }} />{c.name}</li>)}
      </ul>
    </div>
  );
}
