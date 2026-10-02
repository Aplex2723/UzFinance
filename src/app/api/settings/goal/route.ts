import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { parseAmountToCents } from "@/lib/money";
import { getGoal, setGoal } from "@/lib/repo/goals";
import { localDate } from "@/lib/time";

export const dynamic = "force-dynamic";

const amount = z.union([z.string().trim().min(1).max(32), z.number()]);
const body = z
  .object({ name: z.string().trim().min(1).max(80), target: amount, target_date: z.iso.date(), saved: amount })
  .strict();

const cents = (v: string | number, field: string, allowZero: boolean) => {
  if (allowZero && String(v).trim().replace(/[$,\s]/g, "") === "0") return 0;
  try {
    return parseAmountToCents(v);
  } catch {
    throw new HttpError(400, `${field}: monto inválido`);
  }
};

export const GET = protectedRoute(async () => json({ goal: await getGoal() }));
export const PUT = protectedRoute(async ({ req }) => {
  const b = await readJson(req, body);
  const goal = { name: b.name, targetCents: cents(b.target, "Meta", false), targetDate: b.target_date, savedCents: cents(b.saved, "Ahorro", true), savedAsOf: localDate(new Date()) };
  if (goal.targetCents < 0 || goal.savedCents < 0) throw new HttpError(400, "Los montos no pueden ser negativos");
  try {
    await setGoal(goal);
  } catch (e) {
    if (e instanceof RangeError) throw new HttpError(400, "Datos fuera de rango");
    throw e;
  }
  return json({ goal });
});
