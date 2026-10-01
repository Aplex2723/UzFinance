import { parseAmountToCents } from "@/lib/money";
import type { RawTransaction, TransactionSource } from "./types";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 5000;

/** Parser CSV mínimo (RFC 4180): comillas, comillas escapadas, saltos dentro de campo. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === "," || c === ";") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const HEADERS: Record<string, "date" | "merchant" | "amount" | "card" | "category" | "notes"> = {
  date: "date", fecha: "date",
  merchant: "merchant", comercio: "merchant", descripcion: "merchant", descripción: "merchant",
  amount: "amount", monto: "amount", importe: "amount",
  card: "card", tarjeta: "card",
  category: "category", categoria: "category", categoría: "category",
  notes: "notes", notas: "notes",
};

function parseDate(s: string): Date {
  const v = s.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else throw new Error("fecha inválida (usa AAAA-MM-DD o DD/MM/AAAA)");
  // 18:00 UTC = mediodía en CDMX: cae siempre en el mismo día local.
  const date = new Date(Date.UTC(y, m - 1, d, 18, 0, 0));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 2000) throw new Error("fecha inválida");
  return date;
}

/**
 * CSV genérico: columnas date, merchant, amount, card (obligatorias) y
 * category, notes (opcionales). Acepta encabezados en español.
 */
export const csvSource: TransactionSource<string> = {
  kind: "statement",
  parse(text) {
    const errors: { line: number; message: string }[] = [];
    const rows: RawTransaction[] = [];
    const table = parseCsvText(text);
    if (table.length === 0) return { rows, errors: [{ line: 1, message: "archivo vacío" }] };
    const map: Record<string, number> = {};
    table[0].forEach((h, i) => {
      const key = HEADERS[h.trim().toLowerCase()];
      if (key && !(key in map)) map[key] = i;
    });
    for (const req of ["date", "merchant", "amount", "card"]) {
      if (!(req in map)) errors.push({ line: 1, message: `falta la columna "${req}"` });
    }
    if (errors.length) return { rows, errors };
    if (table.length - 1 > CSV_MAX_ROWS) return { rows, errors: [{ line: 1, message: `máximo ${CSV_MAX_ROWS} filas` }] };
    table.slice(1).forEach((cells, idx) => {
      const line = idx + 2;
      try {
        const get = (k: string) => (k in map ? (cells[map[k]] ?? "").trim() : "");
        const merchant = get("merchant");
        const card = get("card");
        if (!merchant || merchant.length > 120) throw new Error("comercio vacío o muy largo");
        if (!card || card.length > 80) throw new Error("tarjeta vacía o muy larga");
        rows.push({
          merchant,
          cardRef: card,
          amountCents: parseAmountToCents(get("amount")),
          occurredAt: parseDate(get("date")),
          categoryName: get("category") || undefined,
          notes: get("notes").slice(0, 500) || undefined,
        });
      } catch (e) {
        errors.push({ line, message: (e as Error).message });
      }
    });
    return { rows, errors };
  },
};
