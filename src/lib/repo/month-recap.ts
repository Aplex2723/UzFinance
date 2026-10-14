import { generateVerified } from "@/lib/llm/verified";
import { buildMonthFacts, MONTH_SYSTEM, monthRecapHash, monthRecapKey, type MonthExtras } from "@/lib/month-recap";
import { getRecapAt, saveRecapAt, type StoredRecap } from "./ai-recaps";
import { getGoalsOverview } from "./goals-plan";
import type { Insights } from "./insights";
import { getMsi } from "./plans";

export const getMonthRecap = (month: string) => getRecapAt(monthRecapKey(month));

/** MSI y metas que acompañan al análisis del mes. */
export async function getMonthExtras(now = new Date()): Promise<MonthExtras> {
  const [msi, goals] = await Promise.all([getMsi(now), getGoalsOverview(now)]);
  const pending = goals.summary.plans.filter((p) => p.status !== "done").length;
  return {
    msi: { loadNow: msi.loadNow, remaining: msi.remainingTotal, active: msi.active.length, freeMonth: msi.freeMonth },
    goals: goals.goals.length ? { pending, onTime: goals.summary.counts.on_track + goals.summary.counts.tight, surplus: Math.max(0, goals.capacity.surplus) } : null,
  };
}

export type MonthRecapDeps = { apiKey: string; model: string; now?: Date; fetchImpl?: typeof fetch };

/** Genera el análisis del mes con el modelo (montos verificados) y lo guarda por mes. Lanza LlmError con un mensaje seguro para mostrar. */
export async function generateMonthRecap(i: Insights, extras: MonthExtras, d: MonthRecapDeps): Promise<StoredRecap> {
  const text = await generateVerified({ apiKey: d.apiKey, model: d.model, system: MONTH_SYSTEM, facts: buildMonthFacts(i, extras), fetchImpl: d.fetchImpl });
  const recap: StoredRecap = { text, at: (d.now ?? new Date()).toISOString(), hash: monthRecapHash(i), model: d.model };
  await saveRecapAt(monthRecapKey(i.month), recap);
  return recap;
}
