import { z } from "zod";
import { parseAmountToCents } from "@/lib/money";
import { CARD_ART_IDS } from "@/lib/card-art";
import { MONTH_RE } from "@/lib/time";

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

export const categorySchema = z.object({ name: z.string().trim().min(1).max(60), color: color.default("#9ca3af") }).strict();

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

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  card: z.coerce.number().int().positive().optional(),
  category: z.union([z.literal("none"), z.coerce.number().int().positive()]).optional(),
  month: z.string().regex(MONTH_RE).optional(),
  kind: z.enum(["expense", "card_payment", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
