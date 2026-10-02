import { formatMXN } from "@/lib/money";
import { goalMessages, goalProgress, type Goal } from "@/lib/goals";
import { monthLabel } from "@/lib/format";
import { GoalEditor } from "../GoalEditor";
import { InsightList } from "./InsightList";

/** Meta de ahorro: avance, lo que falta y cuánto apartar al mes. `projectedSaving` = ingreso − gasto proyectado del mes en curso. */
export function GoalPanel({ goal, income, today, projectedSaving }: { goal: Goal | null; income: number; today: string; projectedSaving: number | null }) {
  if (!goal) {
    return (
      <section className="glass flex flex-wrap items-center justify-between gap-3 p-4" aria-label="Meta de ahorro" data-testid="goal-panel">
        <p className="text-muted">¿Estás juntando para algo (departamento, viaje…)? Crea una meta y te digo cuánto apartar cada mes.</p>
        <GoalEditor goal={null} variant="button" />
      </section>
    );
  }
  const p = goalProgress(goal, today, income);
  const msgs = goalMessages(goal, p, projectedSaving);
  return (
    <section className="glass p-4 sm:p-5" aria-label="Meta de ahorro" data-testid="goal-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[12px] text-muted">Meta: <b className="font-medium text-fg">{goal.name}</b> <span className="text-faint">· {monthLabel(goal.targetDate.slice(0, 7))}</span></p>
        <GoalEditor goal={goal} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <p className="num text-[30px] font-semibold leading-none sm:text-4xl" data-testid="goal-pct">{p.pct.toFixed(0)}%</p>
        <p className="num text-right text-[13px] text-muted"><span data-testid="goal-saved">{formatMXN(goal.savedCents, { compact: true })}</span> de {formatMXN(goal.targetCents, { compact: true })}</p>
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={`Llevas ${p.pct.toFixed(0)} por ciento de tu meta`}>
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(Math.max(p.pct, p.pct > 0 ? 1.5 : 0), 100)}%` }} />
      </div>
      <p className="mt-2 flex flex-wrap justify-between gap-x-4 text-[11px] text-muted">
        <span>Faltan <b className="num text-fg" data-testid="goal-remaining">{formatMXN(p.remaining, { compact: true })}</b></span>
        {!p.done && !p.overdue && <span>Aparta <b className="num text-fg" data-testid="goal-permonth">{formatMXN(p.perMonth, { compact: true })}</b> al mes</span>}
      </p>
      <div className="mt-3"><InsightList messages={msgs} /></div>
    </section>
  );
}
