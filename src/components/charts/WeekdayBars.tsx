"use client";
import { useState } from "react";
import { formatMXN } from "@/lib/money";

const DAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

export function WeekdayBars({ totals }: { totals: number[] }) {
  const max = Math.max(...totals, 1);
  const top = totals.indexOf(Math.max(...totals));
  const [sel, setSel] = useState(top < 0 ? 0 : top);
  return (
    <div>
      <p className="num text-3xl font-semibold" aria-live="polite">{formatMXN(totals[sel], { compact: true })}</p>
      <p className="mb-3 text-muted">gastado en {DAYS[sel].toLowerCase()} este mes</p>
      <div className="flex h-[200px] items-end justify-between gap-2" role="group" aria-label="Gasto por día de la semana">
        {totals.map((v, i) => (
          <button
            key={DAYS[i]}
            type="button"
            onClick={() => setSel(i)}
            aria-pressed={i === sel}
            aria-label={`${DAYS[i]}: ${formatMXN(v)}`}
            className="group flex h-full flex-1 flex-col items-center justify-end gap-2"
          >
            <span className="relative flex w-full flex-1 items-end overflow-hidden rounded-xl bg-white/[0.04]">
              <span
                className={`w-full rounded-xl transition-all ${i === sel ? "bg-gradient-to-t from-[#8f1d00] via-accent to-[#ff7a50]" : "bg-white/[0.14] group-hover:bg-white/25"}`}
                style={{ height: `${Math.max((v / max) * 100, v > 0 ? 6 : 0)}%` }}
              />
            </span>
            <span className={`text-[10px] ${i === sel ? "text-white" : "text-muted"}`}>{DAYS[i]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
