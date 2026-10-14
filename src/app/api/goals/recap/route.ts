import { HttpError, json, protectedRoute } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { DEFAULT_RECAP_MODEL, LlmError } from "@/lib/llm/openrouter";
import { getGoalsOverview } from "@/lib/repo/goals-plan";
import { generateRecap } from "@/lib/repo/goals-recap";
import { RateLimiter } from "@/lib/security/ratelimit";

export const dynamic = "force-dynamic";

/** Cada resumen cuesta una llamada al modelo: tope por hora (una sola instancia, igual que el resto de límites). */
const recapLimiter = new RateLimiter(8, 60 * 60_000);

export const POST = protectedRoute(async () => {
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) throw new HttpError(503, "El resumen con IA no está configurado (falta OPENROUTER_API_KEY)");
  if (!recapLimiter.hit("recap")) throw new HttpError(429, `Ya generaste varios resúmenes; intenta de nuevo en ${Math.ceil(recapLimiter.retryAfterSeconds("recap") / 60)} min`);
  const overview = await getGoalsOverview();
  if (!overview.goals.length) throw new HttpError(400, "Crea al menos una meta para generar el resumen");
  if (overview.capacity.basis === "none") throw new HttpError(400, "Configura tu ingreso mensual y registra gastos para poder generar el resumen");
  try {
    const recap = await generateRecap(overview, { apiKey: env.OPENROUTER_API_KEY, model: env.GOALS_LLM_MODEL ?? DEFAULT_RECAP_MODEL });
    return json({ recap });
  } catch (e) {
    if (e instanceof LlmError) throw new HttpError(502, e.message);
    throw e;
  }
});
