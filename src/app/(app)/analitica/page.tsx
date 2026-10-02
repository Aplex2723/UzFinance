import { IncomeVsSpendChart } from "@/components/charts/IncomeVsSpendChart";
import { CategoryCompare } from "@/components/insights/CategoryCompare";
import { InsightList } from "@/components/insights/InsightList";
import { KpiTile } from "@/components/insights/Kpi";
import { PaceBar } from "@/components/insights/PaceBar";
import { MonthNav } from "@/components/MonthNav";
import { Delta } from "@/components/ui/Delta";
import { Empty, PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { getInsights } from "@/lib/repo/insights";
import { getCategoryBreakdown } from "@/lib/repo/stats";
import { currentMonth, MONTH_RE, prevMonth } from "@/lib/time";

export default async function Page({ searchParams }: PageProps<"/analitica">) {
  await requirePageUser();
  const sp = await searchParams;
  const raw = typeof sp.month === "string" ? sp.month : "";
  const month = MONTH_RE.test(raw) ? raw : currentMonth();
  const [cats, ins] = await Promise.all([getCategoryBreakdown(month), getInsights(month)]);
  const total = cats.reduce((a, c) => a + Math.max(c.cents, 0), 0);
  const last6 = ins.history.slice(-6).reverse();
  const maxMerchant = Math.max(...ins.topMerchants.map((m) => m.cents), 1);
  const prevName = monthLabel(prevMonth(month)).split(" ")[0].toLowerCase();

  return (
    <div className="flex flex-col gap-4">
      <PageTitle title="Analítica" subtitle="Tu gasto contra tu ingreso y contra los meses anteriores." action={<MonthNav month={month} base="/analitica" />} />

      <PaceBar i={ins} />

      <section aria-label="Cifras clave" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile label={`Gastado en ${monthLabel(month, true)}`} value={formatMXN(ins.spent, { compact: true })} sub={ins.usedPct !== null ? `${ins.usedPct.toFixed(0)}% del ingreso` : undefined} />
        <KpiTile label="Promedio por día" value={formatMXN(ins.avgPerDay, { compact: true })} sub={`${ins.elapsedDays} días ${ins.isCurrent ? "transcurridos" : "del mes"}`} />
        <KpiTile label={ins.isCurrent ? "Proyección a fin de mes" : "Cierre del mes"} value={formatMXN(ins.projected, { compact: true })} tone={ins.income > 0 && ins.projected > ins.income ? "bad" : "default"} sub={ins.projectedPct !== null ? `${ins.projectedPct.toFixed(0)}% del ingreso` : undefined} />
        <KpiTile label={ins.saved >= 0 ? "Ahorro" : "Déficit"} value={formatMXN(Math.abs(ins.saved), { compact: true })} tone={ins.income > 0 ? (ins.saved >= 0 ? "good" : "bad") : "default"} sub={ins.savedPct !== null ? `${ins.savedPct.toFixed(0)}% del ingreso` : undefined} />
      </section>

      <Panel title="Lo que hay que saber">
        <InsightList messages={ins.messages} />
      </Panel>

      <Panel title="Ingreso vs. gasto · últimos 12 meses">
        <IncomeVsSpendChart rows={ins.history} month={month} income={ins.income} />
        <p className="mt-2 text-[11px] text-faint">Se compara contra tu ingreso mensual actual. Las barras rojas son meses en que gastaste más de lo que ingresa.</p>
      </Panel>

      <Panel title="Comparación con meses anteriores">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left" data-testid="history-table">
            <thead>
              <tr className="text-[11px] text-muted">
                <th className="pb-2 font-medium">Mes</th>
                <th className="pb-2 text-right font-medium">Gasto</th>
                <th className="pb-2 text-right font-medium">% ingreso</th>
                <th className="pb-2 text-right font-medium">{`Ahorro`}</th>
                <th className="pb-2 text-right font-medium">Por día</th>
                <th className="pb-2 text-right font-medium">vs. anterior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {last6.map((r) => (
                <tr key={r.month} className={r.month === month ? "bg-white/[0.04]" : ""}>
                  <td className="py-2.5 pl-1">{monthLabel(r.month)}</td>
                  <td className="num py-2.5 text-right">{formatMXN(r.spent, { compact: true })}</td>
                  <td className="num py-2.5 text-right">{r.usedPct === null ? "—" : `${r.usedPct.toFixed(0)}%`}</td>
                  <td className={`num py-2.5 text-right ${r.income > 0 ? (r.saved >= 0 ? "text-up" : "text-down") : ""}`}>{r.income > 0 ? formatMXN(r.saved, { compact: true }) : "—"}</td>
                  <td className="num py-2.5 text-right">{formatMXN(r.avgPerDay, { compact: true })}</td>
                  <td className="py-2.5 pr-1 text-right"><Delta pct={r.deltaPct} label="—" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-faint">El mes en curso cuenta solo hasta hoy, así que su “vs. anterior” se ve bajo hasta que avanza el mes.</p>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Categorías: este mes vs. ${prevName}`}>
          <CategoryCompare rows={ins.categoryDeltas} prevLabel={prevName} />
        </Panel>
        <Panel title="Comercios donde más gastas">
          {ins.topMerchants.length === 0 ? <Empty>Sin gasto en este mes.</Empty> : (
            <ul className="flex flex-col gap-3">
              {ins.topMerchants.map((m) => (
                <li key={m.merchant}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="truncate">{m.merchant} <span className="text-faint">· {m.count}</span></span>
                    <span className="num shrink-0">{formatMXN(m.cents, { compact: true })}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max((m.cents / maxMerchant) * 100, 2)}%` }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title={`Gasto por categoría · ${monthLabel(month)}`}>
        {cats.length === 0 ? <Empty>Sin gasto en este mes.</Empty> : (
          <ul className="flex flex-col gap-3">
            {cats.map((c) => (
              <li key={c.name}>
                <div className="mb-1 flex justify-between gap-2"><span className="truncate">{c.name} <span className="text-faint">· {c.count}</span></span><span className="num shrink-0">{formatMXN(c.cents)} <span className="text-muted">({total > 0 ? ((c.cents / total) * 100).toFixed(0) : 0}%)</span></span></div>
                <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`${c.name}: ${total > 0 ? ((c.cents / total) * 100).toFixed(0) : 0}%`}><div className="h-full rounded-full" style={{ width: `${total > 0 ? Math.max((c.cents / total) * 100, 1) : 0}%`, background: c.color }} /></div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
