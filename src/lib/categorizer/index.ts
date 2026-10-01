import { getEnv } from "@/lib/env";
import type { Rule } from "@/lib/types";

export type CategorizeInput = { merchantRaw: string; merchantNormalized: string; amountCents: number };

/**
 * Punto de extensión: cualquier implementación (reglas, LLM, híbrida) devuelve
 * un category_id o null. La ingesta solo conoce esta interfaz.
 */
export interface Categorizer {
  categorize(input: CategorizeInput): Promise<number | null>;
}

export function matchRule(rules: Rule[], merchantNormalized: string): number | null {
  const m = merchantNormalized;
  // Más prioridad primero; a igual prioridad, patrón más específico (largo).
  const ordered = [...rules].sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length);
  for (const r of ordered) {
    const p = r.pattern.toUpperCase();
    if (
      (r.match_type === "exact" && m === p) ||
      (r.match_type === "startswith" && m.startsWith(p)) ||
      (r.match_type === "contains" && m.includes(p))
    ) {
      return r.category_id;
    }
  }
  return null;
}

export async function getCategorizer(): Promise<Categorizer> {
  const { RulesCategorizer } = await import("./rules");
  const rules = new RulesCategorizer();
  if (getEnv().CATEGORIZER === "llm") {
    const { LlmCategorizer } = await import("./llm");
    return new LlmCategorizer(rules);
  }
  return rules;
}
