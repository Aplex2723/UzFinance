import { createHash } from "node:crypto";
import { getCategorizer, type Categorizer } from "@/lib/categorizer";
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
         x.source, x.notes
  FROM dbo.transactions x
  JOIN dbo.cards c ON c.id = x.card_id
  LEFT JOIN dbo.categories k ON k.id = x.category_id`;

type Row = Omit<Transaction, "occurred_at"> & { occurred_at: Date };
const map = (r: Row): Transaction => ({ ...r, occurred_at: r.occurred_at.toISOString() });

export type TxFilter = {
  q?: string;
  cardId?: number;
  categoryId?: number | "none";
  month?: string; // YYYY-MM
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

export async function listTransactions(f: TxFilter = {}): Promise<{ rows: Transaction[]; total: number }> {
  const where: string[] = ["1=1"];
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
export function dedupeHash(p: { cardId: number; occurredAt: Date; cents: number; merchantNormalized: string; source: Source }): string {
  const when = p.source === "statement" ? localDate(p.occurredAt) : p.occurredAt.toISOString().slice(0, 16);
  return createHash("sha256").update(`${p.cardId}|${when}|${p.cents}|${p.merchantNormalized}`).digest("hex");
}

export type IngestResult =
  | { status: "inserted"; id: number; cardMatched: boolean; categoryId: number | null }
  | { status: "duplicate"; cardMatched: boolean };

export async function ingestTransaction(
  raw: RawTransaction,
  source: Source,
  deps: { categorizer: Categorizer; categoryIdsByName?: Map<string, number> },
): Promise<IngestResult> {
  const merchantNormalized = normalizeMerchant(raw.merchant);
  const { card, matched } = await resolveCard(raw.cardRef);
  const hash = dedupeHash({ cardId: card.id, occurredAt: raw.occurredAt, cents: raw.amountCents, merchantNormalized, source });
  const occurredDate = localDate(raw.occurredAt);

  if (source === "statement") {
    // El comercio del estado de cuenta rara vez coincide con el de Wallet:
    // si ya hay un movimiento no-estado con misma tarjeta, día y monto, se omite.
    const probable = await query(
      "SELECT TOP 1 id FROM dbo.transactions WHERE card_id=@c AND occurred_date=@d AND amount_cents=@a AND source <> 'statement'",
      { c: t.int(card.id), d: t.date(occurredDate), a: t.big(raw.amountCents) },
    );
    if (probable.length) return { status: "duplicate", cardMatched: matched };
  }

  // Si la tarjeta no se reconoce, se guarda el texto recibido para poder crear el alias correcto.
  const notes = matched ? raw.notes ?? null : [`Tarjeta sin reconocer: "${raw.cardRef}"`, raw.notes].filter(Boolean).join(" · ").slice(0, 500);

  const explicit = raw.categoryName ? deps.categoryIdsByName?.get(raw.categoryName.toLowerCase()) ?? null : null;
  const categoryId = explicit ?? (await deps.categorizer.categorize({ merchantRaw: raw.merchant, merchantNormalized, amountCents: raw.amountCents }));

  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, source, dedupe_hash, notes)
       OUTPUT INSERTED.id
       VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, @src, @hash, @notes)`,
      {
        at: t.dt(raw.occurredAt), date: t.date(occurredDate), amt: t.big(raw.amountCents),
        raw: t.str(raw.merchant), norm: t.str(merchantNormalized), card: t.int(card.id), cat: t.int(categoryId),
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
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, source, dedupe_hash, notes)
       OUTPUT INSERTED.id VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, 'manual', @hash, @notes)`,
      {
        at: t.dt(p.occurredAt), date: t.date(localDate(p.occurredAt)), amt: t.big(p.amountCents), raw: t.str(p.merchant),
        norm: t.str(merchantNormalized), card: t.int(p.cardId), cat: t.int(p.categoryId), hash: t.char(hash), notes: t.str(p.notes),
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
         card_id=@card, category_id=@cat, notes=@notes, dedupe_hash=@hash OUTPUT INSERTED.id WHERE id=@id`,
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
  const categorizer = await getCategorizer();
  const rows = await query<{ id: number; merchant_normalized: string; merchant_raw: string; amount_cents: number }>(
    "SELECT TOP 5000 id, merchant_normalized, merchant_raw, CAST(amount_cents AS float) AS amount_cents FROM dbo.transactions WHERE category_id IS NULL",
  );
  let updated = 0;
  for (const r of rows) {
    const cat = await categorizer.categorize({ merchantRaw: r.merchant_raw, merchantNormalized: r.merchant_normalized, amountCents: r.amount_cents });
    if (cat !== null) {
      await query("UPDATE dbo.transactions SET category_id=@c WHERE id=@id AND category_id IS NULL", { c: t.int(cat), id: t.int(Number(r.id)) });
      updated++;
    }
  }
  return { updated, remaining: rows.length - updated };
}

/**
 * Huella de la tabla de movimientos (altas, ediciones y bajas cambian el valor).
 * Una sola consulta agregada: suficiente para datos personales.
 */
export async function getChangeRevision(): Promise<string> {
  const r = await query<{ n: number; m: number; h: number }>(
    `SELECT COUNT_BIG(*) AS n, CAST(ISNULL(MAX(id), 0) AS float) AS m,
            CAST(ISNULL(CHECKSUM_AGG(CHECKSUM(id, amount_cents, category_id, card_id, occurred_at, merchant_raw)), 0) AS float) AS h
     FROM dbo.transactions`,
  );
  return `${r[0].n}-${r[0].m}-${r[0].h}`;
}
