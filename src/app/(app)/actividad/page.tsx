import { RecentActivity } from "@/components/RecentActivity";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listTransactions } from "@/lib/repo/transactions";

export default async function Page() {
  await requirePageUser();
  const { rows } = await listTransactions({ limit: 100 });
  return (
    <>
      <PageTitle title="Actividad" subtitle="Últimos 100 movimientos, con su fuente de ingreso." />
      <Panel><RecentActivity rows={rows} showSource /></Panel>
    </>
  );
}
