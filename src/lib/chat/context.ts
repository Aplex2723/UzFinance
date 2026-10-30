import { listCards } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { getMonthlyIncome } from "@/lib/repo/settings";
import type { PromptContext } from "./prompt";
import type { ToolCtx } from "./tools";

/** Lo que el agente necesita saber al empezar: ingreso, categorías y tarjetas activas (una consulta corta por mensaje). */
export async function loadChatContext(now = new Date()): Promise<PromptContext & ToolCtx> {
  const [income, categories, cards] = await Promise.all([getMonthlyIncome(), listCategories(), listCards()]);
  return { now, income, categories, cards };
}
