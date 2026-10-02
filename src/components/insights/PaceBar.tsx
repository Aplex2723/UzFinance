import { formatMXN } from "@/lib/money";
import type { Insights } from "@/lib/repo/insights";
import { IncomeEditor } from "../IncomeEditor";

/**
 * Barra de ingreso: cuánto llevas gastado contra tu ingreso mensual y, en el mes en curso,
 * una marca con el avance del calendario (si el relleno pasa la marca, vas gastando más rápido que el mes).
 */
export function PaceBar({ i }: { i: Insights }) {
  if (i.income <= 0) {
    return (
      <div className="glass flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-muted">Configura tu ingreso mensual para ver qué porcentaje gastas y cuánto ahorras.</p>
        <IncomeEditor cents={0} variant="button" />
      </div>
    );
  }
  const used = i.usedPct ?? 0;
  const elapsed = (i.elapsedDays / i.daysInMonth) * 100;
  const over = used > 100;
  const ahead = i.isCurrent && used > elapsed + 5;
  const color = over ? "bg-down" : ahead ? "bg-[#f59e0b]" : "bg-up";
  return (
    <section className="glass p-4 sm:p-5" aria-label="Gasto contra ingreso" data-testid="pace-bar">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[12px] text-muted">Gastado de tu ingreso <span className="text-faint">({formatMXN(i.income, { compact: true })} al mes)</span></p>
        <IncomeEditor cents={i.income} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="num text-[30px] font-semibold leading-none sm:text-4xl" data-testid="income-used">{used.toFixed(0)}%</p>
        <p className="num text-right text-[13px] text-muted">
          {i.saved >= 0 ? "Te quedan " : "Excedido por "}
          <b className={i.saved >= 0 ? "text-up" : "text-down"} data-testid="income-left">{formatMXN(Math.abs(i.saved), { compact: true })}</b>
        </p>
      </div>
      <div className="relative mt-3 h-3 rounded-full bg-white/[0.07]" role="img" aria-label={`Has gastado ${used.toFixed(0)} por ciento de tu ingreso${i.isCurrent ? ` y va ${elapsed.toFixed(0)} por ciento del mes` : ""}`}>
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(Math.max(used, used > 0 ? 1.5 : 0), 100)}%` }} />
        {i.isCurrent && (
          <span className="absolute -top-1 bottom-[-4px] w-0.5 rounded bg-white" style={{ left: `calc(${Math.min(elapsed, 100)}% - 1px)` }} aria-hidden title={`Va ${elapsed.toFixed(0)}% del mes`} />
        )}
      </div>
      <p className="mt-2 flex flex-wrap justify-between gap-x-4 text-[11px] text-muted">
        <span>{i.isCurrent ? `Día ${i.elapsedDays} de ${i.daysInMonth} · la línea blanca es el calendario` : "Mes cerrado"}</span>
        {i.dailyAllowance !== null && <span>Puedes gastar <b className="num text-fg">{formatMXN(i.dailyAllowance, { compact: true })}</b> al día el resto del mes</span>}
      </p>
    </section>
  );
}
