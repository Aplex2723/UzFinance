import { createHash } from "node:crypto";
import { query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import { summarize, type MsiSummary, type PlanLike } from "@/lib/msi";
import { localDate } from "@/lib/time";
import { getMonthlyIncome } from "./settings";

export type PlanInput = {
  cardId: number;
  categoryId?: number | null;
  merchant: string;
  kind?: "purchase" | "cash_advance";
  withInterest?: boolean;
  ratePct?: number | null;
  originalCents: number;
  monthlyCents: number;
  pendingCents: number;
  nTotal: number;
  nCurrent: number;
  /** YYYY-MM-DD del corte del estado. */
  asOf: string;
  /** YYYY-MM-DD de la compra. */
  startedOn: string;
  startedEstimated?: boolean;
  /** 'manual' = capturada a mano (p. ej. por el bot); el primer estado de cuenta que traiga la misma compra la adopta. */
  source?: "statement" | "manual";
};

/**
 * Identidad de un plan entre estados de cuenta: tarjeta + comercio + monto original + número de mensualidades
 * (la fecha no entra: Banamex no imprime la original). Dos compras idénticas el mismo día serían indistinguibles: caso raro.
 */
export function planKey(p: Pick<PlanInput, "cardId" | "merchant" | "originalCents" | "nTotal" | "kind">): string {
  return createHash("sha256").update(`${p.cardId}|${normalizeMerchant(p.merchant)}|${p.originalCents}|${p.nTotal}|${p.kind ?? "purchase"}`).digest("hex");
}

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Crea el plan o, si ya existe (mismo dedupe_key), lo actualiza salvo que lo guardado venga de un estado MÁS nuevo
 * (importar un estado viejo no retrocede el avance; el mismo corte se vuelve a aplicar sin daño). Devuelve el id y qué pasó.
 */
export async function upsertPlan(p: PlanInput): Promise<{ id: number; status: "created" | "updated" | "stale" }> {
  if (!validDate(p.asOf) || !validDate(p.startedOn)) throw new RangeError("fecha inválida");
  if (!(p.nTotal >= 1 && p.nCurrent >= 0 && p.nCurrent <= p.nTotal)) throw new RangeError("mensualidades inválidas");
  if (!(p.originalCents > 0 && p.monthlyCents >= 0 && p.pendingCents >= 0)) throw new RangeError("montos inválidos");
  const key = planKey(p);
  const existing = await query<{ id: number; as_of: Date }>("SELECT id, as_of FROM dbo.installment_plans WHERE dedupe_key=@k", { k: t.char(key) });
  if (!existing[0] && (p.source ?? "statement") === "statement") {
    // ¿Es la compra que ya se capturó a mano (bot)? Mismo plan aunque el comercio se llame distinto en el estado de cuenta: misma tarjeta,
    // monto original, número de mensualidades y una fecha de compra cercana. Se conserva el nombre que le puso la persona.
    const manual = await query<{ id: number }>(
      `SELECT TOP 1 id FROM dbo.installment_plans
       WHERE source='manual' AND card_id=@c AND original_cents=@o AND n_total=@n AND kind=@kind AND ABS(DATEDIFF(day, started_on, @start)) <= 45
       ORDER BY ABS(DATEDIFF(day, started_on, @start)), id`,
      { c: t.int(p.cardId), o: t.big(p.originalCents), n: t.int(p.nTotal), kind: t.varchar(p.kind ?? "purchase"), start: t.date(p.startedOn) },
    );
    if (manual[0]) {
      await query(
        `UPDATE dbo.installment_plans SET dedupe_key=@k, source='statement', monthly_cents=@mo, pending_cents=@pe, n_current=@nc, as_of=@asof, rate_pct=@rate,
           with_interest=@wi, updated_at=SYSUTCDATETIME() WHERE id=@id`,
        { id: t.int(manual[0].id), k: t.char(key), mo: t.big(p.monthlyCents), pe: t.big(p.pendingCents), nc: t.int(p.nCurrent), asof: t.date(p.asOf), rate: t.dec2(p.ratePct ?? null), wi: t.bit(!!p.withInterest) },
      );
      return { id: Number(manual[0].id), status: "updated" };
    }
  }
  if (existing[0]) {
    if (existing[0].as_of.toISOString().slice(0, 10) > p.asOf) return { id: existing[0].id, status: "stale" };
    await query(
      `UPDATE dbo.installment_plans SET monthly_cents=@mo, pending_cents=@pe, n_current=@nc, as_of=@asof, rate_pct=@rate,
         started_on = CASE WHEN started_estimated = 1 AND @est = 0 THEN @start ELSE started_on END,
         started_estimated = CASE WHEN started_estimated = 1 AND @est = 0 THEN 0 ELSE started_estimated END,
         updated_at = SYSUTCDATETIME()
       WHERE id=@id`,
      { id: t.int(existing[0].id), mo: t.big(p.monthlyCents), pe: t.big(p.pendingCents), nc: t.int(p.nCurrent), asof: t.date(p.asOf), rate: t.dec2(p.ratePct ?? null), start: t.date(p.startedOn), est: t.bit(!!p.startedEstimated) },
    );
    return { id: existing[0].id, status: "updated" };
  }
  const r = await query<{ id: number }>(
    `INSERT dbo.installment_plans (card_id, category_id, merchant, merchant_normalized, kind, with_interest, rate_pct, original_cents, monthly_cents, pending_cents,
                                   n_total, n_current, as_of, started_on, started_estimated, source, dedupe_key)
     OUTPUT INSERTED.id
     VALUES (@card, @cat, @m, @mn, @kind, @wi, @rate, @orig, @mo, @pe, @nt, @nc, @asof, @start, @est, @src, @k)`,
    {
      card: t.int(p.cardId), cat: t.int(p.categoryId ?? null), m: t.str(p.merchant.slice(0, 200)), mn: t.str(normalizeMerchant(p.merchant)),
      kind: t.varchar(p.kind ?? "purchase"), wi: t.bit(!!p.withInterest), rate: t.dec2(p.ratePct ?? null),
      orig: t.big(p.originalCents), mo: t.big(p.monthlyCents), pe: t.big(p.pendingCents), nt: t.int(p.nTotal), nc: t.int(p.nCurrent),
      asof: t.date(p.asOf), start: t.date(p.startedOn), est: t.bit(!!p.startedEstimated), src: t.varchar(p.source ?? "statement"), k: t.char(key),
    },
  );
  return { id: Number(r[0].id), status: "created" };
}

/** Liga una compra ya guardada a su plan de MSI. */
export async function linkTransactionPlan(txId: number, planId: number): Promise<void> {
  await query("UPDATE dbo.transactions SET plan_id=@p WHERE id=@tx", { p: t.int(planId), tx: t.big(txId) });
}

/** Un corte conocido de la tarjeta (fin de un estado conciliado o fecha de corte de un plan de estado de cuenta), el más reciente; null si no hay ninguno. */
export async function cardCutAnchor(cardId: number): Promise<string | null> {
  const r = await query<{ d: string | null }>(
    `SELECT TOP 1 CONVERT(char(10), d, 23) AS d FROM (
       SELECT period_end AS d FROM dbo.recon_runs WHERE card_id=@c
       UNION ALL SELECT as_of FROM dbo.installment_plans WHERE card_id=@c AND source='statement'
     ) x ORDER BY d DESC`,
    { c: t.int(cardId) },
  );
  return r[0]?.d ?? null;
}

type Row = {
  id: number; card_id: number; card_name: string; merchant: string; kind: "purchase" | "cash_advance"; with_interest: boolean | number;
  original_cents: number; monthly_cents: number; pending_cents: number; n_total: number; n_current: number; as_of: string; started_on: string;
  started_estimated: boolean | number; rate_pct: number | null; category_name: string | null;
};

export type PlanRow = PlanLike & { cardColor: string; issuer: string; startedEstimated: boolean; ratePct: number | null; categoryName: string | null };

export async function listPlans(): Promise<PlanRow[]> {
  const rows = await query<Row & { color: string; issuer: string }>(
    `SELECT p.id, p.card_id, c.name AS card_name, c.color, c.issuer, p.merchant, p.kind, p.with_interest,
            CAST(p.original_cents AS float) AS original_cents, CAST(p.monthly_cents AS float) AS monthly_cents, CAST(p.pending_cents AS float) AS pending_cents,
            p.n_total, p.n_current, CONVERT(char(10), p.as_of, 23) AS as_of, CONVERT(char(10), p.started_on, 23) AS started_on,
            p.started_estimated, CAST(p.rate_pct AS float) AS rate_pct, k.name AS category_name
     FROM dbo.installment_plans p JOIN dbo.cards c ON c.id = p.card_id LEFT JOIN dbo.categories k ON k.id = p.category_id
     ORDER BY p.started_on, p.id`,
  );
  return rows.map((r) => ({
    id: r.id, cardId: r.card_id, cardName: r.card_name, cardColor: r.color, issuer: r.issuer, merchant: r.merchant, kind: r.kind, withInterest: !!r.with_interest,
    originalCents: Number(r.original_cents), monthlyCents: Number(r.monthly_cents), pendingCents: Number(r.pending_cents), nTotal: r.n_total, nCurrent: r.n_current,
    asOf: r.as_of, startedOn: r.started_on, startedEstimated: !!r.started_estimated, ratePct: r.rate_pct, categoryName: r.category_name,
  }));
}

export type MsiData = MsiSummary<PlanRow> & { cards: { id: number; name: string; color: string }[]; byId: Record<number, PlanRow> };

export async function getMsi(now = new Date()): Promise<MsiData> {
  const [plans, income] = await Promise.all([listPlans(), getMonthlyIncome()]);
  const summary = summarize(plans, income, localDate(now));
  const cards = new Map<number, { id: number; name: string; color: string }>();
  for (const p of plans) cards.set(p.cardId, { id: p.cardId, name: p.cardName, color: p.cardColor });
  return { ...summary, cards: [...cards.values()], byId: Object.fromEntries(plans.map((p) => [p.id, p])) };
}
