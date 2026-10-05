import Link from "next/link";
import { redirect } from "next/navigation";
import { PendingDim, TxFiltersProvider } from "@/components/transactions/TxFiltersProvider";
import { TxFilterBar, type FilterCard } from "@/components/transactions/TxFilterBar";
import { TxInsights } from "@/components/transactions/TxInsights";
import { TransactionsTable } from "@/components/TransactionsTable";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { getTransactionSummary, listCardFacets, listTransactions } from "@/lib/repo/transactions";
import { activeFilterCount, parseTxParams, serializeTxParams, todayLocal, viewToCriteria, type TxView } from "@/lib/tx-filters";

const PAGE = 25;
/** Tarjetas que no son una tarjeta de verdad: solo aparecen si tienen movimientos con los filtros actuales. */
const SYSTEM_CARDS = new Set(["Domiciliación", "Sin asignar"]);

const href = (v: Partial<TxView>, today: string) => {
  const qs = serializeTxParams(v, today).toString();
  return qs ? `/transacciones?${qs}` : "/transacciones";
};

export default async function Page({ searchParams }: PageProps<"/transacciones">) {
  await requirePageUser();
  const sp = await searchParams;
  const today = todayLocal();
  // La URL es la fuente de verdad. Los parámetros inválidos se ignoran (nunca rompen la página).
  const { view } = parseTxParams(sp, today);
  const criteria = viewToCriteria(view);
  const [cards, categories, { rows, total }, summary, facets] = await Promise.all([
    listCards(true),
    listCategories(),
    listTransactions({ ...criteria, limit: PAGE, offset: (view.page - 1) * PAGE }),
    getTransactionSummary(criteria, { today }),
    listCardFacets(criteria),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (view.page > pages) redirect(href({ ...view, page: 1 }, today)); // enlace viejo: la página ya no existe con estos filtros

  const chipCards: FilterCard[] = cards
    .map((c) => {
      const count = facets.get(c.id)?.count ?? 0;
      const muted: FilterCard["muted"] = SYSTEM_CARDS.has(c.name) ? "system" : c.active ? null : "inactive";
      return { id: c.id, name: c.name, issuer: c.issuer, last4: c.last4, color: c.color, art: c.art, muted, count };
    })
    // Activas siempre; inactivas y de sistema solo si tienen movimientos con estos filtros (o ya están elegidas).
    .filter((c) => !c.muted || c.count > 0 || view.cardIds.includes(c.id));
  const filtered = activeFilterCount(view) > 0;

  return (
    <>
      <PageTitle title="Transacciones" subtitle={`${total.toLocaleString("es-MX")} ${total === 1 ? "movimiento" : "movimientos"}${filtered ? " con los filtros actuales" : ""}`} />
      <nav aria-label="Tipo de movimiento" className="mb-3 flex gap-2">
        <Link href={href({ ...view, kind: "expense", page: 1 }, today)} className={`btn !h-10 ${view.kind !== "card_payment" ? "btn-primary" : ""}`} aria-current={view.kind !== "card_payment" ? "page" : undefined}>Gastos</Link>
        <Link href={href({ ...view, kind: "card_payment", page: 1 }, today)} className={`btn !h-10 ${view.kind === "card_payment" ? "btn-primary" : ""}`} aria-current={view.kind === "card_payment" ? "page" : undefined}>Pagos de tarjeta</Link>
      </nav>
      <TxFiltersProvider view={view} today={today}>
        <PendingDim><TxInsights summary={summary} view={view} today={today} /></PendingDim>
        <Panel>
          <TxFilterBar cards={chipCards} categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))} />
          <PendingDim>
            <TransactionsTable rows={rows} />
            {pages > 1 && (
              <nav aria-label="Paginación" className="mt-4 flex items-center justify-between text-muted">
                {view.page > 1 ? <Link className="btn !h-10" href={href({ ...view, page: view.page - 1 }, today)}>Anterior</Link> : <span />}
                <span>Página {view.page} de {pages}</span>
                {view.page < pages ? <Link className="btn !h-10" href={href({ ...view, page: view.page + 1 }, today)}>Siguiente</Link> : <span />}
              </nav>
            )}
          </PendingDim>
        </Panel>
      </TxFiltersProvider>
    </>
  );
}
