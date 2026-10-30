import { after } from "next/server";
import { AppShell } from "@/components/AppShell";
import { GlobalDialogs } from "@/components/GlobalDialogs";
import { LiveRefresh } from "@/components/LiveRefresh";
import { requirePageUser } from "@/lib/auth/page";
import { getEnv } from "@/lib/env";
import { listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { maybeRunPeriodicAlerts, unreadAlertCount } from "@/lib/repo/alerts";
import { pendingDocumentCount } from "@/lib/repo/documents";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  // Las alertas periódicas (ritmo, picos, meta) deben correr aunque pasen días sin compras: abrir la app las dispara.
  // Va DESPUÉS de responder y nunca lanza: no puede retrasar ni romper el render. Está limitada a una corrida cada ~15 min.
  after(() => maybeRunPeriodicAlerts().catch(() => {}));
  const [cards, categories, docs, alerts] = await Promise.all([
    listCards(true),
    listCategories(),
    pendingDocumentCount().catch(() => 0),
    unreadAlertCount().catch(() => 0),
  ]);
  return (
    <AppShell userEmail={user.email} badges={{ "/documentos": docs, "/alertas": alerts }} aiConfigured={!!getEnv().OPENROUTER_API_KEY}>
      {children}
      <GlobalDialogs cards={cards} categories={categories} />
      <LiveRefresh />
    </AppShell>
  );
}
