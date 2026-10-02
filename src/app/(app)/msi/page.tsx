import { MsiStartedChart } from "@/components/charts/MsiStartedChart";
import { MsiTimelineChart } from "@/components/charts/MsiTimelineChart";
import { InsightList } from "@/components/insights/InsightList";
import { KpiTile } from "@/components/insights/Kpi";
import { Empty, PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { buildMsiMessages, monthOf } from "@/lib/msi";
import { getMsi } from "@/lib/repo/plans";

/** Colores distintos por tarjeta (los de la tarjeta suelen repetirse entre las de un mismo banco). */
const PALETTE = ["#ff4d1c", "#3b82f6", "#22c55e", "#a855f7", "#eab308", "#06b6d4", "#ec4899", "#f97316"];

const dayLabel = (iso: string) => `${Number(iso.slice(8, 10))} ${monthLabel(iso.slice(0, 7), true).split(" ")[0]}`;
const monthsLeft = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));

export default async function Page() {
  await requirePageUser();
  const s = await getMsi();
  const cur = monthOf(s.today);
  const messages = buildMsiMessages(s);
  const finished = s.plans.filter((p) => !p.active);
  const left = s.freeMonth ? monthsLeft(cur, s.freeMonth) : 0;
  const activeCards = s.cards.filter((c) => s.active.some((p) => p.cardId === c.id)).map((c, i) => ({ ...c, color: PALETTE[i % PALETTE.length] }));
  const colorOf = new Map(activeCards.map((c) => [c.id, c.color]));
  const started = s.started.filter((r) => r.count > 0).length;

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Meses sin intereses" subtitle="Qué debes a meses, cuánto se te cobra cada mes y cuándo termina cada plan." />

      {s.plans.length === 0 ? (
        <Panel><Empty>Aún no hay planes a meses. Se llenan al importar tus estados de cuenta (sección “compras y cargos diferidos a meses”).</Empty></Panel>
      ) : (
        <>
          <section aria-label="Cifras clave de MSI" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile label="Se cobra este mes" value={formatMXN(s.loadNow, { compact: true })} sub={s.loadPct !== null ? `${s.loadPct.toFixed(0)}% de tu ingreso` : "configura tu ingreso"} tone={s.loadPct !== null && s.loadPct > 30 ? "bad" : "default"} testId="msi-load" />
            <KpiTile label="Saldo por pagar" value={formatMXN(s.remainingTotal, { compact: true })} sub={`${s.active.length} plan${s.active.length === 1 ? "" : "es"} vigente${s.active.length === 1 ? "" : "s"}`} testId="msi-remaining" />
            <KpiTile
              label="Terminas todo en"
              value={s.freeMonth ? monthLabel(s.freeMonth, true) : "—"}
              sub={s.freeMonth ? (left > 0 ? `en ${left} ${left === 1 ? "mes" : "meses"}` : "este mes") : "sin planes vigentes"}
              tone={s.freeMonth ? "good" : "default"}
              testId="msi-free"
            />
            <KpiTile
              label="Próximo en terminar"
              value={s.nextEnding ? monthLabel(s.nextEnding.endMonth, true) : "—"}
              sub={s.nextEnding ? <span className="block truncate">{s.nextEnding.merchant}</span> : undefined}
            />
          </section>

          <Panel title="Lo que hay que saber"><InsightList messages={messages} /></Panel>

          <Panel title="Calendario de mensualidades">
            <MsiTimelineChart rows={s.schedule} cards={activeCards} />
            <p className="mt-2 text-[11px] text-faint">Cada barra es lo que se te cobra por MSI en ese mes (por tarjeta). Cuando baja, es que terminó algún plan. Se calcula con el último estado de cuenta que importaste.</p>
          </Panel>

          <Panel title={`Tus planes vigentes · ${s.active.length}`}>
            <ul className="flex flex-col divide-y divide-line" data-testid="msi-plans">
              {s.active.map((p) => {
                const pct = Math.min(100, Math.round((p.paid / p.nTotal) * 100));
                return (
                  <li key={p.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{p.merchant}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                          <span className="inline-flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: colorOf.get(p.cardId) }} />{p.cardName}</span>
                          {p.withInterest && <span className="rounded-full bg-down/15 px-1.5 text-down">con intereses{p.ratePct ? ` ${p.ratePct.toFixed(0)}%` : ""}</span>}
                          {p.kind === "cash_advance" && <span className="rounded-full bg-white/10 px-1.5">disposición</span>}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="num font-medium">{formatMXN(p.monthlyCents)}<span className="text-[11px] font-normal text-muted"> /mes</span></p>
                        <p className="text-[11px] text-muted">debes {formatMXN(p.pendingNow, { compact: true })}</p>
                      </div>
                    </div>
                    <div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`${p.merchant}: ${p.paid} de ${p.nTotal} pagos`}>
                        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(pct, 3)}%` }} />
                      </div>
                      <p className="mt-1 flex justify-between gap-2 text-[11px] text-muted">
                        <span>Pago {p.paid} de {p.nTotal}</span>
                        <span>termina {dayLabel(p.endOn)} {p.endOn.slice(0, 4)}{p.nextBillOn ? ` · próximo cobro ${dayLabel(p.nextBillOn)}` : ""}</span>
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>

          <Panel title="Compras nuevas a MSI por mes">
            <MsiStartedChart rows={s.started} month={cur} />
            <p className="mt-2 text-[11px] text-faint">
              {started === 0 ? "Sin compras a MSI en los últimos 12 meses." : "Por mes de compra, solo de los planes que siguen vigentes en tus estados (los ya liquidados no aparecen, así que los meses más viejos se ven más bajos de lo real). En Banamex la fecha de compra se deduce del avance del plan."}
            </p>
          </Panel>

          {finished.length > 0 && (
            <Panel title={`Terminados · ${finished.length}`}>
              <ul className="flex flex-col gap-1.5 text-muted">
                {finished.map((p) => <li key={p.id} className="flex justify-between gap-3"><span className="truncate">{p.merchant} · {p.cardName}</span><span className="num shrink-0">{formatMXN(p.originalCents, { compact: true })}</span></li>)}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
