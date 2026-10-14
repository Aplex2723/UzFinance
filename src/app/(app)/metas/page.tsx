import Link from "next/link";
import { GoalEditor } from "@/components/goals/GoalEditor";
import { GoalBar, KIND_ICON, StatusChip } from "@/components/goals/meta";
import { RecapPanel } from "@/components/goals/RecapPanel";
import { IncomeEditor } from "@/components/IncomeEditor";
import { InsightList } from "@/components/insights/InsightList";
import { KpiTile } from "@/components/insights/Kpi";
import { Empty, PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { getEnv } from "@/lib/env";
import { monthLabel } from "@/lib/format";
import { goalWhen, KIND_LABEL, PRIORITY_LABEL, planMessages } from "@/lib/goals";
import { recapHash } from "@/lib/goals-recap";
import { formatMXN } from "@/lib/money";
import { getGoalsOverview } from "@/lib/repo/goals-plan";
import { getRecap } from "@/lib/repo/goals-recap";

const money = (c: number) => formatMXN(c, { compact: true });
const monthYear = (iso: string) => monthLabel(iso.slice(0, 7)).toLowerCase();

export default async function Page() {
  await requirePageUser();
  const [o, recap] = await Promise.all([getGoalsOverview(), getRecap()]);
  const { summary: s, capacity: cap } = o;
  const pending = s.plans.filter((p) => p.status !== "done");
  const onTime = s.counts.on_track + s.counts.tight;
  const messages = planMessages(s, cap, o.categories);
  const blocked = !o.goals.length ? "Crea al menos una meta para generar el resumen." : cap.basis === "none" ? "Configura tu ingreso y registra gastos para poder generar el resumen." : null;
  const configured = !!getEnv().OPENROUTER_API_KEY;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Metas" subtitle="Cuánto necesitas, si te alcanza con lo que ganas y gastas, y qué hacer para lograrlas." action={<GoalEditor />} />

      {cap.income <= 0 && (
        <div className="glass flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-muted">Configura tu ingreso mensual para predecir si alcanzas tus metas.</p>
          <IncomeEditor cents={0} variant="button" />
        </div>
      )}

      {s.plans.length === 0 ? (
        <Panel><Empty>Aún no tienes metas. Crea una (por ejemplo, “Tesla” para abril 2027) y te digo cuánto apartar y si llegas.</Empty></Panel>
      ) : (
        <>
          <section aria-label="Cifras clave de metas" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label="Te sobra al mes" value={cap.basis === "none" ? "—" : money(Math.max(0, cap.surplus))} tone={cap.basis !== "none" && cap.surplus <= 0 ? "bad" : "default"}
              sub={cap.basis === "none" ? "sin ingreso o sin gastos" : `${money(cap.income)} − ${money(cap.avgSpend)} de gasto típico`} testId="goals-surplus"
            />
            <KpiTile
              label="Metas a tiempo" value={cap.basis === "none" ? "—" : `${onTime} de ${pending.length}`} tone={cap.basis !== "none" && pending.length > 0 ? (onTime === pending.length ? "good" : "bad") : "default"}
              sub={`${s.counts.done} lograda${s.counts.done === 1 ? "" : "s"}`} testId="goals-ontime"
            />
            <KpiTile label="Piden al mes" value={money(s.totalPerMonth)} sub={cap.income > 0 ? `${((s.totalPerMonth / cap.income) * 100).toFixed(0)}% de tu ingreso` : "suma de todas las metas"} testId="goals-total-permonth" />
            <KpiTile
              label="Terminarías todo" value={s.lastDate ? monthYear(s.lastDate) : pending.length ? "No alcanza" : "—"} tone={pending.length > 0 && !s.lastDate && cap.basis !== "none" ? "bad" : "default"}
              sub={s.extraNeeded > 0 ? `faltan ${money(s.extraNeeded)} al mes para llegar a tiempo` : pending.length ? "con tu excedente actual" : undefined} testId="goals-last"
            />
          </section>

          <RecapPanel
            recap={recap ? { text: recap.text, at: recap.at, model: recap.model } : null}
            stale={!!recap && recap.hash !== recapHash(s, cap)}
            configured={configured}
            blockedReason={blocked}
            title="Resumen con IA"
            endpoint="/api/goals/recap"
            idleText="Genera un resumen de cómo van tus metas y qué hacer para alcanzarlas, con base en tus ingresos y gastos."
            testId="recap"
          />

          <Panel title="Análisis automático">
            <InsightList messages={messages} />
          </Panel>

          <section aria-label="Tus metas" className="grid gap-3 lg:grid-cols-2" data-testid="goal-cards">
            {s.plans.map((p) => {
              const Icon = KIND_ICON[p.goal.kind];
              const g = p.goal;
              return (
                <article key={g.id} className="glass p-4 sm:p-5" data-testid="goal-card">
                  <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2"><Icon size={15} className="shrink-0 text-muted" aria-hidden /><b className="truncate text-[15px] font-semibold">{g.name}</b></p>
                      <p className="mt-0.5 text-[11px] text-faint">{KIND_LABEL[g.kind]} · prioridad {PRIORITY_LABEL[g.priority].toLowerCase()}{p.order > 0 ? ` · se financia #${p.order}` : ""}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2"><StatusChip status={p.status} /><GoalEditor goal={g} variant="icon" /></div>
                  </header>
                  <div className="mt-3 flex items-end justify-between gap-3">
                    <p className="num text-[28px] font-semibold leading-none">{p.progress.pct.toFixed(0)}%</p>
                    <p className="num text-right text-[13px] text-muted">{money(g.savedCents)} de {money(g.targetCents)}</p>
                  </div>
                  <div className="mt-2.5"><GoalBar pct={p.progress.pct} status={p.status} /></div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                    <div><dt className="text-faint">Fecha límite</dt><dd className="text-fg">{goalWhen(g)}</dd></div>
                    <div><dt className="text-faint">Faltan</dt><dd className="num text-fg">{money(p.progress.remaining)}</dd></div>
                    {p.status !== "done" && (
                      <>
                        <div><dt className="text-faint">Apartar al mes</dt><dd className="num text-fg">{money(p.needPerMonth)}</dd></div>
                        <div><dt className="text-faint">Estimado con tu excedente</dt><dd className="text-fg">{p.projectedDate ? monthYear(p.projectedDate) : cap.basis === "none" ? "—" : "no alcanza"}</dd></div>
                        {p.gapPerMonth > 0 && cap.basis !== "none" && <div className="col-span-2"><dt className="text-faint">Para llegar a tiempo falta liberar</dt><dd className="num text-down">{money(p.gapPerMonth)} al mes</dd></div>}
                      </>
                    )}
                  </dl>
                </article>
              );
            })}
          </section>

          {cap.basis !== "none" && pending.length > 0 && (
            <Panel title="¿Y si recortas tu gasto?">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]" data-testid="scenarios">
                  <thead className="text-faint"><tr><th className="py-1.5 pr-3 font-normal">Recorte</th><th className="py-1.5 pr-3 font-normal">Liberas al mes</th><th className="py-1.5 pr-3 font-normal">Metas a tiempo</th><th className="py-1.5 font-normal">Terminas todo</th></tr></thead>
                  <tbody>
                    {o.scenarios.map((x) => (
                      <tr key={x.cutPct} className="border-t border-line">
                        <td className="py-2 pr-3">{x.cutPct === 0 ? "Como vas hoy" : `−${x.cutPct}% de gasto`}</td>
                        <td className="num py-2 pr-3">{x.cutPct === 0 ? "—" : money(x.freed)}</td>
                        <td className={`num py-2 pr-3 ${x.onTime === x.active ? "text-up" : ""}`}>{x.onTime} de {x.active}</td>
                        <td className="py-2">{x.lastDate ? monthYear(x.lastDate) : "no alcanza"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="px-1 text-[11px] leading-relaxed text-faint">
            Cómo se calcula: te sobra lo que queda de tu ingreso mensual después del gasto típico ({o.monthsUsed.length ? `promedio de ${o.monthsUsed.map((m) => monthLabel(m, true)).join(", ")}` : "proyección del mes en curso"}). Ese excedente se reparte
            en orden de prioridad (y fecha) entre tus metas; no incluye ingresos extra (aguinaldo, bonos) ni rendimientos. El ahorro de cada meta lo actualizas tú.{" "}
            <Link href="/configuracion" className="underline underline-offset-2">Ingreso y ajustes</Link>.
          </p>
        </>
      )}
    </div>
  );
}
