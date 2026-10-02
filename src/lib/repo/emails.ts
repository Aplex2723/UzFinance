import { createHash } from "node:crypto";
import { getCategorizer, type Categorizer } from "@/lib/categorizer";
import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { parseBanamexEmail, type EmailInput, type ParsedEmailTx } from "@/lib/sources/banamex-email";
import { localDate } from "@/lib/time";
import { findCardByLast4, resolveBankCard, resolveDomiciliacionCard } from "./cards";
import { listPayees } from "./payees";
import { MERGE_WINDOW_SECONDS } from "./transactions";

export type EmailIngestResult =
  | { status: "created"; id: number; cardCreated: boolean }
  | { status: "merged"; id: number }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string }
  | { status: "unparsed"; reason: string };

export type EmailMessage = EmailInput & { messageId: string; from: string };

const emailHash = (messageId: string) => createHash("sha256").update(`email|${messageId}`).digest("hex");

/** Vista previa sin escribir (X-Dry-Run): solo el resultado del parseo, nunca datos del cuerpo. */
export async function previewEmail(m: EmailMessage): Promise<{ status: string; reason?: string; kind?: string; type?: string }> {
  const r = parseBanamexEmail(m, { ownPayees: (await listPayees()).map((p) => p.pattern) });
  if (r.kind === "tx") return { status: "parsed", kind: r.tx.kind, type: r.tx.type };
  return { status: r.kind, reason: r.reason };
}

async function dropUnparsed(messageId: string) {
  await query("DELETE dbo.unparsed_emails WHERE message_id=@m", { m: t.varchar(messageId) });
}

/**
 * Ingesta idempotente de un correo de Banamex:
 *  - mismo messageId, o misma (autorización + monto + día) → duplicate;
 *  - un movimiento del Atajo en la misma tarjeta, mismo monto y ≤15 min → merged (el correo manda);
 *  - lo que no se entiende se guarda en unparsed_emails (sin cuerpo) para revisión.
 */
export async function ingestBankEmail(m: EmailMessage, deps?: { categorizer?: Categorizer }): Promise<EmailIngestResult> {
  const already = await query("SELECT TOP 1 id FROM dbo.transactions WHERE email_message_id=@m", { m: t.varchar(m.messageId) });
  if (already.length) return { status: "duplicate" };

  const parsed = parseBanamexEmail(m, { ownPayees: (await listPayees()).map((p) => p.pattern) });
  if (parsed.kind === "ignored") {
    await dropUnparsed(m.messageId);
    return { status: "ignored", reason: parsed.reason };
  }
  if (parsed.kind === "unparsed") {
    // Se reevalúa en cada envío: si el parser mejora, el correo deja de estar pendiente.
    await query(
      `MERGE dbo.unparsed_emails AS u USING (SELECT @m AS message_id) s ON u.message_id = s.message_id
       WHEN MATCHED THEN UPDATE SET reason=@r
       WHEN NOT MATCHED THEN INSERT (message_id, sender, subject, received_at, reason) VALUES (@m, @f, @s, @at, @r);`,
      { m: t.varchar(m.messageId), f: t.varchar(m.from.slice(0, 200)), s: t.str(m.subject.slice(0, 200)), at: t.dt(m.receivedAt), r: t.varchar(parsed.reason.slice(0, 200)) },
    );
    return { status: "unparsed", reason: parsed.reason };
  }

  const tx = parsed.tx;
  // Compras/depósitos: tarjeta por producto+dígitos. Domiciliaciones: no crean tarjeta; un pago a una tarjeta propia
  // se liga a ella por los dígitos de la referencia, y lo demás cuelga de la tarjeta de sistema "Domiciliación".
  let card: { id: number };
  let created = false;
  if (tx.card) ({ card, created } = await resolveBankCard(tx.card));
  else card = (tx.payeeCardDigits && (await findCardByLast4(tx.payeeCardDigits))) || (await resolveDomiciliacionCard());

  if (tx.authCode) {
    const same = await query(
      "SELECT TOP 1 id FROM dbo.transactions WHERE auth_code=@a AND amount_cents=@amt AND occurred_date=@d AND kind=@k",
      { a: t.varchar(tx.authCode), amt: t.big(tx.amountCents), d: t.date(localDate(tx.occurredAt)), k: t.varchar(tx.kind) },
    );
    if (same.length) {
      await dropUnparsed(m.messageId);
      return { status: "duplicate" };
    }
  }

  const merged = tx.kind === "expense" ? await mergeIntoShortcut(m.messageId, tx, card.id, deps) : null;
  if (merged) {
    await dropUnparsed(m.messageId);
    return { status: "merged", id: merged };
  }

  const categorizer = deps?.categorizer ?? (await getCategorizer());
  // El categorizador recibe SOLO el comercio ya normalizado.
  const categoryId = tx.kind === "expense" ? await categorizer.categorize({ merchantRaw: tx.merchantNormalized, merchantNormalized: tx.merchantNormalized, amountCents: tx.amountCents }) : null;
  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, source, sources,
                                dedupe_hash, notes, kind, is_recurring, auth_code, email_message_id, account_ref)
       OUTPUT INSERTED.id
       VALUES (@at, @date, @amt, @raw, @norm, @card, @cat, 'email', 'email', @hash, @notes, @kind, @rec, @auth, @mid, @acct)`,
      {
        at: t.dt(tx.occurredAt), date: t.date(localDate(tx.occurredAt)), amt: t.big(tx.amountCents), raw: t.str(tx.merchantRaw),
        norm: t.str(tx.merchantNormalized), card: t.int(card.id), cat: t.int(categoryId), hash: t.char(emailHash(m.messageId)),
        notes: t.str(tx.notes), kind: t.varchar(tx.kind), rec: t.bit(tx.recurring), auth: t.varchar(tx.authCode), mid: t.varchar(m.messageId), acct: t.varchar(tx.accountRef),
      },
    );
    await dropUnparsed(m.messageId);
    return { status: "created", id: Number(r[0].id), cardCreated: created };
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "duplicate" };
    throw e;
  }
}

/** Atajo → correo: el correo manda (comercio, autorización, fecha); se conservan ambas fuentes. */
async function mergeIntoShortcut(messageId: string, tx: ParsedEmailTx, cardId: number, deps?: { categorizer?: Categorizer }): Promise<number | null> {
  const cand = await query<{ id: number; category_id: number | null }>(
    `SELECT TOP 1 id, category_id FROM dbo.transactions
     WHERE card_id=@c AND amount_cents=@a AND kind='expense' AND email_message_id IS NULL AND sources = 'shortcut'
       AND ABS(DATEDIFF(second, occurred_at, @at)) <= @win
     ORDER BY ABS(DATEDIFF(second, occurred_at, @at)), id`,
    { c: t.int(cardId), a: t.big(tx.amountCents), at: t.dt(tx.occurredAt), win: t.int(MERGE_WINDOW_SECONDS) },
  );
  if (!cand[0]) return null;
  const id = Number(cand[0].id);
  let categoryId = cand[0].category_id;
  if (categoryId === null) {
    const categorizer = deps?.categorizer ?? (await getCategorizer());
    categoryId = await categorizer.categorize({ merchantRaw: tx.merchantNormalized, merchantNormalized: tx.merchantNormalized, amountCents: tx.amountCents });
  }
  try {
    // dedupe_hash se conserva: así un reintento del Atajo sigue siendo duplicado.
    const r = await query(
      `UPDATE dbo.transactions SET merchant_raw=@raw, merchant_normalized=@norm, occurred_at=@at, occurred_date=@date,
         auth_code=@auth, email_message_id=@mid, source='email', sources='shortcut,email', is_recurring=@rec, category_id=@cat, account_ref=@acct
       OUTPUT INSERTED.id WHERE id=@id AND email_message_id IS NULL`,
      {
        id: t.big(id), raw: t.str(tx.merchantRaw), norm: t.str(tx.merchantNormalized), at: t.dt(tx.occurredAt), date: t.date(localDate(tx.occurredAt)),
        auth: t.varchar(tx.authCode), mid: t.varchar(messageId), rec: t.bit(tx.recurring), cat: t.int(categoryId), acct: t.varchar(tx.accountRef),
      },
    );
    return r.length ? id : null;
  } catch (e) {
    if (isUniqueViolation(e)) return null; // otro envío del mismo correo ganó la carrera
    throw e;
  }
}

export type UnparsedEmail = { message_id: string; sender: string; subject: string; received_at: string; reason: string };

export async function listUnparsed(): Promise<UnparsedEmail[]> {
  const rows = await query<Omit<UnparsedEmail, "received_at"> & { received_at: Date }>(
    "SELECT TOP 200 message_id, sender, subject, received_at, reason FROM dbo.unparsed_emails ORDER BY received_at DESC",
  );
  return rows.map((r) => ({ ...r, received_at: r.received_at.toISOString() }));
}

export async function dismissUnparsed(messageId: string): Promise<boolean> {
  return (await query("DELETE dbo.unparsed_emails OUTPUT DELETED.message_id WHERE message_id=@m", { m: t.varchar(messageId) })).length > 0;
}
