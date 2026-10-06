import { SQL as CHAT_SQL } from "@/lib/chat-sources";
import { isUniqueViolation, query, t } from "@/lib/db/pool";

/** Un mensaje `received` más viejo que esto se da por perdido (el proceso murió a medias) y vuelve a ser reclamable. */
export const CLAIM_STALE_SECONDS = 120;

/** Resultado de reclamar un mensaje (ver `claimMessageState`). */
export type ClaimState = "new" | "stale" | "inflight" | "done";

/**
 * Idempotencia de los webhooks (WhatsApp y Telegram): cada mensaje (wamid / `tg:<update_id>`) se procesa UNA vez aunque el proveedor
 * reintente. Nunca se guarda el texto del mensaje. Distingue QUÉ pasó para que el webhook decida qué responder:
 *  - `new`: fila nueva; este proceso lo procesa;
 *  - `stale`: fila `received` de más de `staleSeconds` (la reclamó otro proceso que murió antes de cerrarla); se reclama de forma
 *    atómica (un solo UPDATE que renueva `created_at`): dos reintentos simultáneos no pueden ganar los dos; este proceso lo procesa;
 *  - `inflight`: fila `received` RECIENTE; probablemente alguien lo está procesando, pero también puede ser un proceso que acaba de morir:
 *    el webhook responde 503 con `Retry-After` para que el proveedor reintente cuando ya sea `stale` (si el primer intento sigue vivo y
 *    ya contestó 200, no habrá más reintentos y no pasa nada);
 *  - `done`: ya terminó (`done`/`failed`/`ignored`): duplicado, no se procesa.
 */
export async function claimMessageState(id: string, waId: string, kind: string, staleSeconds = CLAIM_STALE_SECONDS): Promise<ClaimState> {
  const key = t.varchar(id.slice(0, 120));
  try {
    await query("INSERT dbo.whatsapp_messages (msg_id, wa_id, kind) VALUES (@id, @wa, @k)", { id: key, wa: t.varchar(waId.slice(0, 20)), k: t.varchar(kind.slice(0, 12)) });
    return "new";
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  const r = await query(
    "UPDATE dbo.whatsapp_messages SET created_at=SYSUTCDATETIME() OUTPUT INSERTED.msg_id WHERE msg_id=@id AND status='received' AND created_at < DATEADD(second, -@s, SYSUTCDATETIME())",
    { id: key, s: t.int(Math.max(0, Math.floor(staleSeconds))) },
  );
  if (r.length > 0) return "stale";
  const row = await query<{ status: string }>("SELECT status FROM dbo.whatsapp_messages WHERE msg_id=@id", { id: key });
  // Sin fila (purgada entre medias): nadie lo tiene; que el proveedor reintente.
  return !row.length || row[0].status === "received" ? "inflight" : "done";
}

/** Versión booleana de `claimMessageState`: true si ESTE proceso debe procesarlo (`new` o `stale`). */
export async function claimMessage(id: string, waId: string, kind: string, staleSeconds = CLAIM_STALE_SECONDS): Promise<boolean> {
  const s = await claimMessageState(id, waId, kind, staleSeconds);
  return s === "new" || s === "stale";
}

/**
 * Liga el gasto recién insertado al mensaje, de inmediato (antes de responder o de cerrar el mensaje): así "deshacer" lo encuentra y un
 * reproceso del mismo mensaje no lo vuelve a insertar aunque el proceso muera antes de `finishMessage`.
 */
export async function linkMessageTx(id: string, txId: number): Promise<void> {
  await query("UPDATE dbo.whatsapp_messages SET tx_id=@tx WHERE msg_id=@id", { id: t.varchar(id.slice(0, 120)), tx: t.big(txId) });
}

/** El gasto que este mensaje ya registró (un reproceso lo reutiliza en vez de insertar otro), o null. */
export async function messageTxId(id: string): Promise<number | null> {
  const r = await query<{ tx_id: number | null }>("SELECT tx_id FROM dbo.whatsapp_messages WHERE msg_id=@id", { id: t.varchar(id.slice(0, 120)) });
  return r[0]?.tx_id == null ? null : Number(r[0].tx_id);
}

export async function finishMessage(id: string, status: "done" | "failed" | "ignored", link: { txId?: number | null; documentId?: number | null } = {}): Promise<void> {
  await query("UPDATE dbo.whatsapp_messages SET status=@s, tx_id=COALESCE(@tx, tx_id), document_id=COALESCE(@doc, document_id) WHERE msg_id=@id", {
    id: t.varchar(id.slice(0, 120)), s: t.varchar(status), tx: t.big(link.txId ?? null), doc: t.int(link.documentId ?? null),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Conversación pendiente, deshacer y detección de duplicados del bot (lógica en src/lib/whatsapp).
// ---------------------------------------------------------------------------------------------------------------------

export type PendingStep = "card" | "merchant" | "confirm" | "duplicate";
export type PendingRow = { step: PendingStep; payload: string; expiresAt: Date };

/** Guarda (o reemplaza) lo pendiente del remitente: uno solo por número. */
export async function savePending(waId: string, step: PendingStep, payload: string, expiresAt: Date): Promise<void> {
  const params = { w: t.varchar(waId.slice(0, 20)), s: t.varchar(step), p: t.str(payload), e: t.dt(expiresAt) };
  const update = () => query("UPDATE dbo.whatsapp_pending SET step=@s, payload=@p, expires_at=@e, created_at=SYSUTCDATETIME() OUTPUT INSERTED.wa_id WHERE wa_id=@w", params);
  if ((await update()).length) return;
  try {
    await query("INSERT dbo.whatsapp_pending (wa_id, step, payload, expires_at) VALUES (@w, @s, @p, @e)", params);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    await update(); // otro mensaje del mismo remitente lo creó entre medias: gana el último
  }
}

/** Lee Y borra lo pendiente en una sola operación: dos respuestas simultáneas no pueden consumir el mismo pendiente. */
export async function takePending(waId: string): Promise<PendingRow | null> {
  const r = await query<{ step: PendingStep; payload: string; expires_at: Date }>(
    "DELETE dbo.whatsapp_pending OUTPUT DELETED.step, DELETED.payload, DELETED.expires_at WHERE wa_id=@w",
    { w: t.varchar(waId.slice(0, 20)) },
  );
  return r[0] ? { step: r[0].step, payload: r[0].payload, expiresAt: r[0].expires_at } : null;
}

export async function clearPending(waId: string): Promise<boolean> {
  return (await query("DELETE dbo.whatsapp_pending OUTPUT DELETED.wa_id WHERE wa_id=@w", { w: t.varchar(waId.slice(0, 20)) })).length > 0;
}

export async function hasPending(waId: string): Promise<boolean> {
  return (await query("SELECT 1 AS x FROM dbo.whatsapp_pending WHERE wa_id=@w", { w: t.varchar(waId.slice(0, 20)) })).length > 0;
}

export type UndoTarget = { msgId: string; txId: number; documentId: number | null; sources: string; merchant: string; amountCents: number; card: string };

/**
 * El ÚLTIMO registro de ESE remitente en los últimos `windowMin` minutos (reloj de la base, el mismo con el que se reclamó el mensaje), si
 * todavía existe. Solo el último: si ya se deshizo (`undone`), no hay nada que deshacer (no se retrocede al anterior) salvo que haya uno
 * posterior. Dos registros del mismo segundo se ordenan por `seq` (orden de llegada).
 */
export async function findUndoTarget(waId: string, windowMin = 30): Promise<UndoTarget | null> {
  const r = await query<{ msg_id: string; tx_id: number | null; document_id: number | null; sources: string | null; merchant_raw: string | null; cents: number | null; card: string | null }>(
    `SELECT TOP 1 m.msg_id, m.tx_id, m.document_id, x.sources, x.merchant_raw, CAST(x.amount_cents AS float) AS cents, c.name AS card
     FROM dbo.whatsapp_messages m
     LEFT JOIN dbo.transactions x ON x.id = m.tx_id
     LEFT JOIN dbo.cards c ON c.id = x.card_id
     WHERE m.wa_id=@w AND (m.tx_id IS NOT NULL OR m.undone = 1) AND m.created_at >= DATEADD(minute, -@win, SYSUTCDATETIME())
     ORDER BY m.created_at DESC, m.seq DESC`,
    { w: t.varchar(waId.slice(0, 20)), win: t.int(windowMin) },
  );
  const x = r[0];
  if (!x || x.tx_id === null || x.sources === null) return null;
  return { msgId: x.msg_id, txId: Number(x.tx_id), documentId: x.document_id === null ? null : Number(x.document_id), sources: x.sources, merchant: x.merchant_raw ?? "", amountCents: Number(x.cents), card: x.card ?? "" };
}

/**
 * Borra el movimiento SOLO si sigue siendo una fila de chat pura (`whatsapp`, `telegram`, `…-d`) o `receipt` (si el correo o el Atajo ya la
 * confirmaron, la guarda del WHERE lo impide aunque ocurra entre la consulta y el borrado) y el documento ligado, para poder volver a
 * subir el PDF. Antes de borrar marca el mensaje como `undone` (borrar el movimiento deja `tx_id` en NULL por la FK, y sin la marca el registro
 * ANTERIOR del remitente pasaría a ser "el último").
 */
export async function undoRegistration(txId: number): Promise<"deleted" | "confirmed" | "missing"> {
  const docs = await query<{ id: number }>("SELECT id FROM dbo.documents WHERE tx_id=@tx AND kind='transfer_receipt'", { tx: t.big(txId) });
  await query("UPDATE dbo.whatsapp_messages SET undone=1 WHERE tx_id=@tx", { tx: t.big(txId) });
  const gone = await query<{ id: number; plan_id: number | null }>(`DELETE dbo.transactions OUTPUT DELETED.id, DELETED.plan_id WHERE id=@tx AND sources IN (${CHAT_SQL.undoable})`, { tx: t.big(txId) });
  if (!gone.length) {
    const still = await query("SELECT 1 AS x FROM dbo.transactions WHERE id=@tx", { tx: t.big(txId) });
    return still.length ? "confirmed" : "missing";
  }
  for (const d of docs) await query("DELETE dbo.documents WHERE id=@id", { id: t.int(Number(d.id)) });
  // Una compra a MSI capturada por el chat creó su plan: se va con ella (solo si es de captura manual y ya nadie más lo usa).
  const plan = gone[0].plan_id;
  if (plan !== null && plan !== undefined) {
    await query("DELETE dbo.installment_plans WHERE id=@p AND source='manual' AND NOT EXISTS (SELECT 1 FROM dbo.transactions WHERE plan_id=@p)", { p: t.int(Number(plan)) });
  }
  return "deleted";
}

/** ¿Ya existe un movimiento con esta huella? (el hash incluye tarjeta, minuto, monto, comercio y, si aplica, `seq`). */
export async function dedupeHashExists(hash: string): Promise<boolean> {
  return (await query("SELECT TOP 1 1 AS x FROM dbo.transactions WHERE dedupe_hash=@h", { h: t.char(hash) })).length > 0;
}

export type SimilarExpense = { id: number; merchant: string; amountCents: number; occurredAt: Date; sources: string; dedupeHash: string };

/** Gastos de la MISMA tarjeta y monto exacto en ±1 día (fecha local), de cualquier fuente: defensa contra registrar dos veces lo que el Atajo o el correo ya capturaron. */
export async function findSimilarExpenses(cardId: number, amountCents: number, localYmd: string, at: Date): Promise<SimilarExpense[]> {
  const r = await query<{ id: number; merchant_raw: string; cents: number; occurred_at: Date; sources: string; dedupe_hash: string }>(
    `SELECT TOP 5 id, merchant_raw, CAST(amount_cents AS float) AS cents, occurred_at, sources, dedupe_hash
     FROM dbo.transactions
     WHERE card_id=@c AND amount_cents=@a AND kind='expense' AND occurred_date BETWEEN DATEADD(day, -1, @d) AND DATEADD(day, 1, @d)
     ORDER BY ABS(DATEDIFF(minute, occurred_at, @at)), id`,
    { c: t.int(cardId), a: t.big(amountCents), d: t.date(localYmd), at: t.dt(at) },
  );
  return r.map((x) => ({ id: Number(x.id), merchant: x.merchant_raw, amountCents: Number(x.cents), occurredAt: x.occurred_at, sources: x.sources, dedupeHash: x.dedupe_hash }));
}
