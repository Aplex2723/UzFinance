import { AppShell } from "@/components/AppShell";
import { GlobalDialogs } from "@/components/GlobalDialogs";
import { LiveRefresh } from "@/components/LiveRefresh";
import { requirePageUser } from "@/lib/auth/page";
import { listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const [cards, categories] = await Promise.all([listCards(true), listCategories()]);
  return (
    <AppShell userEmail={user.email}>
      {children}
      <GlobalDialogs cards={cards} categories={categories} />
      <LiveRefresh />
    </AppShell>
  );
}
