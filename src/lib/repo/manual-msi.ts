import { query, t } from "@/lib/db/pool";
import { isDebitCard, MSI_MAX, MSI_MIN, newPlanTiming, validMsiMonths } from "@/lib/msi";
import { localDate } from "@/lib/time";
import { cardCutAnchor, upsertPlan } from "./plans";

/**
 * Compras a meses sin intereses capturadas a mano (bot de chat, formulario de la app, MCP). El gasto se guarda SIEMPRE a precio
 * completo, como cualquier compra; el plan (`installment_plans`, `source='manual'`) solo describe las mensualidades y se liga al gasto
 * por `transactions.plan_id`. Cuando llega el estado de cuenta, `upsertPlan` adopta este plan en vez de crear otro.
 */

export { isDebitCard, validMsiMonths };

export type MsiInfo = { n: number; monthlyCents: number; guessed: boolean; planId: number };

export class MsiError extends Error {}

/** Mensualidad redondeada (la última absorbe la diferencia en el banco; aquí solo es informativa). */
export const monthlyOf = (totalCents: number, n: number) => Math.round(totalCents / n);

/**
 * Crea el plan de un gasto YA guardado y lo liga, solo si el gasto aún no tiene plan (dos solicitudes simultáneas no ligan dos planes).
 * Lanza `MsiError` con un texto para la persona si no aplica. Si el gasto ya tenía plan, el plan recién creado se borra.
 */
export async function attachMsiPlan(p: { txId: number; cardId: number; categoryId: number | null; merchant: string; totalCents: number; months: number; purchaseYmd: string }): Promise<MsiInfo> {
  if (!validMsiMonths(p.months)) throw new MsiError(`Las compras a meses sin intereses son de ${MSI_MIN} a ${MSI_MAX} mensualidades`);
  if (!(p.totalCents > 0)) throw new MsiError("Solo un gasto (monto positivo) puede ir a meses");
  const monthly = monthlyOf(p.totalCents, p.months);
  // ¿El plan ya existe y nadie lo usa (p. ej. lo trajo el estado de cuenta antes de pasar el gasto a meses)? Se liga ese, no otro.
  const orphan = await query<{ id: number; monthly: number; as_of: string }>(
    `SELECT TOP 1 id, CAST(monthly_cents AS float) AS monthly, CONVERT(char(10), as_of, 23) AS as_of FROM dbo.installment_plans pl
     WHERE card_id=@c AND original_cents=@o AND n_total=@n AND kind='purchase' AND ABS(DATEDIFF(day, started_on, @start)) <= 45
       AND NOT EXISTS (SELECT 1 FROM dbo.transactions x WHERE x.plan_id = pl.id)
     ORDER BY ABS(DATEDIFF(day, started_on, @start)), id`,
    { c: t.int(p.cardId), o: t.big(p.totalCents), n: t.int(p.months), start: t.date(p.purchaseYmd) },
  );
  if (orphan[0]) {
    const id = Number(orphan[0].id);
    const linked = await query<{ id: number }>("UPDATE dbo.transactions SET plan_id=@p OUTPUT INSERTED.id WHERE id=@tx AND plan_id IS NULL", { p: t.int(id), tx: t.big(p.txId) });
    if (!linked.length) throw new MsiError("Ese movimiento ya está a meses sin intereses");
    return { n: p.months, monthlyCents: Number(orphan[0].monthly), guessed: false, planId: id };
  }
  const timing = newPlanTiming(p.purchaseYmd, await cardCutAnchor(p.cardId));
  const plan = await upsertPlan({
    cardId: p.cardId, categoryId: p.categoryId, merchant: p.merchant, kind: "purchase", withInterest: false, ratePct: 0,
    originalCents: p.totalCents, monthlyCents: monthly, pendingCents: p.totalCents - monthly, nTotal: p.months, nCurrent: 1,
    asOf: timing.asOf, startedOn: p.purchaseYmd, source: "manual", manualKey: `tx:${p.txId}`,
  });
  const linked = await query<{ id: number }>("UPDATE dbo.transactions SET plan_id=@p OUTPUT INSERTED.id WHERE id=@tx AND plan_id IS NULL", { p: t.int(plan.id), tx: t.big(p.txId) });
  if (!linked.length) {
    if (plan.status === "created") await query("DELETE dbo.installment_plans WHERE id=@p AND source='manual' AND NOT EXISTS (SELECT 1 FROM dbo.transactions WHERE plan_id=@p)", { p: t.int(plan.id) });
    throw new MsiError("Ese movimiento ya está a meses sin intereses");
  }
  return { n: p.months, monthlyCents: monthly, guessed: timing.guessed, planId: plan.id };
}

/** Pasa a MSI un gasto que ya existe (llegó por Atajo, correo, chat o a mano). */
export async function convertToMsi(txId: number, months: number): Promise<MsiInfo> {
  const r = await query<{ card_id: number; category_id: number | null; merchant_raw: string; cents: number; occurred_at: Date; kind: string; plan_id: number | null; card_name: string; art: string | null }>(
    `SELECT x.card_id, x.category_id, x.merchant_raw, CAST(x.amount_cents AS float) AS cents, x.occurred_at, x.kind, x.plan_id, c.name AS card_name, c.art
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id WHERE x.id=@id`,
    { id: t.big(txId) },
  );
  const x = r[0];
  if (!x) throw new MsiError("No encontré ese movimiento");
  if (x.kind !== "expense") throw new MsiError("Solo un gasto puede ir a meses");
  if (x.plan_id !== null) throw new MsiError("Ese movimiento ya está a meses sin intereses");
  if (isDebitCard({ name: x.card_name, art: x.art })) throw new MsiError(`${x.card_name} es de débito: no tiene meses sin intereses`);
  return attachMsiPlan({
    txId, cardId: Number(x.card_id), categoryId: x.category_id === null ? null : Number(x.category_id), merchant: x.merchant_raw,
    totalCents: Number(x.cents), months, purchaseYmd: localDate(x.occurred_at),
  });
}
