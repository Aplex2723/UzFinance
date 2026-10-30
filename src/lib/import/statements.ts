import { z } from "zod";
import type { Categorizer } from "@/lib/categorizer";
import { query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import { addMonthsIso } from "@/lib/msi";
import { createCard, listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { upsertPlan } from "@/lib/repo/plans";
import { ingestTransaction } from "@/lib/repo/transactions";
import type { Card, CardArtId } from "@/lib/types";

/**
 * Importa lo que extrae `scripts/statements` (estados de cuenta, movimientos del periodo y CSV) a la base.
 * Reglas (comprobadas en tests/integration/import.test.ts):
 *  - Cada COMPRA cuenta una sola vez, a su fecha y a precio completo (igual que el Atajo). Las mensualidades de MSI
 *    NO se guardan como gastos (la compra ya se contó): alimentan solo los planes (installment_plans).
 *  - Una compra nueva a MSI (mensualidad 1) que el estado solo muestra como plan se crea con su monto completo.
 *  - Pagos de tarjeta → kind card_payment (fuera de las estadísticas). Traspasos propios e ingresos no se guardan.
 *  - Lo que ya existe (Atajo, correo, estados importados antes) no se duplica: misma tarjeta + monto + ±2 días, por conteo.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TYPES = ["purchase", "fee", "interest", "payment", "installment", "installment_credit", "transfer_own", "transfer_out", "income", "domiciliation_card_payment", "domiciliation_other", "cash_withdrawal", "tax", "refund"] as const;
/** CSV de la app (Nu): "3 MSI" = compra nueva a 3 meses y el monto del renglón es la mensualidad del mes en curso. */
export const MSI_NEW_NOTE = "msi_new_purchase_installment_assumed";

const txSchema = z.looseObject({
  date: isoDate,
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  merchant: z.string().min(1).max(200),
  amount_cents: z.number().int(),
  type: z.enum(TYPES),
  holder: z.string().nullable().optional(),
  section: z.string().nullable().optional(),
  installment: z.object({ n: z.number().int().nullable(), total: z.number().int().nullable() }).nullable().optional(),
  pending: z.boolean().optional(),
  note: z.string().nullable().optional(),
  plan_ref: z.object({ merchant: z.string(), original_cents: z.number().int() }).nullable().optional(),
});
const planSchema = z.looseObject({
  merchant: z.string().min(1).max(200),
  original_cents: z.number().int().positive(),
  pending_cents: z.number().int().min(0),
  monthly_cents: z.number().int().min(0),
  n_current: z.number().int().min(0),
  n_total: z.number().int().min(1),
  rate_pct: z.union([z.string(), z.number()]).nullable().optional(),
  with_interest: z.boolean().optional(),
  op_date: isoDate.nullable().optional(),
  op_date_is_latest_installment: z.boolean().nullable().optional(),
  kind: z.enum(["purchase", "cash_advance", "auto_msi"]),
  holder: z.string().nullable().optional(),
});
export const docSchema = z.looseObject({
  document: z.string().min(1),
  card_key: z.string().min(1),
  period: z.object({ start: isoDate, end: isoDate }),
  as_of: isoDate,
  transactions: z.array(txSchema),
  plans: z.array(planSchema).default([]),
  checks: z.array(z.looseObject({ name: z.string(), ok: z.boolean() })).default([]),
});
export type StatementDoc = z.infer<typeof docSchema>;
type StatementTx = StatementDoc["transactions"][number];
type StatementPlan = StatementDoc["plans"][number];

const target = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1).max(60),
    create: z.object({ issuer: z.enum(["amex", "banamex", "nu", "other"]), last4: z.string().regex(/^\d{3,4}$/).nullable().optional(), aliases: z.string().max(300).nullable().optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), art: z.string().nullable().optional() }).optional(),
  }),
]);
type Target = z.infer<typeof target>;
/**
 * Para cada card_key: a qué tarjeta va cada movimiento. Cada destino es el NOMBRE de una tarjeta existente o
 * { name, create } para crearla si falta. Va en un archivo fuera del repo (lleva nombres de titulares).
 *   { "amex": { "default": "American Express Platinum", "holders": { "NOMBRE COMPLETO": { "name": "Amex Adicional · Ana", "create": { "issuer": "amex" } } } },
 *     "explora": { "default": "Explora Banamex ···046", "sections": { "digital": "Explora Banamex Virtual ···723" } },
 *     "debito": { "default": "Débito ···296", "domiciliation": "Domiciliación" } }
 */
export const cardMapSchema = z.record(z.string(), z.strictObject({ default: target, sections: z.record(z.string(), target).optional(), holders: z.record(z.string(), target).optional(), domiciliation: target.optional() }));
export type CardMap = z.infer<typeof cardMapSchema>;

/**
 * Correcciones tuyas a cómo se importa un movimiento concreto (archivo fuera del repo). Un movimiento coincide si cumple TODOS los
 * campos presentes. Ej.: { "date": "2026-09-28", "cents": 2000000, "merchant_contains": "DONATIVO", "category": "Deudas y préstamos", "merchant_as": "Pago de deuda personal" }
 */
export const overrideSchema = z.array(z.strictObject({
  date: isoDate.optional(),
  cents: z.number().int().optional(),
  merchant_contains: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  merchant_as: z.string().min(1).max(200).optional(),
  note: z.string().max(300).optional(),
}).refine((o) => o.date || o.cents || o.merchant_contains, "una corrección necesita al menos date, cents o merchant_contains"));
export type Overrides = z.infer<typeof overrideSchema>;

export type ImportStats = {
  document: string;
  inserted: number;
  existing: number;
  skipped: Record<string, number>;
  plansCreated: number;
  plansUpdated: number;
  plansStale: number;
  purchasesFromPlans: number;
  uncategorized: number;
  insertedCents: number;
};
export type ImportReport = { docs: ImportStats[]; cardsCreated: string[]; byCategory: Record<string, number>; warnings: string[] };

const CATEGORY_BY_TYPE: Partial<Record<StatementTx["type"], string>> = {
  fee: "Comisiones e intereses",
  interest: "Comisiones e intereses",
  tax: "Impuestos y gobierno",
  cash_withdrawal: "Efectivo",
  transfer_out: "Transferencias",
};

const dayMs = 86_400_000;
// CDMX no tiene horario de verano desde 2022: -06:00 fijo.
const at = (date: string, time?: string | null) => new Date(`${date}T${time ?? "12:00"}:00-06:00`);
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / dayMs;
const shiftDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);

export function pickTarget(map: CardMap, key: string, tx: { holder?: string | null; section?: string | null; type?: string }): Target {
  const m = map[key];
  if (!m) throw new Error(`Falta "${key}" en el mapa de tarjetas`);
  if (tx.holder && m.holders?.[tx.holder]) return m.holders[tx.holder];
  if (tx.section && m.sections?.[tx.section]) return m.sections[tx.section];
  // Domiciliaciones y pagos hechos desde la cuenta: se anotan en la tarjeta de sistema "Domiciliación" (igual que los correos).
  if ((tx.type === "domiciliation_other" || tx.type === "domiciliation_card_payment") && m.domiciliation) return m.domiciliation;
  return m.default;
}

type Candidate = {
  stat: ImportStats;
  card: Card;
  date: string;
  time: string | null;
  merchant: string;
  cents: number;
  kind: "expense" | "card_payment";
  categoryName?: string;
  notes?: string;
  planId?: number;
};
type PlanJob = {
  stat: ImportStats;
  doc: StatementDoc;
  card: Card;
  plan: StatementPlan;
  /** Corte del que salen los datos del plan (por omisión el del estado). */
  asOf: string;
  /** Compra de CSV (Nu "3 MSI"): el plan se liga a ese movimiento. */
  candidate?: Candidate;
};

const noteOf = (tx: StatementTx) => [tx.note && !/^ciudad:/i.test(tx.note) && tx.note !== MSI_NEW_NOTE ? tx.note : null, tx.pending ? "En proceso" : null].filter(Boolean).join(" · ") || undefined;

export async function importStatements(
  docs: StatementDoc[],
  cardMap: CardMap,
  opts: { categorizer: Categorizer; dryRun?: boolean; log?: (s: string) => void; overrides?: Overrides },
): Promise<ImportReport> {
  const dry = !!opts.dryRun;
  const log = opts.log ?? (() => {});
  const cards = await listCards(true);
  const cardsCreated: string[] = [];
  const warnings: string[] = [];
  const stats = new Map(docs.map((d) => [d.document, { document: d.document, inserted: 0, existing: 0, skipped: {}, plansCreated: 0, plansUpdated: 0, plansStale: 0, purchasesFromPlans: 0, uncategorized: 0, insertedCents: 0 } as ImportStats]));
  const skip = (st: ImportStats, why: string) => { st.skipped[why] = (st.skipped[why] ?? 0) + 1; };

  const resolved = new Map<string, Card>();
  const cardFor = async (doc: StatementDoc, tx: { holder?: string | null; section?: string | null; type?: string }): Promise<Card> => {
    const spec = pickTarget(cardMap, doc.card_key, tx);
    const name = typeof spec === "string" ? spec : spec.name;
    const hit = resolved.get(name) ?? cards.find((c) => c.name === name);
    if (hit) { resolved.set(name, hit); return hit; }
    if (typeof spec === "string" || !spec.create) throw new Error(`La tarjeta "${name}" no existe y el mapa no dice cómo crearla`);
    cardsCreated.push(name);
    const card: Card = dry
      ? { id: -cardsCreated.length, name, issuer: spec.create.issuer, last4: spec.create.last4 ?? null, aliases: null, color: "#6b7280", art: null, active: true, needs_name: false }
      : await createCard({ name, issuer: spec.create.issuer, last4: spec.create.last4 ?? null, aliases: spec.create.aliases ?? null, color: spec.create.color ?? "#6b7280", art: (spec.create.art as CardArtId | null | undefined) ?? null });
    cards.push(card);
    resolved.set(name, card);
    return card;
  };
  /** Último corte conocido de una tarjeta (de los estados, no de los CSV/movimientos). */
  const lastCut = (cardKey: string) => docs.filter((d) => d.card_key === cardKey && /_stmt$/.test(d.document)).map((d) => d.as_of).sort().at(-1);

  const cands: Candidate[] = [];
  const jobs: PlanJob[] = [];
  const overridesUsed = new Set<object>();

  for (const doc of docs) {
    const stat = stats.get(doc.document)!;
    const isStatement = /_stmt$/.test(doc.document);
    for (const tx of doc.transactions) {
      const card = await cardFor(doc, tx);
      const common = { stat, card, date: tx.date, time: tx.time ?? null, merchant: tx.merchant, notes: noteOf(tx) };
      // Compra nueva a MSI que solo se ve como "mensualidad 1": en un CSV de la app (Nu "3 MSI", monto completo asumido) o en
      // movimientos del periodo (Banamex "(001:003)": el monto completo es 3 × la mensualidad; el abono que la convierte lo confirma).
      let msiTotal: number | null = null;
      let fullCents = tx.amount_cents;
      const fromCsv = tx.note === MSI_NEW_NOTE && tx.installment?.n === 1 && !!tx.installment.total;
      const fromMovements = tx.type === "installment" && !isStatement && tx.installment?.n === 1 && (tx.installment.total ?? 0) > 1 && !tx.plan_ref;
      if ((tx.type === "installment" || tx.type === "installment_credit") && !fromCsv && !fromMovements) { skip(stat, "mensualidad MSI (va a planes)"); continue; }
      if (fromCsv || fromMovements) {
        const total = tx.installment!.total!;
        msiTotal = total;
        if (fromCsv) fullCents = tx.amount_cents * total;
        if (fromMovements) {
          const guess = tx.amount_cents * total;
          const credit = doc.transactions.find((x) => x.type === "installment_credit" && x.date === tx.date && Math.abs(Math.abs(x.amount_cents) - guess) <= total);
          fullCents = credit ? Math.abs(credit.amount_cents) : guess;
        }
      }
      if (tx.amount_cents === 0) { skip(stat, "monto cero"); continue; }
      if (tx.type === "transfer_own") { skip(stat, "traspaso propio"); continue; }
      if (tx.type === "income") { skip(stat, "ingreso"); continue; }
      if (tx.type === "payment" || tx.type === "domiciliation_card_payment") {
        cands.push({ ...common, cents: Math.abs(tx.amount_cents), kind: "card_payment" });
        continue;
      }
      const c: Candidate = {
        ...common, cents: fullCents, kind: "expense", categoryName: CATEGORY_BY_TYPE[tx.type],
        notes: msiTotal ? [common.notes, `Compra a ${msiTotal} meses sin intereses`].filter(Boolean).join(" · ") : common.notes,
      };
      for (const o of opts.overrides ?? []) {
        if ((o.date && o.date !== c.date) || (o.cents !== undefined && o.cents !== c.cents) || (o.merchant_contains && !normalizeMerchant(c.merchant).includes(normalizeMerchant(o.merchant_contains)))) continue;
        if (o.category) c.categoryName = o.category;
        if (o.merchant_as) c.merchant = o.merchant_as;
        if (o.note) c.notes = [c.notes, o.note].filter(Boolean).join(" · ");
        overridesUsed.add(o);
      }
      cands.push(c);
      if (msiTotal) {
        const cut = lastCut(doc.card_key);
        if (!cut) { warnings.push(`${doc.document}: compra a MSI sin estado de cuenta de ${doc.card_key} para fechar su plan`); continue; }
        const monthly = Math.round(fullCents / msiTotal);
        jobs.push({
          stat, doc, card, candidate: c, asOf: addMonthsIso(cut, 1),
          plan: { merchant: tx.merchant, original_cents: fullCents, pending_cents: fullCents - monthly, monthly_cents: monthly, n_current: 1, n_total: msiTotal, rate_pct: "0.00", with_interest: false, op_date: tx.date, kind: "purchase" },
        });
      }
    }
    if (isStatement) for (const plan of doc.plans) jobs.push({ stat, doc, plan, asOf: doc.as_of, card: await cardFor(doc, { holder: plan.holder, section: plan.holder }) });
  }

  // --- Planes (las compras nuevas a MSI que nacen de un plan se suman a los candidatos) ---
  for (const job of jobs) {
    const { doc, plan, card, stat } = job;
    if (plan.n_total === 1 && plan.monthly_cents === 0) { warnings.push(`${doc.document}: "${plan.merchant}" es un cargo diferido sin mensualidad (no se importa como plan)`); continue; }
    let startedOn = plan.op_date ?? doc.as_of;
    let estimated = false;
    // Banamex imprime la fecha de la ÚLTIMA mensualidad, no la de la compra: se deduce.
    if (plan.op_date_is_latest_installment && plan.n_current > 1) { startedOn = addMonthsIso(startedOn, -(plan.n_current - 1)); estimated = true; }
    let merchant = plan.merchant;
    // MSI "en automático" de Amex: el comercio real es la compra regular que se convirtió (mismo monto, hasta 45 días antes).
    if (plan.kind === "auto_msi") {
      const orig = doc.transactions.find((x) => x.type === "purchase" && x.amount_cents === plan.original_cents && plan.op_date && dayDiff(x.date, plan.op_date) <= 45);
      if (orig) { merchant = orig.merchant; startedOn = orig.date; estimated = false; }
    }
    let planId: number | undefined;
    if (dry) stat.plansCreated++;
    else {
      const cat = await opts.categorizer.categorizeDetailed({ merchantRaw: merchant, merchantNormalized: normalizeMerchant(merchant), amountCents: 0 });
      const r = await upsertPlan({
        cardId: card.id, categoryId: cat?.categoryId ?? null, merchant, kind: plan.kind === "cash_advance" ? "cash_advance" : "purchase",
        withInterest: !!plan.with_interest, ratePct: plan.rate_pct != null ? Number(plan.rate_pct) : null,
        originalCents: plan.original_cents, monthlyCents: plan.monthly_cents, pendingCents: plan.pending_cents,
        nTotal: plan.n_total, nCurrent: plan.n_current, asOf: job.asOf, startedOn, startedEstimated: estimated,
      });
      planId = r.id;
      if (r.status === "created") stat.plansCreated++; else if (r.status === "updated") stat.plansUpdated++; else stat.plansStale++;
    }
    if (job.candidate) job.candidate.planId = planId;
    // Primera mensualidad dentro del periodo, sin compra regular en el estado: la compra completa nace del plan.
    else if (plan.kind === "purchase" && plan.n_current === 1 && !estimated && startedOn >= doc.period.start) {
      cands.push({ stat, card, date: startedOn, time: null, merchant, cents: plan.original_cents, kind: "expense", planId, notes: `Compra a ${plan.n_total} meses${plan.with_interest ? "" : " sin intereses"}` });
      stat.purchasesFromPlans++;
    }
  }

  // --- Contra lo que ya existe: cada fila existente "consume" a lo más un movimiento (compras idénticas legítimas no se pierden) ---
  const existing = await loadExisting(cands);
  const used = new Map<number, ImportStats>();
  const toInsert: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => a.date.localeCompare(b.date))) {
    const hit = existing
      .filter((e) => !used.has(e.id) && e.kind === c.kind && e.cents === c.cents && (c.kind === "card_payment" ? dayDiff(e.date, c.date) <= 5 : e.cardId === c.card.id && dayDiff(e.date, c.date) <= 2))
      .sort((a, b) => dayDiff(a.date, c.date) - dayDiff(b.date, c.date))[0];
    if (hit) {
      used.set(hit.id, c.stat);
      c.stat.existing++;
      if (c.planId !== undefined && c.notes?.startsWith("Compra a")) c.stat.purchasesFromPlans = Math.max(0, c.stat.purchasesFromPlans - 1);
    } else if (c.kind === "card_payment" && (
      toInsert.some((x) => x.stat !== c.stat && x.kind === "card_payment" && x.cents === c.cents && dayDiff(x.date, c.date) <= 5)
      || existing.some((e) => e.kind === "card_payment" && e.cents === c.cents && dayDiff(e.date, c.date) <= 5 && used.get(e.id) !== undefined && used.get(e.id) !== c.stat)
    )) {
      // El mismo pago sale en el estado de la tarjeta ("pago en línea") y en el del débito (domiciliación): se guarda una vez,
      // tanto si el otro lado va en esta importación como si ya estaba guardado (al reimportar ambos, la fila existente sirve a los dos).
      c.stat.existing++;
    } else toInsert.push(c);
  }

  // --- Categorías: una consulta por comercio distinto, en paralelo (la memoria del categorizador evita repetir al insertar) ---
  const merchants = [...new Map(toInsert.filter((c) => c.kind === "expense" && !c.categoryName).map((c) => [normalizeMerchant(c.merchant), c.merchant])).entries()];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < merchants.length) {
      const [norm, raw] = merchants[next++];
      await opts.categorizer.categorizeDetailed({ merchantRaw: raw, merchantNormalized: norm, amountCents: 0 });
    }
  }));
  log(`comercios distintos categorizados: ${merchants.length}`);

  // --- Inserciones ---
  const categoryIdsByName = new Map((await listCategories()).map((c) => [c.name.toLowerCase(), c.id]));
  const seqCount = new Map<string, number>();
  for (const c of toInsert.sort((a, b) => a.date.localeCompare(b.date))) {
    // Dos movimientos idénticos el mismo día (tarjeta, monto, comercio) necesitan distinto hash.
    const k = `${c.card.id}|${c.date}|${c.cents}|${normalizeMerchant(c.merchant)}|${c.kind}`;
    const seq = seqCount.get(k) ?? 0;
    seqCount.set(k, seq + 1);
    if (dry) {
      c.stat.inserted++;
      if (c.kind === "expense") c.stat.insertedCents += c.cents;
      continue;
    }
    const r = await ingestTransaction(
      { merchant: c.merchant, amountCents: c.cents, cardRef: c.card.name, occurredAt: at(c.date, c.time), notes: c.notes, categoryName: c.categoryName, kind: c.kind, planId: c.planId, seq },
      "statement",
      { categorizer: opts.categorizer, categoryIdsByName, skipStatementMatch: true },
    );
    if (r.status === "inserted") {
      c.stat.inserted++;
      if (c.kind === "expense") {
        c.stat.insertedCents += c.cents;
        if (r.categoryId === null) c.stat.uncategorized++;
      }
    } else c.stat.existing++;
  }

  for (const o of opts.overrides ?? []) if (!overridesUsed.has(o)) warnings.push(`corrección sin coincidencias (no se aplicó): ${JSON.stringify(o)}`);
  const byCategory: Record<string, number> = {};
  if (!dry) {
    const rows = await query<{ name: string | null; n: number }>(
      `SELECT k.name, COUNT(*) AS n FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
       WHERE x.source = 'statement' AND x.kind = 'expense' GROUP BY k.name`,
    );
    for (const r of rows) byCategory[r.name ?? "(sin categoría)"] = r.n;
  }
  return { docs: [...stats.values()], cardsCreated, byCategory, warnings };
}

type Existing = { id: number; cardId: number; cents: number; date: string; kind: "expense" | "card_payment" };

async function loadExisting(cands: { date: string }[]): Promise<Existing[]> {
  if (!cands.length) return [];
  const dates = cands.map((c) => c.date).sort();
  const rows = await query<{ id: number; card_id: number; cents: number; d: string; kind: "expense" | "card_payment" }>(
    `SELECT id, card_id, CAST(amount_cents AS float) AS cents, CONVERT(char(10), occurred_date, 23) AS d, kind
     FROM dbo.transactions WHERE occurred_date BETWEEN @lo AND @hi`,
    { lo: t.date(shiftDay(dates[0], -6)), hi: t.date(shiftDay(dates.at(-1)!, 6)) },
  );
  return rows.map((r) => ({ id: Number(r.id), cardId: r.card_id, cents: Number(r.cents), date: r.d, kind: r.kind }));
}
