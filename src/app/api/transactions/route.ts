import { scheduleTransactionAlerts } from "@/lib/alerts/schedule";
import { json, protectedRoute, readJson } from "@/lib/api";
import { isDebitCard } from "@/lib/msi";
import { getCard } from "@/lib/repo/cards";
import { attachMsiPlan, MsiError } from "@/lib/repo/manual-msi";
import { createManual, listTransactions } from "@/lib/repo/transactions";
import { findSimilarExpenses } from "@/lib/repo/whatsapp";
import { listQuery, transactionSchema } from "@/lib/schemas";
import { localDate } from "@/lib/time";
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
  const at = new Date(b.date);
  const months = b.msi_months ?? null;
  if (months !== null) {
    if (b.amount <= 0) throw new HttpError(400, "Un reembolso no puede ir a meses sin intereses");
    const card = await getCard(b.card_id);
    if (!card) throw new HttpError(400, "Tarjeta inexistente");
    if (isDebitCard(card)) throw new HttpError(400, `${card.name} es de débito: no tiene meses sin intereses`);
    // Lo normal es que la compra ya haya llegado por el Atajo o el correo: en vez de duplicarla se ofrece pasar ESA a meses.
    if (!b.allow_duplicate) {
      const all = await findSimilarExpenses(card.id, b.amount, localDate(at), at);
      const same = all.find((x) => x.planId === null) ?? all[0];
      if (same) {
        const msi = same.planId !== null;
        return json({
          error: msi
            ? `Ya está registrada «${same.merchant}» a meses sin intereses por el mismo monto en esa tarjeta.`
            : `Ya está registrada «${same.merchant}» por el mismo monto en esa tarjeta. ¿Es la misma compra?`,
          similar: { id: same.id, merchant: same.merchant, amount_cents: same.amountCents, occurred_at: same.occurredAt.toISOString(), already_msi: msi },
        }, 409);
      }
    }
  }
  const r = await createManual({ occurredAt: at, amountCents: b.amount, merchant: b.merchant, cardId: b.card_id, categoryId: b.category_id, notes: b.notes });
  if (r.status === "duplicate") throw new HttpError(409, "Ya existe un movimiento idéntico");
  if (r.status !== "inserted") return json(r, 201);
  scheduleTransactionAlerts(r.id);
  if (months === null) return json(r, 201);
  try {
    const msi = await attachMsiPlan({ txId: r.id, cardId: b.card_id, categoryId: b.category_id, merchant: b.merchant, totalCents: b.amount, months, purchaseYmd: localDate(at) });
    return json({ ...r, msi: { months: msi.n, monthly_cents: msi.monthlyCents, estimated_dates: msi.guessed } }, 201);
  } catch (e) {
    // El gasto ya quedó guardado: se avisa y se puede pasar a meses desde Transacciones.
    console.error("[transactions] no se pudo crear el plan MSI:", ((e as Error)?.message ?? "").slice(0, 120));
    return json({ ...r, msi: null, msi_error: e instanceof MsiError ? e.message : "No pude crear el plan a meses; edítalo desde Transacciones" }, 201);
  }
});
