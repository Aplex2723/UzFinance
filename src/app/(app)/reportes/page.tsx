import { Download } from "lucide-react";
import { Delta } from "@/components/ui/Delta";
import { PageTitle, Panel, Empty } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import { getMonthlyTrend } from "@/lib/repo/stats";

export default async function Page() {
  await requirePageUser();
  const trend = (await getMonthlyTrend(12)).reverse();
  return (
    <>
      <PageTitle title="Reportes" subtitle="Resumen mensual y exportación a CSV." />
      <Panel>
        {trend.length === 0 ? <Empty>Sin datos todavía.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left">
              <thead className="text-[11px] text-muted"><tr><th className="py-2 font-normal">Mes</th><th className="text-right font-normal">Total</th><th className="text-right font-normal">vs. mes previo</th><th className="text-right font-normal">CSV</th></tr></thead>
              <tbody className="divide-y divide-line">
                {trend.map((t, i) => {
                  const prev = trend[i + 1]?.cents;
                  return (
                    <tr key={t.month}>
                      <td className="py-2.5 font-medium">{monthLabel(t.month)}</td>
                      <td className="num text-right">{formatMXN(t.cents)}</td>
                      <td className="text-right">{prev ? <Delta pct={((t.cents - prev) / prev) * 100} /> : <span className="text-faint">—</span>}</td>
                      <td className="text-right"><a className="btn !h-7 !px-2.5" href={`/api/reports/export?month=${t.month}`} download><Download size={12} aria-hidden /> Descargar</a></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
