import { channelOf, DOC_ORIGIN } from "@/lib/chat-sources";
import { IntakeError, processDocument } from "@/lib/docs/intake";
import { getTransaction } from "@/lib/repo/transactions";
import { finishMessage, messageTxId } from "@/lib/repo/whatsapp";
import { eligibleCards } from "./cards";
import { handleCommand } from "./commands";
import { handleText, type Ctx, type Outcome } from "./conversation";
import { commandOf } from "./parse-expense";
import * as R from "./replies";
import { replyAddress, type HandleDeps, type InboundMessage, type Sender, type WhatsAppIO } from "./types";
import { whenLabel } from "./when";

export { replyAddress };

/** Un mensaje más viejo que esto ya no se procesa: "hoy" y "ayer" dejarían de significar lo que el usuario quiso. */
export const MAX_AGE_MS = 48 * 3_600_000;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_IN = 5000;

/** Cuándo se ENVIÓ el mensaje (reloj de Meta/Telegram), sin dejar que un reloj adelantado lo ponga en el futuro (se recorta a `now`). */
function sentAtOf(msg: InboundMessage, now: Date): Date {
  const t = Number(msg.timestamp) * 1000;
  if (!Number.isFinite(t) || t <= 0) return now;
  return new Date(Math.min(t, now.getTime()));
}

async function handlePdf(c: Ctx, io: WhatsAppIO): Promise<Outcome> {
  const media = c.msg.media;
  if (!media?.id) return { reply: R.PDF_NOT_PDF, status: "ignored" };
  const mime = (media.mimeType ?? "").split(";")[0].trim().toLowerCase();
  const isPdfName = /\.pdf$/i.test(media.filename ?? "");
  // Solo PDF: por tipo, o por extensión cuando el tipo falta o es genérico.
  if (!(mime === "application/pdf" || ((!mime || mime === "application/octet-stream") && isPdfName))) return { reply: R.PDF_NOT_PDF, status: "ignored" };

  let file: { bytes: Uint8Array; mimeType: string };
  try {
    file = await io.downloadMedia(media.id, MAX_PDF_BYTES);
  } catch (e) {
    const m = (e as Error)?.message ?? "";
    console.error("[chat] descarga fallida:", m.slice(0, 120));
    return { reply: /pesa|grande|tama[ñn]o|size|large|exceed|m[aá]ximo|too big/i.test(m) ? R.PDF_TOO_BIG : R.PDF_DOWNLOAD_FAILED, status: "failed" };
  }
  if (file.bytes.byteLength > MAX_PDF_BYTES) return { reply: R.PDF_TOO_BIG, status: "failed" };
  if (file.bytes.byteLength === 0) return { reply: R.PDF_EMPTY, status: "failed" };
  if (/^(image|audio|video|text)\//i.test(file.mimeType ?? "")) return { reply: R.PDF_NOT_PDF, status: "ignored" };

  try {
    const r = await processDocument({ bytes: file.bytes, origin: DOC_ORIGIN[c.channel], filename: media.filename }, { categorizer: c.deps.categorizer, ocr: c.deps.ocr, now: c.deps.now });
    if (r.already) return { reply: R.pdfAlready(r, c.deps.appUrl), status: "done", documentId: r.documentId };
    const linked = (r.registered === "inserted" || r.registered === "merged") && r.txId ? r.txId : null;
    let tx: { cents: number; merchant: string; card: string } | null = null;
    if (linked) {
      const x = await getTransaction(linked).catch(() => null);
      if (x) tx = { cents: x.amount_cents, merchant: x.merchant_raw, card: x.card_name };
    }
    return { reply: R.pdfReply(r, { appUrl: c.deps.appUrl, tx }), status: r.status === "failed" ? "failed" : "done", documentId: r.documentId, txId: linked };
  } catch (e) {
    if (e instanceof IntakeError) return { reply: e.status === 413 ? R.PDF_TOO_BIG : e.status === 415 ? R.PDF_INVALID : R.PDF_EMPTY, status: "failed" };
    console.error("[chat] PDF falló:", ((e as Error)?.message ?? "").slice(0, 160));
    return { reply: R.PDF_FAILED, status: "failed" };
  }
}

/**
 * Un reproceso del MISMO mensaje (el proveedor reintentó y el mensaje se reclamó de nuevo tras un fallo a medias): si ya registró un gasto
 * no se vuelve a insertar nada, se responde con lo ya registrado.
 */
async function alreadyRegistered(msg: InboundMessage, sentAt: Date): Promise<Outcome | null> {
  const txId = await messageTxId(msg.id);
  if (txId === null) return null;
  const x = await getTransaction(txId).catch(() => null);
  if (!x) return null;
  const reply = R.registered({ cents: x.amount_cents, merchant: x.merchant_raw, card: x.card_name, when: whenLabel(new Date(x.occurred_at), sentAt), category: x.category_name });
  return { reply, status: "done", txId };
}

/**
 * Tiempos: `now` es la hora REAL de proceso (`deps.now ?? new Date()`); `sentAt` es la hora del mensaje (`msg.timestamp`, recortada a `now`
 * si viene adelantada) y es la que usan "hoy"/"ayer", la hora del gasto y la caducidad de lo pendiente. Un mensaje procesado más de 48 h
 * después de enviado se rechaza ("reenvíalo"). El transporte (webhook) debe dejar `deps.now` sin definir o pasar `new Date()`, NUNCA la hora
 * del mensaje: con `now = hora del mensaje` la guarda de 48 h jamás se cumple.
 */
async function route(msg: InboundMessage, sender: Sender, io: WhatsAppIO, deps: HandleDeps): Promise<Outcome> {
  const now = deps.now ?? new Date();
  const sentAt = sentAtOf(msg, now);
  const channel = channelOf(msg.channel);

  const prior = await alreadyRegistered(msg, sentAt);
  if (prior) return prior;
  if (now.getTime() - sentAt.getTime() > MAX_AGE_MS) return { reply: R.TOO_OLD, status: "ignored" };

  const base = { msg, sender, channel, now, sentAt, deps, cards: [] };
  if (msg.type === "document") return handlePdf(base, io);
  if (msg.type !== "text") return { reply: R.MEDIA_UNSUPPORTED, status: "ignored" };

  const text = String(msg.text ?? "").slice(0, MAX_TEXT_IN);
  const c: Ctx = base;
  const cmd = commandOf(text);
  if (cmd) return handleCommand(c, cmd);
  c.cards = await eligibleCards();
  return handleText(c, text);
}

/**
 * Entrada del bot (WhatsApp y Telegram): un mensaje ya autenticado (firma/secreto y remitente validados, mensaje reclamado) → una respuesta
 * por `io.sendText`, a `replyAddress(msg)` (`msg.replyTo ?? msg.from`, con el ajuste de móviles de México en WhatsApp).
 * NUNCA lanza: cualquier fallo se convierte en un aviso genérico, y un fallo al responder no deshace lo ya guardado.
 */
export async function handleInbound(msg: InboundMessage, sender: Sender, io: WhatsAppIO, deps: HandleDeps = {}): Promise<void> {
  let out: Outcome;
  try {
    out = await route(msg, sender, io, deps);
  } catch (e) {
    console.error("[chat] error al procesar un mensaje:", ((e as Error)?.message ?? "").slice(0, 160));
    out = { reply: R.INTERNAL_ERROR, status: "failed" };
  }
  try {
    await finishMessage(msg.id, out.status, { txId: out.txId ?? null, documentId: out.documentId ?? null });
  } catch (e) {
    console.error("[chat] no se pudo cerrar el mensaje:", ((e as Error)?.message ?? "").slice(0, 120));
  }
  try {
    await io.sendText(replyAddress(msg), R.clip(out.reply));
  } catch {
    /* un fallo de red al responder no debe romper nada */
  }
}
