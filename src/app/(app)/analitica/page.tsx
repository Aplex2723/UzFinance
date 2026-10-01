import { MonthNav } from "@/components/MonthNav";
import { PageTitle, Panel, Empty } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { getCategoryBreakdown, getMonthlyTrend } from "@/lib/repo/stats";
import { currentMonth, MONTH_RE } from "@/lib/time";

export default async function Page({ searchParams }: PageProps<"/analitica">) {
  await requirePageUser();
  const sp = await searchParams;
  const raw = typeof sp.month === "string" ? sp.month : "";
  const month = MONTH_RE.test(raw) ? raw : currentMonth();
  const [cats, trend] = await Promise.all([getCategoryBreakdown(month), getMonthlyTrend(12)]);
  const total = cats.reduce((a, c) => a + Math.max(c.cents, 0), 0);
  const maxTrend = Math.max(...trend.map((t) => t.cents), 1);
  return (
    <>
      <PageTitle title="Analítica" action={<MonthNav month={month} base="/analitica" />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Gasto por categoría · ${monthLabel(month)}`}>
          {cats.length === 0 ? <Empty>Sin gasto en este mes.</Empty> : (
            <ul className="flex flex-col gap-3">
              {cats.map((c) => (
                <li key={c.name}>
                  <div className="mb-1 flex justify-between"><span>{c.name} <span className="text-faint">· {c.count}</span></span><span className="num">{formatMXN(c.cents)} <span className="text-muted">({total > 0 ? ((c.cents / total) * 100).toFixed(0) : 0}%)</span></span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="img" aria-label={`${c.name}: ${total > 0 ? ((c.cents / total) * 100).toFixed(0) : 0}%`}><div className="h-full rounded-full" style={{ width: `${total > 0 ? Math.max((c.cents / total) * 100, 1) : 0}%`, background: c.color }} /></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Gasto mensual · últimos 12 meses">
          {trend.length === 0 ? <Empty>Sin historial.</Empty> : (
            <div className="flex h-[260px] items-end gap-1.5" role="img" aria-label="Gasto mensual de los últimos 12 meses">
              {trend.map((t) => (
                <div key={t.month} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5" title={`${monthLabel(t.month)}: ${formatMXN(t.cents)}`}>
                  <div className={`w-full rounded-lg ${t.month === month ? "bg-gradient-to-t from-[#8f1d00] to-accent" : "bg-white/[0.16]"}`} style={{ height: `${Math.max((t.cents / maxTrend) * 100, 3)}%` }} />
                  <span className="text-[9px] text-muted">{monthLabel(t.month, true).split(" ")[0]}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
