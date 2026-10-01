import { Plus } from "lucide-react";
import Link from "next/link";
import { CumulativeChart } from "@/components/charts/CumulativeChart";
import { Heatmap } from "@/components/charts/Heatmap";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { Sparkline } from "@/components/charts/Sparkline";
import { WeekdayBars } from "@/components/charts/WeekdayBars";
import { DashboardActions } from "@/components/DashboardActions";
import { MonthNav } from "@/components/MonthNav";
import { RecentActivity } from "@/components/RecentActivity";
import { Delta } from "@/components/ui/Delta";
import { Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { ISSUER_LABEL, monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { getCardSummaries, getCumulative, getHeatmap, getOverview, getSankey, getWeekdayTotals } from "@/lib/repo/stats";
import { listTransactions } from "@/lib/repo/transactions";
import { currentMonth, MONTH_RE, prevMonth } from "@/lib/time";

export default async function Home({ searchParams }: PageProps<"/">) {
  await requirePageUser();
  const sp = await searchParams;
  const raw = typeof sp.month === "string" ? sp.month : undefined;
  const month = raw && MONTH_RE.test(raw) ? raw : currentMonth();

  const [overview, cards, cumulative, weekday, recent, sankey, heat] = await Promise.all([
    getOverview(month),
    getCardSummaries(month),
    getCumulative(month),
    getWeekdayTotals(month),
    listTransactions({ limit: 6 }),
    getSankey(month),
    getHeatmap(12),
  ]);

  return (
    <div className="flex flex-col gap-4">
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
          {overview.byIssuer.filter((i) => i.issuer !== "other" || i.cents !== 0).map((i) => (
            <span key={i.issuer} className="inline-flex items-center gap-1.5">
              {ISSUER_LABEL[i.issuer]}: <b className="num font-medium text-fg">{formatMXN(i.cents, { compact: true })}</b>
              <Delta pct={i.prevCents > 0 ? ((i.cents - i.prevCents) / i.prevCents) * 100 : null} label="" />
            </span>
          ))}
          <span className="text-faint">· vs. mismo periodo de {monthLabel(prevMonth(month), true)}</span>
        </p>
        <DashboardActions />
      </section>

      <section aria-label="Tarjetas" className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4">
        {cards.map((c) => (
          <article key={c.id} className="glass flex min-w-[210px] flex-col justify-between gap-2 p-4" aria-label={c.name}>
            <header className="flex items-center gap-2 text-[12px]">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} aria-hidden />
              <span className="truncate font-medium">{c.name}</span>
              {c.last4 && <span className="ml-auto text-faint">•••• {c.last4}</span>}
            </header>
            <div className="flex items-end justify-between gap-2">
              <div>
                <p className="num text-2xl font-semibold">{formatMXN(c.cents, { compact: true })}</p>
                <div className="mt-1"><Delta pct={c.deltaPct} label="sin base" /></div>
              </div>
              <div className="w-[88px]"><Sparkline values={c.spark} label={c.name} color={c.deltaPct !== null && c.deltaPct > 0 ? "#ef4444" : "#22c55e"} /></div>
            </div>
          </article>
        ))}
        <Link href="/tarjetas?new=1" className="flex min-h-[112px] min-w-[210px] flex-col items-center justify-center gap-2 rounded-[18px] border border-dashed border-line text-center text-muted transition-colors hover:border-white/25 hover:text-fg">
          <Plus size={16} aria-hidden />
          <span className="max-w-[170px] text-[12px]">Agregar otra tarjeta a tu cuenta</span>
        </Link>
      </section>

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
    </div>
  );
}
