/** Normaliza el comercio para reglas y deduplicación: MAYÚSCULAS, sin acentos, sin referencias. */
export function normalizeMerchant(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/#\s?\d+/g, " ") // #1234
    .replace(/\b\d{4,}\b/g, " ") // folios largos
    .replace(/[^A-Z0-9&*\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
