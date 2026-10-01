import { z } from "zod";
import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import type { RawTransaction, TransactionSource } from "./types";

const DAY = 86_400_000;

/** Contrato estricto del Atajo: claves desconocidas se rechazan. */
export const ingestSchema = z
  .object({
    merchant: z.string().trim().min(1).max(120),
    amount: z.union([z.string().trim().min(1).max(32), z.number()]),
    card: z.string().trim().min(1).max(80),
    date: z.iso.datetime({ offset: true }).optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

export type IngestPayload = z.infer<typeof ingestSchema>;

export function toRaw(p: IngestPayload, now = new Date()): RawTransaction {
  const occurredAt = p.date ? new Date(p.date) : now;
  if (occurredAt.getTime() > now.getTime() + 2 * DAY || occurredAt.getFullYear() < 2000) {
    throw new MoneyParseError("fecha fuera de rango");
  }
  return {
    merchant: p.merchant,
    amountCents: parseAmountToCents(p.amount),
    cardRef: p.card,
    occurredAt,
    notes: p.notes,
  };
}

export const shortcutSource: TransactionSource<IngestPayload> = {
  kind: "shortcut",
  parse(input) {
    try {
      return { rows: [toRaw(input)], errors: [] };
    } catch (e) {
      return { rows: [], errors: [{ line: 1, message: (e as Error).message }] };
    }
  },
};
