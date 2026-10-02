import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { parseAmountToCents } from "@/lib/money";
import { getMonthlyIncome, MAX_INCOME_CENTS, setMonthlyIncome } from "@/lib/repo/settings";

export const dynamic = "force-dynamic";

const body = z.object({ amount: z.union([z.string().trim().min(1).max(32), z.number()]) }).strict();

export const GET = protectedRoute(async () => json({ cents: await getMonthlyIncome() }));
export const PUT = protectedRoute(async ({ req }) => {
  const { amount } = await readJson(req, body);
  let cents: number;
  try {
    cents = parseAmountToCents(amount);
  } catch {
    throw new HttpError(400, "Monto inválido");
  }
  if (cents < 0 || cents > MAX_INCOME_CENTS) throw new HttpError(400, "Monto fuera de rango");
  await setMonthlyIncome(cents);
  return json({ cents });
});
