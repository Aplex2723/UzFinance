import { z } from "zod";
import { HttpError } from "@/lib/api";
import { endOfMonth, GOAL_KINDS } from "@/lib/goals";
import { parseAmountToCents } from "@/lib/money";
import { GoalLimitError, type GoalInput } from "@/lib/repo/goals";

const amount = z.union([z.string().trim().min(1).max(32), z.number()]);
export const goalBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(GOAL_KINDS).default("otro"),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
    target: amount,
    /** Fecha exacta (YYYY-MM-DD) o, con month_only, solo el mes (YYYY-MM): se toma el último día de ese mes. */
    target_date: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
    month_only: z.boolean().default(false),
    saved: amount.default("0"),
  })
  .strict();

const cents = (v: string | number, field: string, allowZero: boolean) => {
  if (allowZero && String(v).trim().replace(/[$,\s]/g, "") === "0") return 0;
  try {
    const c = parseAmountToCents(v);
    if (c < 0 || (!allowZero && c === 0)) throw new Error();
    return c;
  } catch {
    throw new HttpError(400, `${field}: monto inválido`);
  }
};

/** Convierte el cuerpo validado en la entrada del repositorio (fecha de mes → último día del mes). */
export function toGoalInput(b: z.output<typeof goalBody>): GoalInput {
  const fullDate = /^\d{4}-\d{2}-\d{2}$/.test(b.target_date);
  if (b.month_only === fullDate) throw new HttpError(400, b.month_only ? "La fecha debe ser AAAA-MM cuando solo eliges el mes" : "La fecha debe ser AAAA-MM-DD");
  if (!b.month_only && Number.isNaN(Date.parse(`${b.target_date}T00:00:00Z`))) throw new HttpError(400, "Fecha inválida");
  const month = b.target_date.slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "Fecha inválida");
  return {
    name: b.name, kind: b.kind, priority: b.priority, monthOnly: b.month_only,
    targetCents: cents(b.target, "Meta", false), savedCents: cents(b.saved, "Ahorro", true),
    targetDate: b.month_only ? endOfMonth(month) : b.target_date,
  };
}

export const rangeToHttp = (e: unknown): never => {
  if (e instanceof RangeError) throw new HttpError(400, "Datos fuera de rango");
  if (e instanceof GoalLimitError) throw new HttpError(409, e.message);
  throw e;
};
