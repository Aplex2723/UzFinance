import { createHash } from "node:crypto";
import type { Categorizer } from "@/lib/categorizer";
import { isUniqueViolation } from "@/lib/db/pool";
import { OCR_SCALES, OcrError, ocrPdf, type OcrResult } from "@/lib/pdf/ocr";
import { hasPdfHeader, PDF_MAX_BYTES, PdfInvalidError, PdfPasswordError, PdfTooBigError, readPdfText } from "@/lib/pdf/text";
import { createDocument, findDocumentBySha, rewriteDocument, type DocKind, type DocOrigin, type DocRow, type DocStatus, type DocWrite } from "@/lib/repo/documents";
import { analyzeStatement, reconcileStatements, type StatementOutcome } from "./statement-flow";
import { notifyDocumentReview } from "./notify";
import { handleTransfer, mergeReads, readTransfer } from "./transfer-flow";

/**
 * Punto de entrada ÚNICO para un PDF, venga de donde venga (hoy la app; mañana un chat de WhatsApp: solo cambia `origin`).
 * Idempotente por huella SHA-256 (el archivo en sí NO se guarda). Reglas:
 *  - Procesado / rechazado / en revisión → se devuelve lo que ya se decidió, sin repetir nada.
 *  - Fallido (p. ej. PDF con contraseña, OCR caído) → se reprocesa al volver a subirlo.
 *  - Estado de cuenta (PDF con texto) → extractores deterministas → conciliación contra lo registrado.
 *  - Comprobante de transferencia → texto exacto o OCR local con doble lectura → registro (o revisión).
 */
export class IntakeError extends Error {
  constructor(public status: 400 | 413 | 415, message: string) {
    super(message);
  }
}

export type IntakeInput = { bytes: Uint8Array; origin: DocOrigin; filename?: string; password?: string };
export type IntakeDeps = { categorizer?: Categorizer; ocr?: (b: Uint8Array) => Promise<OcrResult>; now?: Date };
const defaultOcr = (password?: string) => (b: Uint8Array) => ocrPdf(b, OCR_SCALES, password);

export type IntakeResult = {
  documentId: number;
  kind: DocKind;
  status: DocStatus;
  title: string | null;
  detail: string | null;
  /** Ya lo había procesado antes (mismo archivo). */
  already: boolean;
  txId: number | null;
  registered?: "inserted" | "merged" | "duplicate";
  /** Estado de cuenta: tarjetas por mapear antes de conciliar. */
  needsMapping?: string[];
  openFindings?: number;
  highFindings?: number;
};

const fromRow = (d: DocRow, already: boolean): IntakeResult => ({ documentId: d.id, kind: d.kind, status: d.status, title: d.title, detail: d.detail, already, txId: d.tx_id });

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function save(sha: string, size: number, existing: DocRow | null, w: DocWrite): Promise<number> {
  if (existing) {
    await rewriteDocument(existing.id, w);
    return existing.id;
  }
  try {
    return await createDocument(sha, size, w);
  } catch (e) {
    // Dos subidas simultáneas del mismo archivo: gana la primera.
    if (isUniqueViolation(e)) {
      const again = await findDocumentBySha(sha);
      if (again) return again.id;
    }
    throw e;
  }
}

export async function processDocument(input: IntakeInput, deps: IntakeDeps = {}): Promise<IntakeResult> {
  const { bytes, origin } = input;
  if (bytes.byteLength === 0) throw new IntakeError(400, "El archivo está vacío");
  if (bytes.byteLength > PDF_MAX_BYTES) throw new IntakeError(413, "El PDF pesa demasiado (máximo 12 MB)");
  if (!hasPdfHeader(bytes.subarray(0, 1024))) throw new IntakeError(415, "El archivo no es un PDF");

  const sha = sha256(bytes);
  const existing = await findDocumentBySha(sha);
  if (existing && existing.status !== "failed") return fromRow(existing, true);
  const retry = existing;

  const failed = (detail: string, kind: DocKind = "unknown"): Promise<IntakeResult> =>
    save(sha, bytes.byteLength, retry, { kind, origin, status: "failed", title: "No se pudo leer el PDF", detail }).then((id) => ({ documentId: id, kind, status: "failed", title: "No se pudo leer el PDF", detail, already: false, txId: null }));

  let pdf;
  try {
    pdf = await readPdfText(bytes, input.password);
  } catch (e) {
    if (e instanceof PdfPasswordError) return failed(`${e.message}. Súbelo de nuevo indicando la contraseña.`);
    if (e instanceof PdfTooBigError || e instanceof PdfInvalidError) return failed(e.message);
    throw e;
  }

  // 1) ¿Estado de cuenta? Solo PDFs con capa de texto: la extracción es determinista, nunca por OCR.
  const stmt = pdf.chars >= 200 ? analyzeStatement(pdf) : null;
  if (stmt && stmt.kind === "ok") {
    const id = await save(sha, bytes.byteLength, retry, {
      kind: "statement", origin, status: "needs_review", title: stmt.title, detail: "Conciliando…", extracted: { statements: stmt.docs },
      periodStart: stmt.periodStart, periodEnd: stmt.periodEnd, pages: pdf.numPages,
    });
    const o: StatementOutcome = await reconcileStatements(id);
    if (o.status === "needs_review") await notifyDocumentReview(id, stmt.title, o.detail);
    return { documentId: id, kind: "statement", status: o.status, title: stmt.title, detail: o.detail, already: false, txId: null, needsMapping: o.needsMapping, openFindings: o.openFindings, highFindings: o.highFindings };
  }

  // 2) ¿Comprobante de transferencia? Texto exacto, o OCR local si el PDF es de imagen.
  let read;
  try {
    read = await readTransfer(pdf, () => (deps.ocr ?? defaultOcr(input.password))(bytes));
  } catch (e) {
    if (e instanceof OcrError) return failed(`${e.message}. Vuelve a subirlo en un momento.`, "transfer_receipt");
    throw e;
  }
  const merged = mergeReads(read.parses);
  const out = await handleTransfer(merged, read.read, { categorizer: deps.categorizer, now: deps.now, confidence: read.confidence });
  // Un PDF con texto que no es ni estado ni comprobante se rechaza con la razón del detector de estados, si la hay.
  const w: DocWrite = { ...out.write, origin, pages: pdf.numPages };
  if (w.status === "rejected" && w.kind === "unknown" && stmt && stmt.kind === "unknown") w.detail = `${w.detail} (${stmt.reason})`;
  const id = await save(sha, bytes.byteLength, retry, w);
  if (w.status === "needs_review") await notifyDocumentReview(id, w.title ?? null, w.detail ?? null);
  return { documentId: id, kind: w.kind, status: w.status, title: w.title ?? null, detail: w.detail ?? null, already: false, txId: out.txId ?? null, registered: out.registered };
}
