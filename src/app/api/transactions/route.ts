import { scheduleTransactionAlerts } from "@/lib/alerts/schedule";
import { json, protectedRoute, readJson } from "@/lib/api";
import { createManual, listTransactions } from "@/lib/repo/transactions";
import { listQuery, transactionSchema } from "@/lib/schemas";
import { HttpError } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async ({ req }) => {
  // `card` y `source` se pueden repetir (?card=1&card=2): Object.fromEntries se quedaría con el último.
  const sp = new URL(req.url).searchParams;
  const q = listQuery.parse({ ...Object.fromEntries(sp), card: sp.getAll("card"), source: sp.getAll("source") });
  return json(await listTransactions({
    q: q.q, cardIds: q.card?.length ? q.card : undefined, categoryId: q.category, month: q.month, from: q.from, to: q.to,
    sources: q.source?.length ? q.source : undefined, minCents: q.min, maxCents: q.max, unconfirmed: q.unconfirmed, msi: q.msi, recurring: q.recurring,
    sort: q.sort, kind: q.kind, limit: q.limit, offset: q.offset,
  }));
});

export const POST = protectedRoute(async ({ req }) => {
  const b = await readJson(req, transactionSchema);
  const r = await createManual({ occurredAt: new Date(b.date), amountCents: b.amount, merchant: b.merchant, cardId: b.card_id, categoryId: b.category_id, notes: b.notes });
  if (r.status === "duplicate") throw new HttpError(409, "Ya existe un movimiento idéntico");
  if (r.status === "inserted") scheduleTransactionAlerts(r.id);
  return json(r, 201);
});
