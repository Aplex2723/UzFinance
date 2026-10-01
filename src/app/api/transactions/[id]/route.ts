import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { deleteTransaction, getTransaction, updateTransaction } from "@/lib/repo/transactions";
import { idParam, transactionSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
type P = { id: string };

export const GET = protectedRoute<P>(async ({ params }) => {
  const tx = await getTransaction(idParam.parse(params.id));
  if (!tx) throw new HttpError(404, "No encontrado");
  return json(tx);
});

export const PUT = protectedRoute<P>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const b = await readJson(req, transactionSchema);
  let r;
  try {
    r = await updateTransaction(id, { occurredAt: new Date(b.date), amountCents: b.amount, merchant: b.merchant, cardId: b.card_id, categoryId: b.category_id, notes: b.notes });
  } catch (e) {
    if ((e as { number?: number }).number === 547) throw new HttpError(400, "Tarjeta o categoría inexistente");
    throw e;
  }
  if (r === "duplicate") throw new HttpError(409, "Ya existe un movimiento idéntico");
  if (!r) throw new HttpError(404, "No encontrado");
  return json(await getTransaction(id));
});

export const DELETE = protectedRoute<P>(async ({ params }) => {
  if (!(await deleteTransaction(idParam.parse(params.id)))) throw new HttpError(404, "No encontrado");
  return json({ ok: true });
});
