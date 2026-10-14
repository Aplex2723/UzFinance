import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { DEFAULT_RECAP_MODEL, LlmError } from "@/lib/llm/openrouter";
import { getInsights } from "@/lib/repo/insights";
import { generateMonthRecap, getMonthExtras } from "@/lib/repo/month-recap";
import { RateLimiter } from "@/lib/security/ratelimit";
import { currentMonth, MONTH_RE } from "@/lib/time";

export const dynamic = "force-dynamic";

const body = z.object({ month: z.string().regex(MONTH_RE) }).strict();

/** Cada análisis cuesta una llamada al modelo: tope por hora (una sola instancia, igual que el resto de límites). */
const limiter = new RateLimiter(12, 60 * 60_000);

export const POST = protectedRoute(async ({ req }) => {
  const { month } = await readJson(req, body);
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) throw new HttpError(503, "El análisis con IA no está configurado (falta OPENROUTER_API_KEY)");
  if (month > currentMonth()) throw new HttpError(400, "Ese mes aún no llega");
  if (!limiter.hit("recap")) throw new HttpError(429, `Ya generaste varios análisis; intenta de nuevo en ${Math.ceil(limiter.retryAfterSeconds("recap") / 60)} min`);
  const insights = await getInsights(month);
  if (insights.count === 0) throw new HttpError(400, "Aún no hay gastos en ese mes para analizar");
  try {
    const recap = await generateMonthRecap(insights, await getMonthExtras(), { apiKey: env.OPENROUTER_API_KEY, model: env.GOALS_LLM_MODEL ?? DEFAULT_RECAP_MODEL });
    return json({ recap });
  } catch (e) {
    if (e instanceof LlmError) throw new HttpError(502, e.message);
    throw e;
  }
});
