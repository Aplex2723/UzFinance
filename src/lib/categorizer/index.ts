import { getEnv } from "@/lib/env";
import type { Rule } from "@/lib/types";

export type CategorizeInput = { merchantRaw: string; merchantNormalized: string; amountCents: number };

/** Quién decidió la categoría: regla del usuario, historial (mismo comercio ya categorizado a mano) o Jev. */
export type CategorySource = "rule" | "history" | "jev";
export type Categorization = { categoryId: number; source: CategorySource; confidence: number | null };

/**
 * Punto de extensión: cualquier implementación (reglas, Jev, híbrida) devuelve la categoría
 * y de dónde salió, o null. La ingesta solo conoce esta interfaz.
 */
export interface Categorizer {
  categorize(input: CategorizeInput): Promise<number | null>;
  categorizeDetailed(input: CategorizeInput): Promise<Categorization | null>;
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

/**
 * timeoutMs: tope de espera a Jev. El Atajo/correo usan un tope corto (la ingesta no debe fallar ni tardar);
 * la categorización masiva usa uno mayor.
 */
export async function getCategorizer(opts: { timeoutMs?: number } = {}): Promise<Categorizer> {
  const { RulesCategorizer } = await import("./rules");
  const rules = new RulesCategorizer();
  const env = getEnv();
  if (env.CATEGORIZER === "jev" && env.OPENROUTER_API_KEY) {
    const { JevCategorizer } = await import("./jev");
    return new JevCategorizer(rules, { apiKey: env.OPENROUTER_API_KEY, timeoutMs: opts.timeoutMs ?? 2500 });
  }
  return rules;
}
