import Link from "next/link";
import { goalWhen, KIND_LABEL } from "@/lib/goals";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { GoalsOverview } from "@/lib/repo/goals-plan";
import { GoalEditor } from "./GoalEditor";
import { GoalBar, KIND_ICON, StatusChip } from "./meta";

const money = (c: number) => formatMXN(c, { compact: true });

/** Panel del dashboard: todas las metas con su avance y si van a tiempo; crear, editar y eliminar desde aquí. */
export function GoalsOverviewPanel({ o }: { o: GoalsOverview }) {
  const { summary: s, capacity: cap } = o;
  const pending = s.plans.filter((p) => p.status !== "done");
  const onTime = s.counts.on_track + s.counts.tight;
  return (
    <section className="glass p-4 sm:p-5" aria-label="Metas de ahorro" data-testid="goal-panel">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[12px] font-medium text-muted">Metas de ahorro</h2>
          {pending.length > 0 && cap.basis !== "none" && (
            <p className="mt-0.5 text-[12px] text-muted">
              {onTime} de {pending.length} a tiempo · te sobran unos <b className="num text-fg">{money(Math.max(0, cap.surplus))}</b> al mes
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {s.plans.length > 0 && <Link href="/metas" className="btn" data-testid="goals-detail">Ver análisis</Link>}
          <GoalEditor />
        </div>
      </header>

      {s.plans.length === 0 ? (
        <p className="mt-3 text-muted">¿Estás juntando para algo (departamento, auto, viaje…)? Crea una meta y te digo cuánto apartar cada mes y si te alcanza.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3" data-testid="goal-list">
          {s.plans.map((p) => {
            const Icon = KIND_ICON[p.goal.kind];
            return (
              <li key={p.goal.id} className="rounded-xl border border-line bg-black/20 p-3" data-testid="goal-row">
                <div className="flex items-center justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-2">
                    <Icon size={14} className="shrink-0 text-muted" aria-label={KIND_LABEL[p.goal.kind]} />
                    <b className="truncate font-medium" data-testid="goal-name">{p.goal.name}</b>
                    <StatusChip status={p.status} />
                  </p>
                  <GoalEditor goal={p.goal} variant="icon" />
                </div>
                <div className="mt-2"><GoalBar pct={p.progress.pct} status={p.status} /></div>
                <p className="mt-1.5 flex flex-wrap justify-between gap-x-4 text-[11px] text-muted">
                  <span><span className="num text-fg" data-testid="goal-saved">{money(p.goal.savedCents)}</span> de {money(p.goal.targetCents)} · {p.progress.pct.toFixed(0)}%</span>
                  <span>para {goalWhen(p.goal)}</span>
                </p>
                {p.status !== "done" && (
                  <p className="mt-0.5 flex flex-wrap justify-between gap-x-4 text-[11px] text-muted">
                    <span>Aparta <b className="num text-fg" data-testid="goal-permonth">{money(p.needPerMonth)}</b> al mes</span>
                    {p.projectedDate && <span>Estimado: {monthLabel(p.projectedDate.slice(0, 7)).toLowerCase()}</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
