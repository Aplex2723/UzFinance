import Link from "next/link";
import { MonthNav } from "@/components/MonthNav";
import { TransactionsTable } from "@/components/TransactionsTable";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { listTransactions } from "@/lib/repo/transactions";
import { listQuery } from "@/lib/schemas";

const PAGE = 25;

export default async function Page({ searchParams }: PageProps<"/transacciones">) {
  await requirePageUser();
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = listQuery.safeParse(flat);
  const f = parsed.success ? parsed.data : {};
  const page = Math.max(1, Number(flat.page) || 1);
  const [cards, categories, { rows, total }] = await Promise.all([
    listCards(true), listCategories(),
    listTransactions({ q: f.q, cardId: f.card, categoryId: f.category, month: f.month, limit: PAGE, offset: (page - 1) * PAGE }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const qs = (p: number) => { const u = new URLSearchParams(flat as Record<string, string>); u.set("page", String(p)); return `/transacciones?${u}`; };

  return (
    <>
      <PageTitle title="Transacciones" subtitle={`${total.toLocaleString("es-MX")} movimientos`} action={f.month ? <MonthNav month={f.month} base="/transacciones" /> : undefined} />
      <Panel>
        <form method="get" className="mb-4 grid gap-2 sm:grid-cols-[1fr_160px_160px_150px_auto]" role="search" aria-label="Filtrar transacciones">
          <input name="q" defaultValue={f.q} placeholder="Buscar comercio o nota" className="field" aria-label="Buscar" maxLength={100} />
          <select name="card" defaultValue={f.card ?? ""} className="field" aria-label="Tarjeta"><option value="">Todas las tarjetas</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <select name="category" defaultValue={f.category ?? ""} className="field" aria-label="Categoría"><option value="">Todas las categorías</option><option value="none">Sin categoría</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input name="month" type="month" defaultValue={f.month ?? ""} className="field" aria-label="Mes" />
          <button className="btn btn-primary !h-[38px]">Filtrar</button>
        </form>
        <TransactionsTable rows={rows} />
        {pages > 1 && (
          <nav aria-label="Paginación" className="mt-4 flex items-center justify-between text-muted">
            {page > 1 ? <Link className="btn" href={qs(page - 1)}>Anterior</Link> : <span />}
            <span>Página {page} de {pages}</span>
            {page < pages ? <Link className="btn" href={qs(page + 1)}>Siguiente</Link> : <span />}
          </nav>
        )}
      </Panel>
    </>
  );
}
