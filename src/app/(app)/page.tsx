import Link from "next/link";
import { CumulativeChart } from "@/components/charts/CumulativeChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { WeekdayBars } from "@/components/charts/WeekdayBars";
import { CardWallet } from "@/components/CardWallet";
import { DashboardActions } from "@/components/DashboardActions";
import { InsightList } from "@/components/insights/InsightList";
import { KpiTile } from "@/components/insights/Kpi";
import { GoalsOverviewPanel } from "@/components/goals/GoalsOverviewPanel";
import { MsiPanel } from "@/components/insights/MsiPanel";
import { PendingMerchants } from "@/components/PendingMerchants";
import { PaceBar } from "@/components/insights/PaceBar";
import { MonthNav } from "@/components/MonthNav";
import { RecentActivity } from "@/components/RecentActivity";
import { ReviewPanel } from "@/components/ReviewPanel";
import { Delta } from "@/components/ui/Delta";
import { Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listCards } from "@/lib/repo/cards";
import { listUnparsed } from "@/lib/repo/emails";
import { getMsi } from "@/lib/repo/plans";
import { getInsights } from "@/lib/repo/insights";
import { ISSUER_LABEL, monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { getCardSummaries, getCumulative, getHeatmap, getOverview, getSankey, getWeekdayTotals } from "@/lib/repo/stats";
import { listCategories } from "@/lib/repo/categories";
import { getGoalsOverview } from "@/lib/repo/goals-plan";
import { listTransactions, listUncategorizedMerchants } from "@/lib/repo/transactions";
import { currentMonth, MONTH_RE, prevMonth } from "@/lib/time";

export default async function Home({ searchParams }: PageProps<"/">) {
  await requirePageUser();
  const sp = await searchParams;
  const raw = typeof sp.month === "string" ? sp.month : undefined;
  const month = raw && MONTH_RE.test(raw) ? raw : currentMonth();

  const [overview, cards, cumulative, weekday, recent, sankey, heat, allCards, unparsed, payments, ins, msi, pendingMerchants, categories, goals] = await Promise.all([
    getOverview(month),
    getCardSummaries(month),
    getCumulative(month),
    getWeekdayTotals(month),
    listTransactions({ limit: 6 }),
    getSankey(month),
    getHeatmap(12),
    listCards(false),
    listUnparsed(),
    listTransactions({ kind: "card_payment", month, limit: 20 }),
    getInsights(month),
    getMsi(),
    listUncategorizedMerchants(8),
    listCategories(),
    getGoalsOverview(),
  ]);
  const paymentsTotal = payments.rows.reduce((a, r) => a + r.amount_cents, 0);

  return (
    <div className="flex flex-col gap-4">
      <ReviewPanel unnamed={allCards.filter((c) => c.needs_name)} unparsed={unparsed} />
      <section aria-labelledby="total-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 id="total-title" className="text-[12px] text-muted">Total gastado · {monthLabel(month)}</h1>
          <MonthNav month={month} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <p className="num text-[40px] font-semibold leading-none sm:text-5xl" data-testid="month-total">{formatMXN(overview.total)}</p>
          <Delta pct={overview.deltaPct} label="sin mes previo" />
        </div>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
          {overview.byIssuer.filter((i) => i.issuer === "amex" || i.issuer === "banamex" || i.cents !== 0 || i.prevCents !== 0).map((i) => (
            <span key={i.issuer} className="inline-flex items-center gap-1.5">
              {ISSUER_LABEL[i.issuer]}: <b className="num font-medium text-fg">{formatMXN(i.cents, { compact: true })}</b>
              <Delta pct={i.prevCents > 0 ? ((i.cents - i.prevCents) / i.prevCents) * 100 : null} label="" />
            </span>
          ))}
          <span className="text-faint">· vs. mismo periodo de {monthLabel(prevMonth(month), true)}</span>
        </p>
        <DashboardActions />
      </section>

      <PaceBar i={ins} />

      <section aria-label="Cifras clave" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Promedio por día"
          value={formatMXN(ins.avgPerDay, { compact: true })}
          sub={ins.prevAvgPerDay > 0 ? <span className="flex flex-wrap items-center gap-1"><Delta pct={((ins.avgPerDay - ins.prevAvgPerDay) / ins.prevAvgPerDay) * 100} label="" /> vs {formatMXN(ins.prevAvgPerDay, { compact: true })} el mes pasado</span> : "sin mes previo"}
          testId="avg-per-day"
        />
        <KpiTile
          label={ins.isCurrent ? "Proyección a fin de mes" : "Cierre del mes"}
          value={formatMXN(ins.projected, { compact: true })}
          tone={ins.income > 0 && ins.projected > ins.income ? "bad" : "default"}
          sub={ins.projectedPct !== null ? `${ins.projectedPct.toFixed(0)}% de tu ingreso` : "configura tu ingreso"}
          testId="projection"
        />
        <KpiTile
          label={ins.saved >= 0 ? "Ahorro del mes" : "Déficit del mes"}
          value={formatMXN(Math.abs(ins.saved), { compact: true })}
          tone={ins.income > 0 ? (ins.saved >= 0 ? "good" : "bad") : "default"}
          sub={ins.savedPct !== null ? `${ins.savedPct.toFixed(0)}% de tu ingreso${ins.isCurrent ? " hasta hoy" : ""}` : undefined}
          testId="saved"
        />
        <KpiTile
          label="Gasto promedio por compra"
          value={formatMXN(ins.avgTicket, { compact: true })}
          sub={`${ins.count} compras · ${ins.noSpendDays} día${ins.noSpendDays === 1 ? "" : "s"} sin gasto`}
        />
      </section>

      <GoalsOverviewPanel o={goals} />

      <CardWallet cards={cards.map((c) => ({ id: c.id, name: c.name, issuer: c.issuer, last4: c.last4, color: c.color, art: allCards.find((x) => x.id === c.id)?.art ?? null, cents: c.cents, prevCents: c.prevCents, deltaPct: c.deltaPct, spark: c.spark }))} />

      <Panel title="Insights del mes" action={<Link href={`/analitica${month === currentMonth() ? "" : `?month=${month}`}`} className="btn !h-7 !px-2.5 text-[11px]">Ver análisis</Link>}>
        <InsightList messages={ins.messages.slice(0, 4)} />
      </Panel>

      <MsiPanel s={msi} />

      <PendingMerchants merchants={pendingMerchants} categories={categories} />

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel title="Gasto acumulado: este mes vs. anterior">
          <CumulativeChart points={cumulative.points} cutoff={cumulative.cutoff} curLabel={monthLabel(month, true)} prevLabel={monthLabel(prevMonth(month), true)} />
        </Panel>
        <Panel title="Gasto por día de la semana">
          <WeekdayBars totals={weekday} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr] xl:grid-cols-[0.95fr_1.5fr_0.85fr]">
        <Panel title="Actividad reciente" action={<Link href="/actividad" className="btn !h-7 !px-2.5 text-[11px]">Ver todo</Link>}>
          <RecentActivity rows={recent.rows} />
        </Panel>
        <Panel title="Flujo: tarjeta → categoría">
          <SankeyChart data={sankey} />
        </Panel>
        <Panel title="Intensidad de gasto diario" className="lg:col-span-2 xl:col-span-1">
          <Heatmap cells={heat.cells} weeks={heat.weeks} />
        </Panel>
      </div>

      {payments.rows.length > 0 && (
        <Panel
          title={`Pagos de tarjeta · ${monthLabel(month)} (no cuentan como gasto)`}
          action={<Link href={`/transacciones?kind=card_payment&month=${month}`} className="btn !h-7 !px-2.5 text-[11px]">Ver todo</Link>}
          className="" 
        >
          <p className="mb-2 text-muted">Total pagado: <b className="num text-fg" data-testid="payments-total">{formatMXN(paymentsTotal)}</b></p>
          <RecentActivity rows={payments.rows.slice(0, 5)} />
        </Panel>
      )}
    </div>
  );
}
