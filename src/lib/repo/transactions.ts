import { createHash } from "node:crypto";
import { getCategorizer, type Categorization, type Categorizer } from "@/lib/categorizer";
import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import type { RawTransaction } from "@/lib/sources/types";
import { localDate } from "@/lib/time";
import type { Source, Transaction } from "@/lib/types";
import { resolveCard } from "./cards";
import { listCategories } from "./categories";

const SELECT = `
  SELECT x.id, x.occurred_at, CONVERT(char(10), x.occurred_date, 23) AS occurred_date,
         CAST(x.amount_cents AS float) AS amount_cents, x.currency, x.merchant_raw, x.merchant_normalized,
         x.card_id, c.name AS card_name, c.issuer, x.category_id, k.name AS category_name, k.color AS category_color,
         x.source, x.notes, x.kind, x.is_recurring, x.sources, x.auth_code, x.account_ref,
         x.category_source, CAST(x.category_confidence AS float) AS category_confidence, x.plan_id,
         CAST(CASE WHEN c.issuer = 'banamex' AND x.kind = 'expense' AND x.sources = 'shortcut'
                    AND x.occurred_at < DATEADD(hour, -24, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS bit) AS unconfirmed
  FROM dbo.transactions x
  JOIN dbo.cards c ON c.id = x.card_id
  LEFT JOIN dbo.categories k ON k.id = x.category_id`;

type Row = Omit<Transaction, "occurred_at" | "is_recurring" | "unconfirmed"> & { occurred_at: Date; is_recurring: boolean | number; unconfirmed: boolean | number };
const map = (r: Row): Transaction => ({ ...r, occurred_at: r.occurred_at.toISOString(), is_recurring: !!r.is_recurring, unconfirmed: !!r.unconfirmed });

export type TxFilter = {
  q?: string;
  cardId?: number;
  categoryId?: number | "none";
  /** Por defecto solo gastos: los pagos de tarjeta no cuentan como gasto. */
  kind?: "expense" | "card_payment" | "all";
  month?: string; // YYYY-MM
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export async function listTransactions(f: TxFilter = {}): Promise<{ rows: Transaction[]; total: number }> {
  const where: string[] = [f.kind === "all" ? "1=1" : `x.kind = '${f.kind === "card_payment" ? "card_payment" : "expense"}'`];
  const params: Record<string, ReturnType<(typeof t)[keyof typeof t]>> = {};
  if (f.q) {
    where.push("(x.merchant_normalized LIKE @q ESCAPE '\\' OR x.merchant_raw LIKE @q ESCAPE '\\' OR x.notes LIKE @q ESCAPE '\\')");
    params.q = t.str(`%${f.q.replace(/[\\%_[]/g, "\\$&")}%`);
  }
  if (f.cardId) { where.push("x.card_id = @card"); params.card = t.int(f.cardId); }
  if (f.categoryId === "none") where.push("x.category_id IS NULL");
  else if (f.categoryId) { where.push("x.category_id = @cat"); params.cat = t.int(f.categoryId); }
  if (f.month) {
    where.push("x.occurred_date >= @mfrom AND x.occurred_date < DATEADD(month, 1, @mfrom)");
    params.mfrom = t.date(`${f.month}-01`);
  }
  if (f.from) { where.push("x.occurred_date >= @from"); params.from = t.date(f.from); }
  if (f.to) { where.push("x.occurred_date <= @to"); params.to = t.date(f.to); }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const w = where.join(" AND ");
  const [rows, total] = await Promise.all([
    query<Row>(`${SELECT} WHERE ${w} ORDER BY x.occurred_at DESC, x.id DESC OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`, {
      ...params, off: t.int(offset), lim: t.int(limit),
    }),
    query<{ n: number }>(`SELECT COUNT(*) AS n FROM dbo.transactions x WHERE ${w}`, params),
  ]);
  return { rows: rows.map(map), total: total[0].n };
}

export async function getTransaction(id: number): Promise<Transaction | null> {
  const r = await query<Row>(`${SELECT} WHERE x.id = @id`, { id: t.int(id) });
  return r[0] ? map(r[0]) : null;
}

/**
 * Hash de deduplicación. Atajo/manual/correo: tarjeta + minuto + monto + comercio.
 * Estado de cuenta (solo trae día): tarjeta + día + monto + comercio.
 */
export function dedupeHash(p: { cardId: number; occurredAt: Date; cents: number; merchantNormalized: string; source: Source; seq?: number }): string {
  const when = p.source === "statement" ? localDate(p.occurredAt) : p.occurredAt.toISOString().slice(0, 16);
  // seq distingue dos compras idénticas del mismo día en un estado de cuenta; con 0 el hash es el de siempre.
  return createHash("sha256").update(`${p.cardId}|${when}|${p.cents}|${p.merchantNormalized}${p.seq ? `|#${p.seq}` : ""}`).digest("hex");
}

export type IngestResult =
  | { status: "inserted"; id: number; cardMatched: boolean; categoryId: number | null }
  | { status: "merged"; id: number; cardMatched: boolean }
  | { status: "duplicate"; cardMatched: boolean };

/** Ventana de fusión Atajo ↔ correo. */
export const MERGE_WINDOW_SECONDS = 15 * 60;

export async function ingestTransaction(
  raw: RawTransaction,
  source: Source,
  deps: { categorizer: Categorizer; categoryIdsByName?: Map<string, number>; /** El llamador ya comparó contra lo existente (importador de estados). */ skipStatementMatch?: boolean },
): Promise<IngestResult> {
  const merchantNormalized = normalizeMerchant(raw.merchant);
  const { card, matched } = await resolveCard(raw.cardRef);
  const hash = dedupeHash({ cardId: card.id, occurredAt: raw.occurredAt, cents: raw.amountCents, merchantNormalized, source, seq: raw.seq });
  const occurredDate = localDate(raw.occurredAt);

  // Reintento de un Atajo que ya se fusionó con su correo: no crea otra fila.
  if (source === "shortcut") {
    const seen = await query("SELECT TOP 1 tx_id FROM dbo.merged_hashes WHERE hash=@h", { h: t.char(hash) });
    if (seen.length) return { status: "duplicate", cardMatched: matched };

    // Correo → Atajo: si el correo del banco llegó primero, el Atajo solo se anota como segunda fuente.
    const mail = await query<{ id: number }>(
      `SELECT TOP 1 id FROM dbo.transactions
       WHERE card_id=@c AND amount_cents=@a AND kind='expense' AND email_message_id IS NOT NULL AND sources NOT LIKE '%shortcut%'
         AND ABS(DATEDIFF(second, occurred_at, @at)) <= @win
       ORDER BY ABS(DATEDIFF(second, occurred_at, @at)), id`,
      { c: t.int(card.id), a: t.big(raw.amountCents), at: t.dt(raw.occurredAt), win: t.int(MERGE_WINDOW_SECONDS) },
    );
    if (mail[0]) {
      const id = Number(mail[0].id);
      try {
        await query("INSERT dbo.merged_hashes (hash, tx_id) VALUES (@h, @id)", { h: t.char(hash), id: t.big(id) });
      } catch (e) {
        if (isUniqueViolation(e)) return { status: "duplicate", cardMatched: matched };
        throw e;
      }
      await query("UPDATE dbo.transactions SET sources = LEFT(sources + ',shortcut', 40) WHERE id=@id", { id: t.big(id) });
      return { status: "merged", id, cardMatched: matched };
    }
  }

  if (source === "statement" && !deps.skipStatementMatch) {
    // El comercio del estado de cuenta rara vez coincide con el de Wallet:
    // si ya hay un movimiento no-estado con misma tarjeta, día y monto, se omite.
    const probable = await query(
      "SELECT TOP 1 id FROM dbo.transactions WHERE card_id=@c AND occurred_date=@d AND amount_cents=@a AND source <> 'statement' AND kind=@k",
      { c: t.int(card.id), d: t.date(occurredDate), a: t.big(raw.amountCents), k: t.varchar(raw.kind ?? "expense") },
    );
    if (probable.length) return { status: "duplicate", cardMatched: matched };
  }

  // Si la tarjeta no se reconoce, se guarda el texto recibido para poder crear el alias correcto.
  const notes = matched ? raw.notes ?? null : [`Tarjeta sin reconocer: "${raw.cardRef}"`, raw.notes].filter(Boolean).join(" · ").slice(0, 500);

  const explicit = raw.categoryName ? deps.categoryIdsByName?.get(raw.categoryName.toLowerCase()) ?? null : null;
  const kind = raw.kind ?? "expense";
  // Los pagos de tarjeta no se categorizan (no son gasto). El categorizador recibe SOLO el comercio, nunca monto ni tarjeta.
  const cat: Categorization | null =
    explicit !== null
      ? { categoryId: explicit, source: "rule", confidence: null }
      : kind === "expense"
        ? await deps.categorizer.categorizeDetailed({ merchantRaw: raw.merchant, merchantNormalized, amountCents: raw.amountCents })
        : null;
  const categoryId = cat?.categoryId ?? null;

  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, category_source, category_confidence, plan_id, kind, source, sources, dedupe_hash, notes)
       OUTPUT INSERTED.id
       VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, @csrc, @cconf, @plan, @kind, @src, @src, @hash, @notes)`,
      {
        at: t.dt(raw.occurredAt), date: t.date(occurredDate), amt: t.big(raw.amountCents),
        raw: t.str(raw.merchant), norm: t.str(merchantNormalized), card: t.int(card.id), cat: t.int(categoryId),
        csrc: t.varchar(cat?.source ?? null), cconf: t.dec(cat?.confidence ?? null), plan: t.int(raw.planId ?? null), kind: t.varchar(kind),
        src: t.varchar(source), hash: t.char(hash), notes: t.str(notes),
      },
    );
    return { status: "inserted", id: Number(r[0].id), cardMatched: matched, categoryId };
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "duplicate", cardMatched: matched };
    throw e;
  }
}

export async function ingestMany(rows: RawTransaction[], source: Source) {
  const categorizer = await getCategorizer();
  const categoryIdsByName = new Map((await listCategories()).map((c) => [c.name.toLowerCase(), c.id]));
  let inserted = 0;
  let duplicates = 0;
  for (const raw of rows) {
    const r = await ingestTransaction(raw, source, { categorizer, categoryIdsByName });
    if (r.status === "inserted") inserted++;
    else duplicates++;
  }
  return { inserted, duplicates };
}

export type TxPatch = {
  occurredAt: Date;
  amountCents: number;
  merchant: string;
  cardId: number;
  categoryId: number | null;
  notes: string | null;
};

export async function createManual(p: TxPatch): Promise<IngestResult> {
  const merchantNormalized = normalizeMerchant(p.merchant);
  const hash = dedupeHash({ cardId: p.cardId, occurredAt: p.occurredAt, cents: p.amountCents, merchantNormalized, source: "manual" });
  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, category_source, source, sources, dedupe_hash, notes)
       OUTPUT INSERTED.id VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, @csrc, 'manual', 'manual', @hash, @notes)`,
      {
        at: t.dt(p.occurredAt), date: t.date(localDate(p.occurredAt)), amt: t.big(p.amountCents), raw: t.str(p.merchant),
        norm: t.str(merchantNormalized), card: t.int(p.cardId), cat: t.int(p.categoryId), csrc: t.varchar(p.categoryId === null ? null : "manual"),
        hash: t.char(hash), notes: t.str(p.notes),
      },
    );
    return { status: "inserted", id: Number(r[0].id), cardMatched: true, categoryId: p.categoryId };
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "duplicate", cardMatched: true };
    throw e;
  }
}

export async function updateTransaction(id: number, p: TxPatch): Promise<boolean | "duplicate"> {
  const merchantNormalized = normalizeMerchant(p.merchant);
  const current = await query<{ source: Source }>("SELECT source FROM dbo.transactions WHERE id=@id", { id: t.int(id) });
  if (!current[0]) return false;
  const hash = dedupeHash({ cardId: p.cardId, occurredAt: p.occurredAt, cents: p.amountCents, merchantNormalized, source: current[0].source });
  try {
    const r = await query(
      `UPDATE dbo.transactions SET occurred_at=@at, occurred_date=@date, amount_cents=@amt, merchant_raw=@raw, merchant_normalized=@norm,
         card_id=@card, notes=@notes, dedupe_hash=@hash,
         -- Cambiar la categoría a mano la vuelve "manual" (y alimenta el historial); si no cambió, conserva su origen.
         category_source = CASE WHEN @cat IS NULL THEN NULL WHEN category_id = @cat THEN category_source ELSE 'manual' END,
         category_confidence = CASE WHEN @cat IS NULL OR category_id <> @cat THEN NULL ELSE category_confidence END,
         category_id=@cat
         OUTPUT INSERTED.id WHERE id=@id`,
      {
        id: t.int(id), at: t.dt(p.occurredAt), date: t.date(localDate(p.occurredAt)), amt: t.big(p.amountCents), raw: t.str(p.merchant),
        norm: t.str(merchantNormalized), card: t.int(p.cardId), cat: t.int(p.categoryId), notes: t.str(p.notes), hash: t.char(hash),
      },
    );
    return r.length > 0;
  } catch (e) {
    if (isUniqueViolation(e)) return "duplicate";
    throw e;
  }
}

export async function deleteTransaction(id: number): Promise<boolean> {
  return (await query("DELETE dbo.transactions OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) })).length > 0;
}

/** Aplica las reglas actuales a todo lo que no tiene categoría ("Categorizar"). */
export async function categorizeUncategorized(): Promise<{ updated: number; remaining: number }> {
  // Aquí no hay un Atajo esperando: se le da más tiempo a Jev (el mismo comercio se consulta una sola vez por tanda).
  const categorizer = await getCategorizer({ timeoutMs: 15_000 });
  const rows = await query<{ id: number; merchant_normalized: string; merchant_raw: string; amount_cents: number }>(
    "SELECT TOP 5000 id, merchant_normalized, merchant_raw, CAST(amount_cents AS float) AS amount_cents FROM dbo.transactions WHERE category_id IS NULL AND kind = 'expense'",
  );
  let updated = 0;
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      const cat = await categorizer.categorizeDetailed({ merchantRaw: r.merchant_raw, merchantNormalized: r.merchant_normalized, amountCents: r.amount_cents });
      if (cat) {
        await query(
          "UPDATE dbo.transactions SET category_id=@c, category_source=@s, category_confidence=@f WHERE id=@id AND category_id IS NULL",
          { c: t.int(cat.categoryId), s: t.varchar(cat.source), f: t.dec(cat.confidence), id: t.int(Number(r.id)) },
        );
        updated++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return { updated, remaining: rows.length - updated };
}

/**
 * Huella de la tabla de movimientos (altas, ediciones y bajas cambian el valor).
 * Una sola consulta agregada: suficiente para datos personales.
 */
export async function getChangeRevision(): Promise<string> {
  const r = await query<{ n: number; m: number; h: number; u: number; c: number; i: number | null }>(
    `SELECT COUNT_BIG(*) AS n, CAST(ISNULL(MAX(id), 0) AS float) AS m,
            CAST(ISNULL(CHECKSUM_AGG(CHECKSUM(id, amount_cents, category_id, card_id, occurred_at, merchant_raw, kind, sources)), 0) AS float) AS h,
            (SELECT COUNT_BIG(*) FROM dbo.unparsed_emails) AS u,
            (SELECT COUNT_BIG(*) FROM dbo.cards WHERE needs_name = 1) AS c,
            (SELECT CAST(ISNULL(CHECKSUM_AGG(CHECKSUM(value)), 0) AS bigint) + CAST(ISNULL((SELECT CHECKSUM_AGG(CHECKSUM(saved_cents, target_cents, target_date, name)) FROM dbo.savings_goals), 0) AS bigint) FROM dbo.app_settings) AS i
     FROM dbo.transactions`,
  );
  return `${r[0].n}-${r[0].m}-${r[0].h}-${r[0].u}-${r[0].c}-${r[0].i ?? 0}`;
}

export type PendingMerchant = { merchant: string; sample: string; count: number; cents: number };

/** Comercios con gasto sin categoría, de mayor a menor monto (para asignarles categoría de una vez por comercio). */
export async function listUncategorizedMerchants(limit = 12): Promise<PendingMerchant[]> {
  const rows = await query<{ merchant: string; sample: string; n: number; cents: number }>(
    `SELECT TOP (@lim) merchant_normalized AS merchant, MIN(merchant_raw) AS sample, COUNT(*) AS n, CAST(SUM(amount_cents) AS float) AS cents
     FROM dbo.transactions WHERE category_id IS NULL AND kind = 'expense'
     GROUP BY merchant_normalized ORDER BY SUM(amount_cents) DESC, merchant_normalized`,
    { lim: t.int(Math.min(Math.max(limit, 1), 100)) },
  );
  return rows.map((r) => ({ merchant: r.merchant, sample: r.sample, count: r.n, cents: Number(r.cents) }));
}

/**
 * Asigna la categoría a TODOS los movimientos sin categoría de ese comercio. Quedan como "manual": la próxima vez que llegue
 * ese comercio se categoriza solo con esta decisión (historial), sin preguntarle a Jev.
 */
export async function categorizeMerchant(merchantNormalized: string, categoryId: number): Promise<number | "no_category"> {
  const exists = await query("SELECT 1 AS x FROM dbo.categories WHERE id=@c", { c: t.int(categoryId) });
  if (!exists.length) return "no_category";
  const r = await query(
    `UPDATE dbo.transactions SET category_id=@c, category_source='manual', category_confidence=NULL
     OUTPUT INSERTED.id WHERE merchant_normalized=@m AND category_id IS NULL AND kind='expense'`,
    { c: t.int(categoryId), m: t.str(merchantNormalized) },
  );
  return r.length;
}
