import { formatMXN } from "@/lib/money";

type Cell = { date: string; cents: number; future: boolean };
const WD = ["L", "M", "M", "J", "V", "S", "D"];
// Escala monocromática (como la referencia) con el nivel más alto en acento.
const LEVELS = ["bg-white/[0.06]", "bg-white/20", "bg-white/40", "bg-white/75", "bg-accent"];

function levelOf(cents: number, cuts: number[]) {
  if (cents <= 0) return 0;
  if (cents <= cuts[0]) return 1;
  if (cents <= cuts[1]) return 2;
  if (cents <= cuts[2]) return 3;
  return 4;
}

export function Heatmap({ cells, weeks }: { cells: Cell[]; weeks: number }) {
  const vals = cells.filter((c) => c.cents > 0).map((c) => c.cents).sort((a, b) => a - b);
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] ?? 0;
  const cuts = [q(0.4), q(0.7), q(0.9)];
  const total = cells.reduce((a, c) => a + Math.max(c.cents, 0), 0);
  return (
    <div>
      <p className="num text-3xl font-semibold">{formatMXN(total, { compact: true })}</p>
      <p className="mb-3 text-muted">en las últimas {weeks} semanas</p>
      <div className="flex gap-1.5" role="img" aria-label={`Mapa de calor de gasto diario de las últimas ${weeks} semanas`}>
        <div className="grid grid-rows-7 gap-1 pt-0 text-[9px] text-faint" aria-hidden>
          {WD.map((d, i) => <span key={i} className="flex aspect-square items-center">{d}</span>)}
        </div>
        <div className="grid flex-1 grid-flow-col grid-rows-7 gap-1" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
          {cells.map((c) => (
            <div
              key={c.date}
              title={c.future ? c.date : `${c.date}: ${formatMXN(c.cents)}`}
              className={`aspect-square rounded-[3px] ${c.future ? "bg-transparent" : LEVELS[levelOf(c.cents, cuts)]}`}
            />
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-[10px] text-faint" aria-hidden>
        menos {LEVELS.map((l) => <span key={l} className={`h-2.5 w-2.5 rounded-[3px] ${l}`} />)} más
      </div>
    </div>
  );
}
