import { buildRecapFacts, RECAP_SYSTEM, recapHash } from "@/lib/goals-recap";
import { generateVerified } from "@/lib/llm/verified";
import { getRecapAt, saveRecapAt, type StoredRecap } from "./ai-recaps";
import type { GoalsOverview } from "./goals-plan";

const KEY = "goals_recap";
export type { StoredRecap };

export const getRecap = () => getRecapAt(KEY);

export type RecapDeps = { apiKey: string; model: string; now?: Date; fetchImpl?: typeof fetch };

/** Genera el resumen de metas con el modelo (montos verificados) y lo guarda. Lanza LlmError con un mensaje seguro para mostrar. */
export async function generateRecap(o: GoalsOverview, d: RecapDeps): Promise<StoredRecap> {
  const facts = buildRecapFacts(o.summary, o.capacity, o.categories, o.scenarios);
  const text = await generateVerified({ apiKey: d.apiKey, model: d.model, system: RECAP_SYSTEM, facts, fetchImpl: d.fetchImpl });
  const recap: StoredRecap = { text, at: (d.now ?? new Date()).toISOString(), hash: recapHash(o.summary, o.capacity), model: d.model };
  await saveRecapAt(KEY, recap);
  return recap;
}
