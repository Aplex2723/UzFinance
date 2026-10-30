import { createHash } from "node:crypto";
import { SQL as CHAT_SQL } from "@/lib/chat-sources";
import { getCategorizer, type Categorization, type Categorizer } from "@/lib/categorizer";
import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import type { RawTransaction } from "@/lib/sources/types";
import { localDate } from "@/lib/time";
import { addDays, effectiveRange, SOURCE_TOKENS, type TxCriteria, type TxSort } from "@/lib/tx-filters";
import { avgTicket, compareTotals, dailyAverage, isTodayPeriod, previousPeriod, rankShares, type TxSummary } from "@/lib/tx-summary";
import type { Source, Transaction } from "@/lib/types";
import { getCard, resolveCard } from "./cards";
import { listCategories } from "./categories";

/** "Sin confirmar": Banamex, gasto, solo Atajo/chat, sin correo y con más de 24 h. Se usa en el SELECT (columna) y en el filtro. */
const UNCONFIRMED_SQL = `(c.issuer = 'banamex' AND x.kind = 'expense' AND ${CHAT_SQL.unconfirmed("x")} AND x.occurred_at < DATEADD(hour, -24, SYSUTCDATETIME()))`;
const FROM_BASE = "FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id";

const SELECT = `
  SELECT x.id, x.occurred_at, CONVERT(char(10), x.occurred_date, 23) AS occurred_date,
         CAST(x.amount_cents AS float) AS amount_cents, x.currency, x.merchant_raw, x.merchant_normalized,
         x.card_id, c.name AS card_name, c.issuer, x.category_id, k.name AS category_name, k.color AS category_color,
         x.source, x.notes, x.kind, x.is_recurring, x.sources, x.auth_code, x.account_ref,
         x.category_source, CAST(x.category_confidence AS float) AS category_confidence, x.plan_id,
         CAST(CASE WHEN ${UNCONFIRMED_SQL} THEN 1 ELSE 0 END AS bit) AS unconfirmed
  FROM dbo.transactions x
  JOIN dbo.cards c ON c.id = x.card_id
  LEFT JOIN dbo.categories k ON k.id = x.category_id`;

type Row = Omit<Transaction, "occurred_at" | "is_recurring" | "unconfirmed"> & { occurred_at: Date; is_recurring: boolean | number; unconfirmed: boolean | number };
const map = (r: Row): Transaction => ({ ...r, occurred_at: r.occurred_at.toISOString(), is_recurring: !!r.is_recurring, unconfirmed: !!r.unconfirmed });

export type TxFilter = TxCriteria & {
  /** Una tarjeta (se suma a `cardIds`). */
  cardId?: number;
  /** `q` busca solo en el nombre del comercio (no en las notas). Lo usa UzChat: las notas nunca deben poder deducirse. */
  qMerchantOnly?: boolean;
  /** Solo cargos (monto > 0): sin reembolsos. */
  purchasesOnly?: boolean;
  limit?: number;
  offset?: number;
};

type Params = Record<string, ReturnType<(typeof t)[keyof typeof t]>>;

/** Orden permitido (lista blanca: la entrada del usuario nunca llega al ORDER BY). */
const ORDER_BY: Record<TxSort, string> = {
  recent: "x.occurred_at DESC, x.id DESC",
  oldest: "x.occurred_at ASC, x.id ASC",
  amount_desc: "ABS(x.amount_cents) DESC, x.occurred_at DESC, x.id DESC",
  amount_asc: "ABS(x.amount_cents) ASC, x.occurred_at DESC, x.id DESC",
};

/**
 * WHERE compartido por la lista, el conteo, el resumen y las facetas. SOLO texto fijo: todo valor del usuario va como parámetro
 * (`@q`, `@card0`…, `@s0`…, `@minc`…); lo único interpolado son constantes de este archivo (tipo de movimiento, expresiones).
 * Requiere los alias `x` (transactions) y `c` (cards).
 */
function buildWhere(f: TxFilter, opts: { skipCards?: boolean } = {}): { where: string; params: Params } {
  const where: string[] = [f.kind === "all" ? "1=1" : `x.kind = '${f.kind === "card_payment" ? "card_payment" : "expense"}'`];
  const params: Params = {};
  if (f.q) {
    where.push(f.qMerchantOnly ? "(x.merchant_normalized LIKE @q ESCAPE '\\' OR x.merchant_raw LIKE @q ESCAPE '\\')" : "(x.merchant_normalized LIKE @q ESCAPE '\\' OR x.merchant_raw LIKE @q ESCAPE '\\' OR x.notes LIKE @q ESCAPE '\\')");
    params.q = t.str(`%${f.q.replace(/[\\%_[]/g, "\\$&")}%`);
  }
  if (!opts.skipCards) {
    const ids = [...new Set([...(f.cardId ? [f.cardId] : []), ...(f.cardIds ?? [])])].filter((n) => Number.isInteger(n) && n > 0).slice(0, 50);
    if (ids.length === 1) { where.push("x.card_id = @card"); params.card = t.int(ids[0]); }
    else if (ids.length > 1) {
      where.push(`x.card_id IN (${ids.map((_, i) => `@card${i}`).join(", ")})`);
      ids.forEach((id, i) => { params[`card${i}`] = t.int(id); });
    }
  }
  if (f.categoryId === "none") where.push("x.category_id IS NULL");
  else if (f.categoryId) { where.push("x.category_id = @cat"); params.cat = t.int(f.categoryId); }
  if (f.month) {
    where.push("x.occurred_date >= @mfrom AND x.occurred_date < DATEADD(month, 1, @mfrom)");
    params.mfrom = t.date(`${f.month}-01`);
  }
  if (f.from) { where.push("x.occurred_date >= @from"); params.from = t.date(f.from); }
  if (f.to) { where.push("x.occurred_date <= @to"); params.to = t.date(f.to); }
  // Fuente: la etiqueta está en la lista `sources` ("shortcut,email"): una fila fusionada cuenta para las dos. Varias = O.
  const tokens = [...new Set((f.sources ?? []).flatMap((s) => SOURCE_TOKENS[s] ?? []))];
  if (tokens.length) {
    where.push(`(${tokens.map((_, i) => `(',' + ISNULL(NULLIF(x.sources, ''), x.source) + ',') LIKE @s${i}`).join(" OR ")})`);
    tokens.forEach((tok, i) => { params[`s${i}`] = t.varchar(`%,${tok},%`); });
  }
  if (f.minCents && f.minCents > 0) { where.push("ABS(x.amount_cents) >= @minc"); params.minc = t.big(f.minCents); }
  if (f.maxCents && f.maxCents > 0) { where.push("ABS(x.amount_cents) <= @maxc"); params.maxc = t.big(f.maxCents); }
  if (f.unconfirmed) where.push(UNCONFIRMED_SQL);
  if (f.purchasesOnly) where.push("x.amount_cents > 0");
  if (f.msi) where.push("x.plan_id IS NOT NULL");
  if (f.recurring) where.push("x.is_recurring = 1");
  return { where: where.join(" AND "), params };
}

export async function listTransactions(f: TxFilter = {}): Promise<{ rows: Transaction[]; total: number }> {
  const { where: w, params } = buildWhere(f);
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const offset = Math.max(f.offset ?? 0, 0);
  const order = ORDER_BY[f.sort ?? "recent"] ?? ORDER_BY.recent;
  const [rows, total] = await Promise.all([
    query<Row>(`${SELECT} WHERE ${w} ORDER BY ${order} OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY`, {
      ...params, off: t.int(offset), lim: t.int(limit),
    }),
    query<{ n: number }>(`SELECT COUNT(*) AS n ${FROM_BASE} WHERE ${w}`, params),
  ]);
  return { rows: rows.map(map), total: total[0].n };
}

/** Movimientos y monto por tarjeta con TODOS los filtros menos el de tarjeta (para los contadores de los chips de tarjeta). */
export async function listCardFacets(f: TxFilter = {}): Promise<Map<number, { count: number; cents: number }>> {
  const { where, params } = buildWhere(f, { skipCards: true });
  const rows = await query<{ id: number; n: number; cents: number }>(
    `SELECT c.id, COUNT(*) AS n, CAST(SUM(x.amount_cents) AS float) AS cents ${FROM_BASE} WHERE ${where} GROUP BY c.id`,
    params,
  );
  return new Map(rows.map((r) => [Number(r.id), { count: Number(r.n), cents: Number(r.cents) }]));
}

const N = (v: unknown) => Number(v ?? 0);
const catColor = (c: string | null) => c ?? "#6b7280";

/**
 * Resumen del conjunto FILTRADO (mismos filtros que la lista; ignora paginación y orden) para las tarjetitas de arriba.
 * No carga filas: agrega en la base (por tarjeta, por categoría, la compra más alta, el comercio más grande y, si hay periodo,
 * el total del periodo equivalente anterior). Los reembolsos (monto negativo) restan del total pero no cuentan como compra para
 * el ticket promedio. `today` es el día de hoy en CDMX (YYYY-MM-DD); se puede fijar en pruebas.
 */
export async function getTransactionSummary(f: TxFilter = {}, opts: { today?: string; topCards?: number; topCategories?: number } = {}): Promise<TxSummary> {
  const today = opts.today ?? localDate(new Date());
  const { where, params } = buildWhere(f);
  const prev = previousPeriod(f, today);
  const range = effectiveRange(f);
  const isToday = isTodayPeriod(f, today);
  const noPeriod = { ...f, month: undefined, from: undefined, to: undefined };
  const at = (from: string, to: string) => buildWhere({ ...noPeriod, from, to });

  const [byCard, byCat, topPurchase, topMerchant, prevRows, avgRows] = await Promise.all([
    query<{ id: number; name: string; issuer: TxSummary["cards"][number]["issuer"]; color: string; art: TxSummary["cards"][number]["art"]; n: number; cents: number; pn: number; pcents: number }>(
      `SELECT c.id, c.name, c.issuer, c.color, c.art, COUNT(*) AS n, CAST(SUM(x.amount_cents) AS float) AS cents,
              COUNT(CASE WHEN x.amount_cents > 0 THEN 1 END) AS pn, CAST(ISNULL(SUM(CASE WHEN x.amount_cents > 0 THEN x.amount_cents END), 0) AS float) AS pcents
       ${FROM_BASE} WHERE ${where} GROUP BY c.id, c.name, c.issuer, c.color, c.art`,
      params,
    ),
    query<{ id: number | null; name: string | null; color: string | null; n: number; cents: number }>(
      `SELECT k.id, k.name, k.color, COUNT(*) AS n, CAST(SUM(x.amount_cents) AS float) AS cents
       ${FROM_BASE} LEFT JOIN dbo.categories k ON k.id = x.category_id WHERE ${where} GROUP BY k.id, k.name, k.color`,
      params,
    ),
    query<{ id: number; merchant: string; cents: number; d: string; card: string }>(
      `SELECT TOP 1 x.id, x.merchant_raw AS merchant, CAST(x.amount_cents AS float) AS cents, CONVERT(char(10), x.occurred_date, 23) AS d, c.name AS card
       ${FROM_BASE} WHERE ${where} AND x.amount_cents > 0 ORDER BY x.amount_cents DESC, x.occurred_at DESC, x.id DESC`,
      params,
    ),
    query<{ merchant: string; n: number; cents: number }>(
      `SELECT TOP 1 MIN(x.merchant_raw) AS merchant, COUNT(*) AS n, CAST(SUM(x.amount_cents) AS float) AS cents
       ${FROM_BASE} WHERE ${where} GROUP BY x.merchant_normalized HAVING SUM(x.amount_cents) > 0 ORDER BY SUM(x.amount_cents) DESC, x.merchant_normalized`,
      params,
    ),
    prev
      ? (() => { const w = at(prev.from, prev.to); return query<{ n: number; cents: number }>(`SELECT COUNT(*) AS n, CAST(ISNULL(SUM(x.amount_cents), 0) AS float) AS cents ${FROM_BASE} WHERE ${w.where}`, w.params); })()
      : Promise.resolve([] as { n: number; cents: number }[]),
    isToday
      ? (() => { const w = at(addDays(today, -30), addDays(today, -1)); return query<{ n: number; cents: number }>(`SELECT COUNT(*) AS n, CAST(ISNULL(SUM(x.amount_cents), 0) AS float) AS cents ${FROM_BASE} WHERE ${w.where}`, w.params); })()
      : Promise.resolve([] as { n: number; cents: number }[]),
  ]);

  const count = byCard.reduce((a, r) => a + N(r.n), 0);
  const totalCents = byCard.reduce((a, r) => a + N(r.cents), 0);
  const purchaseCount = byCard.reduce((a, r) => a + N(r.pn), 0);
  const purchaseCents = byCard.reduce((a, r) => a + N(r.pcents), 0);

  const cardRank = rankShares(byCard.map((r) => ({ ...r, cents: N(r.cents), count: N(r.n) })), opts.topCards ?? 3);
  const catRank = rankShares(byCat.map((r) => ({ id: r.id === null ? null : Number(r.id), name: r.name ?? "Sin categoría", color: catColor(r.color), cents: N(r.cents), count: N(r.n) })), opts.topCategories ?? 2);

  const avg = avgRows.length ? dailyAverage(N(avgRows[0].cents), 30, N(avgRows[0].n)) : null;
  return {
    kind: f.kind ?? "expense",
    totalCents, count, purchaseCount, purchaseCents,
    refundCents: Math.max(0, purchaseCents - totalCents),
    avgTicketCents: avgTicket(purchaseCents, purchaseCount),
    cards: cardRank.top.map((r) => ({ id: Number(r.id), name: r.name, color: r.color, cents: r.cents, count: r.count, pct: r.pct, issuer: r.issuer, art: r.art ?? null })),
    cardsRest: cardRank.rest,
    categories: catRank.top,
    topPurchase: topPurchase[0] ? { id: Number(topPurchase[0].id), merchant: topPurchase[0].merchant, cents: N(topPurchase[0].cents), date: topPurchase[0].d, card: topPurchase[0].card } : null,
    topMerchant: topMerchant[0] ? { merchant: topMerchant[0].merchant, cents: N(topMerchant[0].cents), count: N(topMerchant[0].n) } : null,
    period: range.from && range.to ? { from: range.from, to: range.to > today ? today : range.to } : null,
    previous: prev ? { ...prev, totalCents: N(prevRows[0]?.cents), count: N(prevRows[0]?.n), comparison: compareTotals(totalCents, N(prevRows[0]?.cents)) } : null,
    avg30: avg === null ? null : { avgCents: avg, diffCents: totalCents - avg, pct: avg > 0 ? ((totalCents - avg) / avg) * 100 : null },
  };
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
  const byId = raw.cardId ? await getCard(raw.cardId) : null;
  const { card, matched } = byId ? { card: byId, matched: true } : await resolveCard(raw.cardRef);
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

    // Chat → Atajo: lo que se tecleó por WhatsApp o Telegram (con la hora del mensaje) y luego llega por Wallet no se duplica; el Atajo
    // solo se anota como segunda fuente. Las filas de chat con fecha explícita (hora artificial) no se funden.
    const typed = await query<{ id: number }>(
      `SELECT TOP 1 id FROM dbo.transactions
       WHERE card_id=@c AND amount_cents=@a AND kind='expense' AND email_message_id IS NULL AND sources IN (${CHAT_SQL.mergeableChat})
         AND ABS(DATEDIFF(second, occurred_at, @at)) <= @win
       ORDER BY ABS(DATEDIFF(second, occurred_at, @at)), id`,
      { c: t.int(card.id), a: t.big(raw.amountCents), at: t.dt(raw.occurredAt), win: t.int(MERGE_WINDOW_SECONDS) },
    );
    if (typed[0]) {
      const id = Number(typed[0].id);
      try {
        await query("INSERT dbo.merged_hashes (hash, tx_id) VALUES (@h, @id)", { h: t.char(hash), id: t.big(id) });
      } catch (e) {
        if (isUniqueViolation(e)) return { status: "duplicate", cardMatched: matched };
        throw e;
      }
      const upd = await query(`UPDATE dbo.transactions SET sources = LEFT(sources + ',shortcut', 40) OUTPUT INSERTED.id WHERE id=@id AND sources IN (${CHAT_SQL.mergeableChat})`, { id: t.big(id) });
      if (upd.length) return { status: "merged", id, cardMatched: matched };
      // Otro proceso la modificó entre la consulta y la fusión: se retira la huella y se inserta normal.
      await query("DELETE dbo.merged_hashes WHERE hash=@h", { h: t.char(hash) });
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
       VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, @csrc, @cconf, @plan, @kind, @src, @srcs, @hash, @notes)`,
      {
        at: t.dt(raw.occurredAt), date: t.date(occurredDate), amt: t.big(raw.amountCents),
        raw: t.str(raw.merchant), norm: t.str(merchantNormalized), card: t.int(card.id), cat: t.int(categoryId),
        csrc: t.varchar(cat?.source ?? null), cconf: t.dec(cat?.confidence ?? null), plan: t.int(raw.planId ?? null), kind: t.varchar(kind),
        src: t.varchar(source), srcs: t.varchar((raw.sourcesTag ?? source).slice(0, 40)), hash: t.char(hash), notes: t.str(notes),
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
  const r = await query<{ n: number; m: number; h: number; u: number; c: number; i: number | null; a: string; d: string; f: number }>(
    `SELECT COUNT_BIG(*) AS n, CAST(ISNULL(MAX(id), 0) AS float) AS m,
            CAST(ISNULL(CHECKSUM_AGG(CHECKSUM(id, amount_cents, category_id, card_id, occurred_at, merchant_raw, kind, sources)), 0) AS float) AS h,
            (SELECT COUNT_BIG(*) FROM dbo.unparsed_emails) AS u,
            (SELECT COUNT_BIG(*) FROM dbo.cards WHERE needs_name = 1) AS c,
            -- alerts_last_run cambia cada ~15 min sin que cambie nada visible: no cuenta.
            (SELECT CAST(ISNULL(CHECKSUM_AGG(CHECKSUM(value)), 0) AS bigint) + CAST(ISNULL((SELECT CHECKSUM_AGG(CHECKSUM(id, saved_cents, target_cents, target_date, name, kind, priority, month_only)) FROM dbo.savings_goals), 0) AS bigint) FROM dbo.app_settings WHERE [key] <> 'alerts_last_run') AS i,
            -- alertas sin leer/descartar (y la última, por si una se lee mientras otra llega)
            (SELECT CONCAT(COUNT_BIG(*), ':', ISNULL(MAX(id), 0)) FROM dbo.alerts WHERE read_at IS NULL AND dismissed_at IS NULL) AS a,
            (SELECT CONCAT(COUNT_BIG(*), ':', ISNULL(DATEDIFF_BIG(second, '20000101', MAX(updated_at)), 0)) FROM dbo.documents) AS d,
            (SELECT COUNT_BIG(*) FROM dbo.recon_findings WHERE status = 'open') AS f
     FROM dbo.transactions`,
  );
  return `${r[0].n}-${r[0].m}-${r[0].h}-${r[0].u}-${r[0].c}-${r[0].i ?? 0}-${r[0].a}-${r[0].d}-${r[0].f}`;
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
