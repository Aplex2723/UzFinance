import { createHash } from "node:crypto";
import type { Categorizer } from "@/lib/categorizer";
import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import { isGenericConcept, transferMerchant, type ParsedTransfer } from "@/lib/pdf/receipts/banamex-transfer";
import { isOwnCardPayee } from "@/lib/sources/banamex-email";
import { localDate } from "@/lib/time";
import type { Card } from "@/lib/types";
import { listCards } from "./cards";
import { listCategories } from "./categories";
import { listPayees } from "./payees";

/**
 * Registro de una transferencia leída de un comprobante (PDF). Reglas:
 *  - La clave de rastreo identifica la operación: el mismo comprobante, o uno distinto del mismo envío, nunca se duplica.
 *  - Si el correo del banco ya la registró (misma autorización, o mismo monto ±15 min), se COMPLETA esa fila en vez de crear otra.
 *  - El CONCEPTO que escribió el usuario es el comercio; si es el genérico del banco, "Transferencia a <beneficiario>".
 *  - Una transferencia hacia una tarjeta propia (lista de Configuración) es un pago de tarjeta: queda fuera del gasto.
 */
export const RECEIPT_MERGE_WINDOW_SECONDS = 15 * 60;
const ACCOUNT_MAP_KEY = "account_card_map";

/* ───────── de qué tarjeta salió ───────── */

/** Cuenta (últimos dígitos) → id de tarjeta, aprendido de lo que el usuario confirma. */
export async function getAccountCardMap(): Promise<Record<string, number>> {
  const r = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key]=@k", { k: t.varchar(ACCOUNT_MAP_KEY) });
  try {
    const o = JSON.parse(r[0]?.value ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => /^\d{3,4}$/.test(k) && Number.isInteger(v)) as [string, number][]);
  } catch {
    return {};
  }
}

export async function rememberAccountCard(tail: string, cardId: number): Promise<void> {
  if (!/^\d{3,4}$/.test(tail)) throw new RangeError("terminación de cuenta inválida");
  const map = { ...(await getAccountCardMap()), [tail]: cardId };
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(ACCOUNT_MAP_KEY), v: t.str(JSON.stringify(map)) },
  );
}

export type OriginCard = { card: Card; how: "aprendida" | "terminación" | "único débito" };

/**
 * Tarjeta de la cuenta de origen. Solo se decide sola cuando es inequívoca; si no, devuelve null y el comprobante
 * queda en revisión para que el usuario elija (y la app lo recuerda para la próxima).
 */
export async function resolveOriginCard(tr: Pick<ParsedTransfer, "originTail" | "originLabel" | "accountType">): Promise<OriginCard | null> {
  const cards = (await listCards(false)).filter((c) => c.name !== "Domiciliación" && c.name !== "Sin asignar");
  const learned = (await getAccountCardMap())[tr.originTail];
  const byId = learned ? cards.find((c) => c.id === learned) : undefined;
  if (byId) return { card: byId, how: "aprendida" };
  // El comprobante imprime 3 dígitos; las tarjetas guardan 3 o 4: se compara por el final.
  const byTail = cards.filter((c) => c.last4 && c.last4.endsWith(tr.originTail));
  if (byTail.length === 1) return { card: byTail[0], how: "terminación" };
  if (byTail.length > 1) return null;
  const isDebit = /d[eé]bito/i.test(tr.accountType ?? "") || /micuenta/i.test(tr.originLabel);
  if (isDebit) {
    const debits = cards.filter((c) => c.issuer === "banamex" && (c.art === "banamex-debito" || /d[eé]bito/i.test(c.name)));
    if (debits.length === 1) return { card: debits[0], how: "único débito" };
  }
  return null;
}

/* ───────── cómo se guarda ───────── */

export type TransferOverrides = { merchant?: string; categoryId?: number | null; notes?: string | null; kind?: "expense" | "card_payment"; /** El usuario confirmó que NO es repetida. */ allowSuspect?: boolean };

export function transferNotes(tr: ParsedTransfer): string {
  const dest = [tr.destName, tr.destBank ? `(${tr.destBank})` : null, tr.destTail ? `···${tr.destTail}` : null].filter(Boolean).join(" ");
  // El concepto ya es el comercio (o el genérico del banco, que no aporta): no se repite en las notas.
  return [dest ? `A ${dest}` : null, tr.reference ? `Ref. ${tr.reference}` : null, `Rastreo ${tr.trackingKey}`].filter(Boolean).join(" · ").slice(0, 500);
}

const receiptHash = (trackingKey: string) => createHash("sha256").update(`receipt|${trackingKey}`).digest("hex");

export type RegisterResult = { status: "inserted" | "merged" | "duplicate" | "suspect"; id: number; kind: "expense" | "card_payment"; categoryId: number | null };

export async function registerTransfer(tr: ParsedTransfer, cardId: number, deps: { categorizer: Categorizer }, o: TransferOverrides = {}): Promise<RegisterResult> {
  const merchant = (o.merchant?.trim() || transferMerchant(tr)).slice(0, 120);
  const norm = normalizeMerchant(merchant) || "TRANSFERENCIA";
  const ownPayees = (await listPayees()).map((p) => p.pattern);
  const own = [tr.destAlias, tr.destName].some((n) => n && isOwnCardPayee(normalizeMerchant(n), ownPayees));
  const kind = o.kind ?? (own ? "card_payment" : "expense");
  const notes = (o.notes?.trim() ? `${o.notes.trim()} · ${transferNotes(tr)}` : transferNotes(tr)).slice(0, 500);

  // ¿Ya existe esta transferencia?
  const dup = await query<{ id: number; kind: "expense" | "card_payment"; category_id: number | null }>("SELECT TOP 1 id, kind, category_id FROM dbo.transactions WHERE tracking_key=@k", { k: t.varchar(tr.trackingKey) });
  if (dup[0]) return { status: "duplicate", id: Number(dup[0].id), kind: dup[0].kind, categoryId: dup[0].category_id };

  // ¿Parece la MISMA transferencia con otra clave de rastreo (p. ej. el OCR leyó un carácter distinto en otro PDF del mismo envío)?
  // Mismo monto, tarjeta y minuto que otra ya registrada desde comprobante: no se inserta sola, se manda a revisión.
  if (!o.allowSuspect) {
    const twin = await query<{ id: number }>(
      `SELECT TOP 1 id FROM dbo.transactions WHERE tracking_key IS NOT NULL AND tracking_key <> @k AND amount_cents=@a AND card_id=@card AND ABS(DATEDIFF(second, occurred_at, @at)) <= 90`,
      { k: t.varchar(tr.trackingKey), a: t.big(tr.amountCents), card: t.int(cardId), at: t.dt(tr.occurredAt) },
    );
    if (twin[0]) return { status: "suspect", id: Number(twin[0].id), kind, categoryId: null };
  }

  // Category: explícita > concepto con significado (categorizador) > "Transferencias".
  const cats = await listCategories();
  const byName = (n: string) => cats.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id ?? null;
  let categoryId: number | null = null;
  let csrc: string | null = null;
  let cconf: number | null = null;
  if (kind === "expense") {
    if (o.categoryId !== undefined && o.categoryId !== null && cats.some((c) => c.id === o.categoryId)) {
      categoryId = o.categoryId;
      csrc = "manual";
    } else if (!isGenericConcept(tr.concept) || o.merchant) {
      const c = await deps.categorizer.categorizeDetailed({ merchantRaw: merchant, merchantNormalized: norm, amountCents: tr.amountCents });
      if (c) {
        categoryId = c.categoryId;
        csrc = c.source;
        cconf = c.confidence;
      }
    }
    if (categoryId === null) {
      categoryId = byName("Transferencias");
      csrc = categoryId === null ? null : "rule";
    }
  }

  // ¿El correo del banco ya la registró? Misma autorización, o mismo monto a ≤15 min. La fila del banco manda (tarjeta, hora).
  const mail = await query<{ id: number; category_id: number | null; kind: string }>(
    `SELECT TOP 1 id, category_id, kind FROM dbo.transactions
     WHERE tracking_key IS NULL AND email_message_id IS NOT NULL AND amount_cents=@a AND kind=@kind AND source <> 'receipt'
       AND ((@auth IS NOT NULL AND auth_code=@auth)
            -- Sin autorización en común solo se funde lo que es clara y únicamente la misma operación: misma tarjeta, a ≤15 min y SIN
            -- autorizaciones distintas (dos autorizaciones distintas son dos operaciones, aunque el monto coincida).
            OR (card_id=@card AND ABS(DATEDIFF(second, occurred_at, @at)) <= @win AND (auth_code IS NULL OR @auth IS NULL)))
     ORDER BY CASE WHEN auth_code=@auth THEN 0 ELSE 1 END, ABS(DATEDIFF(second, occurred_at, @at)), id`,
    { a: t.big(tr.amountCents), kind: t.varchar(kind), auth: t.varchar(tr.authCode), at: t.dt(tr.occurredAt), win: t.int(RECEIPT_MERGE_WINDOW_SECONDS), card: t.int(cardId) },
  );
  if (mail[0]) {
    const id = Number(mail[0].id);
    const useConcept = !isGenericConcept(tr.concept) || !!o.merchant;
    try {
      const r = await query(
        `UPDATE dbo.transactions SET tracking_key=@k, sources=LEFT(sources + ',receipt', 40), auth_code=COALESCE(auth_code, @auth),
           notes = LEFT(CASE WHEN notes IS NULL OR notes = '' THEN @notes ELSE notes + ' · ' + @notes END, 500),
           merchant_raw = CASE WHEN @use = 1 THEN @raw ELSE merchant_raw END, merchant_normalized = CASE WHEN @use = 1 THEN @norm ELSE merchant_normalized END,
           category_id = COALESCE(category_id, @cat), category_source = CASE WHEN category_id IS NULL AND @cat IS NOT NULL THEN @csrc ELSE category_source END,
           category_confidence = CASE WHEN category_id IS NULL AND @cat IS NOT NULL THEN @cconf ELSE category_confidence END
         OUTPUT INSERTED.id WHERE id=@id AND tracking_key IS NULL`,
        { id: t.big(id), k: t.varchar(tr.trackingKey), auth: t.varchar(tr.authCode), notes: t.str(notes), use: t.bit(useConcept), raw: t.str(merchant), norm: t.str(norm), cat: t.int(categoryId), csrc: t.varchar(csrc), cconf: t.dec(cconf) },
      );
      if (r.length) return { status: "merged", id, kind, categoryId: mail[0].category_id ?? categoryId };
    } catch (e) {
      if (isUniqueViolation(e)) return { status: "duplicate", id, kind, categoryId };
      throw e;
    }
  }

  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, category_source, category_confidence,
                                kind, source, sources, dedupe_hash, notes, auth_code, tracking_key)
       OUTPUT INSERTED.id
       VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, @csrc, @cconf, @kind, 'receipt', 'receipt', @hash, @notes, @auth, @k)`,
      {
        at: t.dt(tr.occurredAt), date: t.date(localDate(tr.occurredAt)), amt: t.big(tr.amountCents), raw: t.str(merchant), norm: t.str(norm), card: t.int(cardId),
        cat: t.int(categoryId), csrc: t.varchar(csrc), cconf: t.dec(cconf), kind: t.varchar(kind), hash: t.char(receiptHash(tr.trackingKey)), notes: t.str(notes),
        auth: t.varchar(tr.authCode), k: t.varchar(tr.trackingKey),
      },
    );
    return { status: "inserted", id: Number(r[0].id), kind, categoryId };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const again = await query<{ id: number }>("SELECT TOP 1 id FROM dbo.transactions WHERE tracking_key=@k", { k: t.varchar(tr.trackingKey) });
      return { status: "duplicate", id: Number(again[0]?.id ?? 0), kind, categoryId };
    }
    throw e;
  }
}
