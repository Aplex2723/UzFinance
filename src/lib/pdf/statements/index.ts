import { docSchema, type StatementDoc } from "@/lib/import/statements";
import type { PdfText } from "../text";
import { extractAmex } from "./amex";
import { extractBanamexCredit } from "./banamex-credit";
import { extractBanamexDebit } from "./banamex-debit";
import { makeCheck, makeDoc, norm, pageLines, type RawDoc } from "./common";
import { extractNu } from "./nu";

/**
 * Lectura de estados de cuenta PDF (Amex, Nu, Banamex crédito y débito) en el servidor: port a TypeScript de
 * scripts/statements/*.py. Entrada: el texto con posiciones de `readPdfText`. Salida: el MISMO JSON normalizado que
 * producen los extractores de Python (esquema `docSchema` de src/lib/import/statements.ts).
 *
 * Contrato con quien llama:
 *  - `detectStatement` dice de qué banco es el PDF o por qué no se puede leer (nunca lanza).
 *  - `extractStatement` solo lanza si el PDF no es de ningún banco conocido. Con datos raros NO lanza: devuelve
 *    `warnings` y `checks` con ok=false; quien llama debe tratar un check fallido como "necesita revisión" (los checks son
 *    las sumas y conteos contra los totales impresos en el propio estado: la defensa contra una extracción errónea).
 *
 * Diferencia con Python: allá `document` y `card_key` de la tarjeta Banamex salen del NOMBRE DEL ARCHIVO
 * ("Estado de cuenta_explora.pdf"); aquí salen del producto impreso en el PDF ("Tarjeta de Crédito EXPLORA BANAMEX" ->
 * explora / explora_stmt). Para Amex, Nu y débito son fijos (amex_stmt, nu_stmt, debito_stmt).
 */
export type StatementKind = "amex" | "nu" | "banamex_credit" | "banamex_debit";
/** `StatementDoc` más los campos que siempre agregan los extractores (la validación del esquema es "loose" y los conserva). */
export type ExtractedStatement = StatementDoc & {
  warnings: string[];
  statement_kind: StatementKind;
  summary?: Record<string, unknown>;
  installment_postings?: Record<string, unknown>[];
};
export type { StatementDoc };

const MIN_CHARS = 40;

/** Texto de las primeras páginas, en minúsculas, sin acentos y con espacios colapsados (para reconocer el banco). */
function headText(pdf: PdfText, pages = 3): string {
  return norm(pdf.pages.slice(0, pages).flatMap((p) => pageLines(p)).join("\n")).replace(/[ \t]+/g, " ");
}

export function detectStatement(pdf: PdfText): { kind: StatementKind } | { kind: null; reason: string } {
  if (pdf.numPages === 0 || pdf.chars < MIN_CHARS) {
    return { kind: null, reason: "El PDF no tiene texto seleccionable (parece una imagen o un escaneo). Descarga el estado de cuenta en PDF desde la banca en línea." };
  }
  const t = headText(pdf);
  if (/american express/.test(t) && /\d{4}-\d{6}-\d{5}/.test(t) && /estado de cuenta/.test(t)) return { kind: "amex" };
  if (/periodo: ?\d{2} [a-z]{3} \d{4} al \d{2} [a-z]{3} \d{4}/.test(t) && /tarjeta de credito nu|nu\.com\.mx|nu mexico/.test(t)) return { kind: "nu" };
  if (/estado de cuenta mensual/.test(t) && /tarjeta de credito/.test(t) && /banamex/.test(t) && /periodo: ?\d{1,2}-[a-z]{3}-\d{4} al \d{1,2}-[a-z]{3}-\d{4}/.test(t)) return { kind: "banamex_credit" };
  if (/micuenta/.test(t) && /periodo del \d{1,2} de [a-z]+ al \d{1,2} de [a-z]+ del \d{4}/.test(t)) return { kind: "banamex_debit" };
  return { kind: null, reason: "No parece un estado de cuenta de Banamex (crédito o débito), Nu o American Express." };
}

const EPOCH = "1970-01-01";
const failed = (doc: RawDoc, name: string, expected: number, actual: number) => doc.checks.push(makeCheck(name, expected, actual, 0, "count"));

/**
 * Deja el documento listo para `docSchema`: sin lanzar por datos raros. Lo que falta o no cabe en el esquema se corrige
 * con un valor neutro Y se anota un warning y un check fallido, para que el llamador lo mande a revisión.
 */
function finalize(doc: RawDoc, kind: StatementKind): ExtractedStatement {
  const dates = doc.transactions.map((t) => t.date).filter((d): d is string => !!d).sort();
  if (!doc.period) {
    doc.period = { start: dates[0] ?? doc.as_of ?? EPOCH, end: doc.as_of ?? dates.at(-1) ?? EPOCH };
    doc.warnings.push("no se encontro el periodo del estado: se dedujo de las fechas de los movimientos");
    failed(doc, "periodo del estado encontrado", 1, 0);
  }
  if (!doc.as_of) {
    doc.as_of = doc.period.end;
    doc.warnings.push("no se encontro la fecha de corte: se usa el fin del periodo");
    failed(doc, "fecha de corte encontrada", 1, 0);
  }
  let noDate = 0;
  for (const t of doc.transactions) {
    if (!t.date) { t.date = doc.period.end; noDate++; }
    t.merchant = (t.merchant || "").trim().slice(0, 200) || t.raw.slice(0, 200) || "(sin descripcion)";
  }
  if (noDate) {
    doc.warnings.push(`${noDate} movimientos sin fecha legible: se les puso el fin del periodo`);
    failed(doc, "movimientos con fecha (sin fecha = 0)", 0, noDate);
  }
  const plans = doc.plans.filter((p) => p.original_cents > 0 && p.n_total >= 1 && p.merchant.trim());
  if (plans.length !== doc.plans.length) {
    doc.warnings.push(`${doc.plans.length - plans.length} planes MSI con datos invalidos descartados`);
    failed(doc, "planes MSI validos (descartados = 0)", 0, doc.plans.length - plans.length);
    doc.plans = plans;
  }
  doc.statement_kind = kind;
  const parsed = docSchema.safeParse(doc);
  if (parsed.success) return parsed.data as ExtractedStatement;
  doc.warnings.push(`el documento no cumple el esquema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  failed(doc, "documento valido segun el esquema", 0, 1);
  return doc as unknown as ExtractedStatement;
}

/** Un documento (o ninguno) por PDF: los cuatro tipos de estado traen una sola cuenta. */
export function extractStatement(pdf: PdfText, kind?: StatementKind): ExtractedStatement[] {
  let k = kind;
  if (!k) {
    const d = detectStatement(pdf);
    if (d.kind === null) throw new Error(d.reason);
    k = d.kind;
  }
  let doc: RawDoc;
  try {
    doc = k === "amex" ? extractAmex(pdf) : k === "nu" ? extractNu(pdf) : k === "banamex_credit" ? extractBanamexCredit(pdf) : extractBanamexDebit(pdf);
  } catch (e) {
    // Defensa en profundidad: un PDF con la forma de un estado conocido pero con algo inesperado no debe tumbar la carga.
    doc = makeDoc(k === "amex" ? "amex_stmt" : k === "nu" ? "nu_stmt" : k === "banamex_debit" ? "debito_stmt" : "banamex_stmt", k === "banamex_credit" ? "banamex" : k === "banamex_debit" ? "debito" : k, null, null);
    doc.warnings.push(`error inesperado al leer el estado: ${(e as Error).message}`);
    failed(doc, "extraccion completa", 0, 1);
  }
  return [finalize(doc, k)];
}
