import { AlertSettings } from "@/components/alerts/AlertSettings";
import { AlertsList } from "@/components/alerts/AlertsList";
import { PageTitle } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { getAlertConfig, listAlerts } from "@/lib/repo/alerts";
import { listCategories } from "@/lib/repo/categories";
import { getTransactionBriefs } from "@/lib/repo/tx-lookup";

export default async function Page() {
  await requirePageUser();
  const [alerts, config, categories] = await Promise.all([listAlerts({ limit: 100 }), getAlertConfig(), listCategories()]);
  const txs = Object.fromEntries((await getTransactionBriefs(alerts.flatMap((a) => (a.txId ? [a.txId] : [])))).map((b) => [b.id, b]));
  return (
    <>
      <PageTitle title="Alertas" subtitle="Avisos de gasto fuerte, ritmo, duplicados y diferencias con tus estados de cuenta." />
      <div className="grid items-start gap-4 lg:grid-cols-[1.1fr_1fr]">
        <AlertsList alerts={alerts} txs={txs} />
        <AlertSettings config={config} categories={categories} />
      </div>
    </>
  );
}
