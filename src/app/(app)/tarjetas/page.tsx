import { Suspense } from "react";
import { CardsManager } from "@/components/CardsManager";
import { PageTitle } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listCards } from "@/lib/repo/cards";

export default async function Page() {
  await requirePageUser();
  return (
    <>
      <PageTitle title="Tarjetas" subtitle="Los alias deben coincidir con el nombre que Wallet manda en el Atajo." />
      <Suspense><CardsManager cards={await listCards(true)} /></Suspense>
    </>
  );
}
