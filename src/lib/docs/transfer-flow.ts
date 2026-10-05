import { z } from "zod";
import { getCategorizer, type Categorizer } from "@/lib/categorizer";
import { ocrConfidence, ocrText, type OcrResult } from "@/lib/pdf/ocr";
import { parseBanamexTransfer, transferConflicts, type ParsedTransfer, type TransferParse } from "@/lib/pdf/receipts/banamex-transfer";
import { pageText, type PdfText } from "@/lib/pdf/text";
import { getCard } from "@/lib/repo/cards";
import { getDocument, getExtracted, patchDocument, type DocWrite } from "@/lib/repo/documents";
import { registerTransfer, rememberAccountCard, resolveOriginCard } from "@/lib/repo/transfers";
import { formatMXN } from "@/lib/money";
import { localDate } from "@/lib/time";
import { notifyTransferRegistered } from "./notify";

/**
 * Comprobante de transferencia → movimiento. Dos formas de leerlo:
 *  - PDF con texto: lectura exacta (una sola).
 *  - PDF de imagen (el de la app de Banamex): OCR local en DOS resoluciones; si los campos críticos no coinciden → revisión humana.
 * Se registra solo si TODO es inequívoco (formato conocido, estatus exitoso, lecturas iguales, fecha y monto plausibles y tarjeta
 * de origen clara). Cualquier duda deja el documento en "needs_review" con lo leído, para confirmarlo o corregirlo.
 */
/** Confianza mínima (0-100) del OCR para registrar sin revisión; los comprobantes reales salen en 92-95. */
export const OCR_MIN_CONFIDENCE = 85;
export const MAX_PLAUSIBLE_CENTS = 1_000_000_00;
const FUTURE_SLACK_MS = 36 * 3_600_000;
const PAST_LIMIT_MS = 400 * 86_400_000;

/** Lo que se guarda en documents.extracted de un comprobante (fecha en ISO). */
export type StoredTransfer = Omit<ParsedTransfer, "occurredAt"> & { occurredAt: string };
export type TransferExtract = { transfer: StoredTransfer; read: "text" | "ocr"; conflicts: string[]; reason: string | null };

const store = (t: ParsedTransfer): StoredTransfer => ({ ...t, occurredAt: t.occurredAt.toISOString() });
const revive = (t: StoredTransfer): ParsedTransfer => ({ ...t, occurredAt: new Date(t.occurredAt) });

export type TransferOutcome = { write: DocWrite; txId?: number; registered?: "inserted" | "merged" | "duplicate"; kindOfTx?: "expense" | "card_payment" };

const title = (t: ParsedTransfer) => `Transferencia ${formatMXN(t.amountCents)} · ${localDate(t.occurredAt)}`;

/** Motivos por los que un dato leído, aunque coincida, no se registra solo. */
export function plausibility(t: ParsedTransfer, now = new Date()): string | null {
  if (t.occurredAt.getTime() > now.getTime() + FUTURE_SLACK_MS) return "la fecha del comprobante está en el futuro";
  if (t.occurredAt.getTime() < now.getTime() - PAST_LIMIT_MS) return "la fecha del comprobante es de hace más de un año";
  if (t.amountCents > MAX_PLAUSIBLE_CENTS) return `el monto (${formatMXN(t.amountCents)}) es muy alto: confírmalo`;
  return null;
}

/** Une las lecturas (texto o pasadas de OCR) en un resultado o una razón de por qué no. */
export function mergeReads(parses: TransferParse[]): { kind: "ok"; transfer: ParsedTransfer; conflicts: string[] } | { kind: "rejected" | "unparsed" | "other"; reason: string } {
  const oks = parses.flatMap((p) => (p.kind === "ok" ? [p.transfer] : []));
  const rejected = parses.find((p) => p.kind === "rejected");
  // Una lectura que dice "rechazada" pesa más que cualquier "ok": nunca se registra una transferencia que pudo no concretarse.
  if (rejected && rejected.kind === "rejected") return { kind: "rejected", reason: rejected.reason };
  if (!oks.length) {
    const un = parses.find((p) => p.kind === "unparsed");
    if (un && un.kind === "unparsed") return { kind: "unparsed", reason: un.reason };
    return { kind: "other", reason: "no es un comprobante de transferencia de Banamex" };
  }
  const conflicts = new Set<string>();
  for (const o of oks.slice(1)) for (const c of transferConflicts(oks[0], o)) conflicts.add(c);
  // Si alguna lectura no pudo interpretarse mientras otra sí, tampoco hay doble confirmación.
  if (oks.length < parses.length) conflicts.add("una de las lecturas no se pudo interpretar");
  return { kind: "ok", transfer: oks[0], conflicts: [...conflicts] };
}

export async function readTransfer(pdf: PdfText, ocr: () => Promise<OcrResult>): Promise<{ read: "text" | "ocr"; parses: TransferParse[]; confidence: number | null }> {
  if (pdf.chars >= 20) return { read: "text", parses: [parseBanamexTransfer(pdf.pages.map(pageText).join("\n"))], confidence: null };
  const r = await ocr();
  return { read: "ocr", parses: r.passes.map((p) => parseBanamexTransfer(ocrText(p))), confidence: r.passes.length ? Math.min(...r.passes.map(ocrConfidence)) : 0 };
}

async function finish(t: ParsedTransfer, cardId: number, read: "text" | "ocr", deps: { categorizer: Categorizer }, extra: { merchant?: string; categoryId?: number | null; notes?: string | null; allowSuspect?: boolean } = {}): Promise<TransferOutcome> {
  const r = await registerTransfer(t, cardId, deps, extra);
  if (r.status === "suspect") {
    const reason = `parece repetida: ya hay un movimiento con el mismo monto, tarjeta y minuto pero otra clave de rastreo (¿se leyó mal la clave?). Confírmala solo si es otra transferencia`;
    return { write: { kind: "transfer_receipt", origin: "app", status: "needs_review", title: title(t), detail: `Necesita tu revisión: ${reason}.`, cardId, extracted: { transfer: store(t), read, conflicts: [], reason } satisfies TransferExtract } };
  }
  if (r.status !== "duplicate") await notifyTransferRegistered(r.id, store(t));
  const detail =
    r.status === "inserted" ? "Registrada." : r.status === "merged" ? "Ya estaba registrada por el correo del banco: se completó con los datos del comprobante." : "Esta transferencia ya estaba registrada (misma clave de rastreo).";
  return { write: { kind: "transfer_receipt", origin: "app", status: "processed", title: title(t), detail, extracted: { transfer: store(t), read, conflicts: [], reason: null } satisfies TransferExtract, cardId, txId: r.id }, txId: r.id, registered: r.status, kindOfTx: r.kind };
}

/** Decide qué hacer con un comprobante ya leído. */
export async function handleTransfer(
  merged: ReturnType<typeof mergeReads>,
  read: "text" | "ocr",
  deps: { categorizer?: Categorizer; now?: Date; confidence?: number | null } = {},
): Promise<TransferOutcome> {
  const base = { kind: "transfer_receipt", origin: "app", pages: null } as const;
  if (merged.kind !== "ok") {
    if (merged.kind === "rejected") return { write: { ...base, status: "rejected", title: "Transferencia no concretada", detail: `No se registró: ${merged.reason}.` } };
    if (merged.kind === "other") return { write: { kind: "unknown", origin: "app", status: "rejected", title: "Documento no reconocido", detail: "No es un comprobante de transferencia de Banamex ni un estado de cuenta compatible (Amex, Banamex o Nu)." } };
    return { write: { ...base, status: "failed", title: "Comprobante ilegible", detail: `No pude leer el comprobante con seguridad: ${merged.reason}. Regístrala a mano en Transacciones.` } };
  }

  const { transfer: t, conflicts } = merged;
  const review = (reason: string, cardId?: number): TransferOutcome => ({
    write: { ...base, status: "needs_review", title: title(t), detail: `Necesita tu revisión: ${reason}.`, cardId: cardId ?? null, extracted: { transfer: store(t), read, conflicts, reason } satisfies TransferExtract },
  });
  if (conflicts.length) return review(`las dos lecturas del PDF no coinciden en ${conflicts.join(", ")}`);
  if (read === "ocr" && deps.confidence != null && deps.confidence < OCR_MIN_CONFIDENCE) return review(`el OCR leyó con poca confianza (${Math.round(deps.confidence)} %): revisa los datos`);
  const odd = plausibility(t, deps.now);
  if (odd) return review(odd);
  const origin = await resolveOriginCard(t);
  if (!origin) return review(`elige de qué tarjeta salió (cuenta ···${t.originTail})`);
  return finish(t, origin.card.id, read, { categorizer: deps.categorizer ?? (await getCategorizer()) });
}

/* ───────── confirmación humana ───────── */

export const confirmSchema = z
  .object({
    card_id: z.number().int().positive(),
    /** Correcciones a lo que leyó el OCR (solo si el usuario ve que está mal en el comprobante). */
    amount_cents: z.number().int().positive().max(100_000_000_00).optional(),
    occurred_at: z.iso.datetime({ offset: true }).optional(),
    tracking_key: z.string().trim().regex(/^[A-Za-z0-9]{8,30}$/).optional(),
    auth_code: z.string().trim().regex(/^\d{3,12}$/).nullable().optional(),
    merchant: z.string().trim().min(1).max(120).optional(),
    category_id: z.number().int().positive().nullable().optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    /** Recordar que esta cuenta de origen es esta tarjeta (la próxima vez no pregunta). */
    remember: z.boolean().optional(),
  })
  .strict();
export type ConfirmInput = z.infer<typeof confirmSchema>;

export class ConfirmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function confirmTransferDocument(documentId: number, input: ConfirmInput, deps: { categorizer?: Categorizer } = {}): Promise<TransferOutcome & { documentId: number }> {
  const doc = await getDocument(documentId);
  if (!doc) throw new ConfirmError(404, "Documento no encontrado");
  if (doc.kind !== "transfer_receipt" || doc.status !== "needs_review") throw new ConfirmError(409, "Este documento no está esperando confirmación");
  const ex = await getExtracted<TransferExtract>(documentId);
  if (!ex?.transfer) throw new ConfirmError(409, "El documento no trae datos de transferencia");
  if (!(await getCard(input.card_id))) throw new ConfirmError(400, "La tarjeta no existe");

  const card = await getCard(input.card_id);
  if (!card) throw new ConfirmError(400, "La tarjeta no existe");
  if (!card.active || card.name === "Domiciliación" || card.name === "Sin asignar") throw new ConfirmError(400, "Elige una tarjeta activa (no una de sistema)");

  const t = revive(ex.transfer);
  if (input.amount_cents !== undefined) t.amountCents = input.amount_cents;
  if (input.occurred_at !== undefined) t.occurredAt = new Date(input.occurred_at);
  if (input.tracking_key !== undefined) t.trackingKey = input.tracking_key.toUpperCase();
  if (input.auth_code !== undefined) t.authCode = input.auth_code;
  // La fecha siempre debe ser plausible (el monto alto ya se le mostró al usuario, que lo confirma).
  const odd = plausibility({ ...t, amountCents: 1 });
  if (odd) throw new ConfirmError(400, odd);

  // Confirmar es la decisión humana: ya no se frena por "parece repetida".
  const out = await finish(t, input.card_id, ex.read, { categorizer: deps.categorizer ?? (await getCategorizer()) }, { merchant: input.merchant, categoryId: input.category_id, notes: input.notes, allowSuspect: true });
  // Una clave de rastreo corregida que ya existe en otro movimiento no es "registrar": es chocar con algo ajeno.
  if (out.registered === "duplicate" && input.tracking_key !== undefined) throw new ConfirmError(409, "Ya existe un movimiento con esa clave de rastreo");
  if (input.remember) await rememberAccountCard(t.originTail, input.card_id);
  await patchDocument(documentId, { status: "processed", detail: out.write.detail, title: out.write.title, txId: out.txId, cardId: input.card_id, extracted: out.write.extracted });
  return { ...out, documentId };
}
