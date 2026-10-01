import { PageTitle, Panel, Empty } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { formatMXN } from "@/lib/money";
import { getRecurring } from "@/lib/repo/stats";

export default async function Page() {
  await requirePageUser();
  const rows = await getRecurring();
  const monthly = rows.reduce((a, r) => a + r.avgCents, 0);
  return (
    <>
      <PageTitle title="Recurrentes" subtitle="Comercios con cargos en 3+ de los últimos 6 meses y monto estable (±25%)." />
      <Panel title={`Costo mensual estimado: ${formatMXN(monthly)}`}>
        {rows.length === 0 ? <Empty>Aún no hay suficiente historial para detectar cargos recurrentes.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left">
              <thead className="text-[11px] text-muted"><tr><th className="py-2 font-normal">Comercio</th><th className="font-normal">Tarjeta</th><th className="font-normal">Meses</th><th className="font-normal">Último cargo</th><th className="text-right font-normal">Promedio</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={`${r.merchant}-${r.card}`}><td className="py-2.5 font-medium">{r.merchant}</td><td className="text-muted">{r.card}</td><td>{r.months}</td><td className="text-muted">{r.last}</td><td className="num text-right">{formatMXN(r.avgCents)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
