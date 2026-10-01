import { json, parseQuery, protectedRoute, readJson } from "@/lib/api";
import { createManual, listTransactions } from "@/lib/repo/transactions";
import { listQuery, transactionSchema } from "@/lib/schemas";
import { HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async ({ req }) => {
  const q = parseQuery(req, listQuery);
  return json(await listTransactions({ q: q.q, cardId: q.card, categoryId: q.category, month: q.month, limit: q.limit, offset: q.offset }));
});

export const POST = protectedRoute(async ({ req }) => {
  const b = await readJson(req, transactionSchema);
  const r = await createManual({ occurredAt: new Date(b.date), amountCents: b.amount, merchant: b.merchant, cardId: b.card_id, categoryId: b.category_id, notes: b.notes });
  if (r.status === "duplicate") throw new HttpError(409, "Ya existe un movimiento idéntico");
  return json(r, 201);
});
