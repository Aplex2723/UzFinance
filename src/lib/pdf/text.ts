import { getDocumentProxy } from "unpdf";

/**
 * Lectura de la capa de texto de un PDF, con posiciones (equivalente a `extract_words` de pdfplumber).
 * El PDF es entrada NO confiable: tope de tamaño y de páginas, sin evaluar código (isEvalSupported) y sin cargar fuentes.
 * Coordenadas en puntos PDF con el origen ARRIBA a la izquierda (como pdfplumber): top/bottom crecen hacia abajo.
 */
export const PDF_MAX_BYTES = 12 * 1024 * 1024;
export const PDF_MAX_PAGES = 40;

export type PdfWord = {
  str: string; x0: number; x1: number; top: number; bottom: number;
  /** Tras este ítem el PDF trae un espacio suelto (ítem en blanco que no se guarda): sirve para no pegar palabras distintas. */
  sp?: boolean;
  /** Texto girado (vertical/diagonal, p. ej. sellos laterales): su x1/top no describen una palabra horizontal; los lectores de tablas lo ignoran. */
  rot?: boolean;
};
export type PdfPage = { page: number; width: number; height: number; words: PdfWord[] };
export type PdfText = { numPages: number; pages: PdfPage[]; /** Total de caracteres: ~0 = PDF solo de imagen (hace falta OCR). */ chars: number };

export class PdfInvalidError extends Error {}
export class PdfPasswordError extends Error {}
export class PdfTooBigError extends Error {}

export const hasPdfHeader = (b: Uint8Array) => b.length > 8 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d; // "%PDF-"

type Item = { str?: string; transform?: number[]; width?: number; height?: number };

export async function openPdf(bytes: Uint8Array, password?: string) {
  if (bytes.byteLength > PDF_MAX_BYTES) throw new PdfTooBigError("El PDF pesa demasiado");
  if (!hasPdfHeader(bytes.subarray(0, 1024))) throw new PdfInvalidError("El archivo no es un PDF");
  try {
    // pdf.js transfiere (y vacía) el buffer: se le da una copia para poder reutilizar `bytes`.
    const pdf = await getDocumentProxy(bytes.slice(), { isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, password } as never);
    if (pdf.numPages > PDF_MAX_PAGES) {
      const n = pdf.numPages;
      await (pdf as { destroy?: () => Promise<void> }).destroy?.();
      throw new PdfTooBigError(`El PDF tiene demasiadas páginas (${n})`);
    }
    return pdf;
  } catch (e) {
    if (e instanceof PdfTooBigError) throw e;
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new PdfPasswordError((e as { code?: number }).code === 2 ? "Contraseña del PDF incorrecta" : "El PDF está protegido con contraseña");
    throw new PdfInvalidError("No se pudo abrir el PDF");
  }
}

export async function readPdfText(bytes: Uint8Array, password?: string): Promise<PdfText> {
  const pdf = await openPdf(bytes, password);
  const pages: PdfPage[] = [];
  let chars = 0;
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const words: PdfWord[] = [];
      for (const it of content.items as Item[]) {
        const str = it.str ?? "";
        if (!it.transform) continue;
        if (!str.trim()) { if (str && words.length) words[words.length - 1].sp = true; continue; }
        const [a, b, , d, e, f] = it.transform;
        const height = Math.abs(it.height || d || 0);
        const rot = Math.abs(b) > 0.1 * Math.abs(a) + 0.01;
        words.push({ str, x0: e, x1: e + (it.width ?? 0), top: viewport.height - f - height, bottom: viewport.height - f, ...(rot ? { rot: true } : {}) });
        chars += str.length;
      }
      pages.push({ page: p, width: viewport.width, height: viewport.height, words });
    }
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.();
  }
  return { numPages: pages.length, pages, chars };
}

/** Agrupa las palabras de una página en renglones (misma altura ± tol), cada uno ordenado por x. */
export function groupLines(words: PdfWord[], tol = 2.5): PdfWord[][] {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines: PdfWord[][] = [];
  for (const w of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(last[0].top - w.top) <= tol) last.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0));
}

/** Texto plano por página (renglones separados por \n, palabras por espacio). */
export const pageText = (p: PdfPage) => groupLines(p.words).map((l) => l.map((w) => w.str).join(" ")).join("\n");
