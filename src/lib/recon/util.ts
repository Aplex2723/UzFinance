import { createHash } from "node:crypto";
import { normalizeMerchant } from "@/lib/merchant";

const dayMs = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Días de calendario entre dos fechas YYYY-MM-DD (absoluto). Maneja cambios de mes y año. */
export const dayDiff = (a: string, b: string): number => Math.abs(parse(a) - parse(b)) / dayMs;
export const shiftDay = (d: string, n: number): string => new Date(parse(d) + n * dayMs).toISOString().slice(0, 10);

/** Recorta a n unidades UTF-16 (la longitud de las columnas NVARCHAR) sin partir un emoji por la mitad. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Texto hostil → texto plano corto para mensajes (sin saltos de línea ni caracteres de control). */
export function plain(s: string, n = 60): string {
  const cleaned = s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();
  const c = clip(cleaned, n);
  return c.length < cleaned.length ? `${c}\u2026` : c;
}

export function fingerprint(...parts: (string | number | null | undefined)[]): string {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 40);
}

const tokensOf = (norm: string) => norm.split(/[\s&*]+/).filter((x) => x.length > 0);

export type MerchantKey = { norm: string; compact: string; tokens: string[] };
export function merchantKey(raw: string): MerchantKey {
  const norm = normalizeMerchant(raw);
  return { norm, compact: norm.replace(/[^A-Z0-9]/g, ""), tokens: tokensOf(norm) };
}

/**
 * Similitud 0..1 entre dos comercios (ya con merchantKey). Determinista y barata; solo sirve para desempatar y para
 * emparejar montos distintos, nunca para decidir que dos cargos son "el mismo" si el monto coincide.
 */
export function similarity(a: MerchantKey, b: MerchantKey): number {
  if (!a.compact || !b.compact) return 0;
  if (a.compact === b.compact) return 1;
  const [short, long] = a.compact.length <= b.compact.length ? [a.compact, b.compact] : [b.compact, a.compact];
  if (short.length >= 4 && long.includes(short)) return 0.9;
  const setB = new Set(b.tokens);
  const common = a.tokens.filter((t) => t.length >= 2 && setB.has(t)).length;
  if (common > 0) return Math.min(0.85, 0.5 + 0.35 * (common / Math.min(a.tokens.length, b.tokens.length)));
  // Mismo inicio largo ("AMAZON" vs "AMAZONMX"): los estados cortan o pegan sufijos.
  let p = 0;
  while (p < short.length && short[p] === long[p]) p++;
  if (p >= 5) return 0.6;
  return 0;
}
