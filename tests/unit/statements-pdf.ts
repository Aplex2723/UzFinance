import type { PdfText, PdfWord } from "@/lib/pdf/text";

/**
 * Constructores de `PdfText` SINTÉTICOS (datos inventados) para probar los extractores de estados de cuenta sin PDF reales.
 * Un "ítem" imita lo que entrega pdf.js: un tramo de texto con su posición (origen arriba-izquierda, `top` = parte alta).
 * Nota: aquí no se escriben caracteres Unicode raros literales (NBSP, signo menos tipográfico…): se arman con `fromCharCode`.
 */
export const NBSP = String.fromCharCode(0x00a0);
export const MINUS = String.fromCharCode(0x2212); // signo menos tipográfico
export const EM_DASH = String.fromCharCode(0x2014);
export const ZWSP = String.fromCharCode(0x200b);

export type ItemOpts = { w?: number; fs?: number; sp?: boolean };

export function item(x: number, y: number, str: string, o: ItemOpts = {}): PdfWord {
  const fs = o.fs ?? 10;
  return { str, x0: x, x1: x + (o.w ?? str.length * 5), top: y, bottom: y + fs, ...(o.sp ? { sp: true } : {}) };
}

/** Páginas hechas de ítems sueltos; `shuffle` los baraja (pdf.js no garantiza el orden de lectura). */
export function pdfOf(pages: PdfWord[][], opts: { shuffle?: boolean } = {}): PdfText {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const out = pages.map((words, i) => ({
    page: i + 1, width: 612, height: 792,
    words: opts.shuffle ? words.map((w) => [rnd(), w] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]) : words,
  }));
  return { numPages: out.length, pages: out, chars: out.reduce((s, p) => s + p.words.reduce((n, w) => n + w.str.length, 0), 0) };
}

/** Un ítem por renglón (x = 40, 12 pt entre renglones): sirve para los extractores que leen texto (Nu, Banamex crédito). */
export const linesPdf = (pages: string[][], opts: { shuffle?: boolean } = {}) => pdfOf(pages.map((ls) => ls.map((l, i) => item(40, 40 + i * 12, l))), opts);

/** Renglón con celdas [x, texto] a la altura `y`. */
export type Cell = [x: number, str: string, o?: ItemOpts];
export const row = (y: number, ...cells: Cell[]): PdfWord[] => cells.map(([x, s, o]) => item(x, y, s, o));
