import { formatMXN } from "@/lib/money";
import type { Insights } from "@/lib/repo/insights";

/** Por categoría: barra del mes (color) y marca del mes pasado al mismo día, con la diferencia. */
export function CategoryCompare({ rows, prevLabel }: { rows: Insights["categoryDeltas"]; prevLabel: string }) {
  if (rows.length === 0) return <p className="py-6 text-center text-muted">Sin gasto para comparar.</p>;
  const max = Math.max(...rows.flatMap((r) => [r.cents, r.prevCents]), 1);
  return (
    <ul className="flex flex-col gap-3.5" data-testid="category-compare">
      {rows.slice(0, 8).map((r) => {
        const diff = r.cents - r.prevCents;
        return (
          <li key={r.name}>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate">{r.name}</span>
              <span className="num shrink-0 text-[12px]">
                {formatMXN(r.cents, { compact: true })}{" "}
                <span className={diff > 0 ? "text-down" : diff < 0 ? "text-up" : "text-faint"}>
                  {diff === 0 ? "=" : `${diff > 0 ? "+" : "−"}${formatMXN(Math.abs(diff), { compact: true })}`}
                </span>
              </span>
            </div>
            <div className="relative h-2.5 rounded-full bg-white/[0.06]" role="img" aria-label={`${r.name}: ${formatMXN(r.cents)} este mes, ${formatMXN(r.prevCents)} en ${prevLabel}`}>
              <div className="h-full rounded-full" style={{ width: `${(Math.max(r.cents, 0) / max) * 100}%`, background: r.color }} />
              {r.prevCents > 0 && <span className="absolute -bottom-[3px] -top-[3px] w-0.5 rounded bg-white/80" style={{ left: `calc(${(r.prevCents / max) * 100}% - 1px)` }} aria-hidden />}
            </div>
          </li>
        );
      })}
      <li className="text-[11px] text-faint">La línea blanca es lo que llevabas en {prevLabel} al mismo día.</li>
    </ul>
  );
}
