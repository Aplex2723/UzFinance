import { z } from "zod";
import { parseAmountToCents } from "@/lib/money";
import { CARD_ART_IDS } from "@/lib/card-art";
import { MONTH_RE } from "@/lib/time";
import { isRealDate, MAX_CARDS, parseFlag, parseId, parsePesos, PERIOD_PRESETS, rangeError, SORT_IDS, SOURCE_IDS } from "@/lib/tx-filters";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color hex #RRGGBB");
const last4 = z.string().regex(/^\d{3,4}$/).nullable().optional().transform((v) => v ?? null);
const optText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));

export const cardSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    issuer: z.enum(["amex", "banamex", "nu", "other"]),
    last4,
    aliases: optText(300),
    color: color.default("#ff4d1c"),
    art: z.enum(CARD_ART_IDS).nullable().optional().transform((v) => v ?? null),
    active: z.boolean().optional(),
  })
  .strict();

export const categorySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: color.default("#9ca3af"),
    // undefined = no tocar la descripción (el editor de nombre/color no la manda); "" o null = borrarla.
    description: z.string().trim().max(400).nullable().optional().transform((v) => (v === undefined ? undefined : v ? v : null)),
  })
  .strict();

export const ruleSchema = z
  .object({
    pattern: z.string().trim().min(2).max(120),
    match_type: z.enum(["contains", "exact", "startswith"]).default("contains"),
    category_id: z.number().int().positive(),
    priority: z.number().int().min(-1000).max(1000).default(0),
  })
  .strict();

export const transactionSchema = z
  .object({
    date: z.iso.datetime({ offset: true }),
    amount: z.union([z.string().trim().min(1).max(32), z.number()]).transform((v, ctx) => {
      try {
        return parseAmountToCents(v);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: (e as Error).message });
        return z.NEVER;
      }
    }),
    merchant: z.string().trim().min(1).max(120),
    card_id: z.number().int().positive(),
    category_id: z.number().int().positive().nullable().optional().transform((v) => v ?? null),
    notes: optText(500),
  })
  .strict();

export const idParam = z.coerce.number().int().positive();

/** Parámetro repetible (`?card=1&card=2`): acepta uno o varios, sin duplicados, hasta `max`. */
const repeatable = <T extends z.ZodType>(item: T, max: number) =>
  z.union([item, z.array(item).max(max)]).optional().transform((v) => (v === undefined ? undefined : ([...new Set(Array.isArray(v) ? v : [v])] as z.output<T>[])));

const cardId = z.string().refine((s) => parseId(s) !== null, "id de tarjeta inválido").transform(Number);
const dateParam = z.string().refine(isRealDate, "fecha inválida (YYYY-MM-DD)");
const flag = z.string().transform((s, ctx) => {
  const b = parseFlag(s);
  if (b === null) { ctx.addIssue({ code: "custom", message: "debe ser 1/true o 0/false" }); return z.NEVER; }
  return b;
});
const pesos = z.string().transform((s, ctx) => {
  const c = parsePesos(s);
  if (c === null) { ctx.addIssue({ code: "custom", message: "monto en pesos inválido (ej. 150 o 99.50, hasta $100,000,000)" }); return z.NEVER; }
  return c;
});

/**
 * Consulta de GET /api/transactions (y de la pantalla Transacciones, que usa el parseo tolerante de tx-filters). ESTRICTA: un valor
 * inválido es 400. `card` y `source` se pueden repetir; `min`/`max` entran en PESOS y salen en CENTAVOS; `from`/`to`/`min`/`max`
 * se validan juntos (from ≤ to, tope de 5 años, min ≤ max). `preset` solo se valida: la API no lo necesita.
 */
export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  card: repeatable(cardId, MAX_CARDS),
  category: z.union([z.literal("none"), z.coerce.number().int().positive()]).optional(),
  month: z.string().regex(MONTH_RE).optional(),
  from: dateParam.optional(),
  to: dateParam.optional(),
  preset: z.enum(PERIOD_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(),
  source: repeatable(z.enum(SOURCE_IDS), SOURCE_IDS.length),
  min: pesos.optional(),
  max: pesos.optional(),
  unconfirmed: flag.optional(),
  msi: flag.optional(),
  recurring: flag.optional(),
  sort: z.enum(SORT_IDS).optional(),
  kind: z.enum(["expense", "card_payment", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).superRefine((v, ctx) => {
  const err = rangeError(v.from, v.to);
  if (err) ctx.addIssue({ code: "custom", path: ["from"], message: err });
  if (v.min !== undefined && v.max !== undefined && v.min > v.max) ctx.addIssue({ code: "custom", path: ["min"], message: "'min' no puede ser mayor que 'max'" });
});
