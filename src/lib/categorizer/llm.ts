import type { CategorizeInput, Categorizer } from "./index";

/**
 * STUB documentado. Se activa con CATEGORIZER=llm.
 *
 * Hoy solo delega en las reglas. Para enchufar un LLM: implementar `suggest()`
 * (p. ej. con el SDK de Anthropic), devolver el category_id o null, y cuidar:
 *   - enviar SOLO el comercio normalizado (nunca monto, tarjeta ni notas);
 *   - tope de tiempo (≤3 s) y fallback a reglas: la ingesta no debe fallar;
 *   - la API key como app setting, nunca en el repo.
 */
export class LlmCategorizer implements Categorizer {
  constructor(private fallback: Categorizer) {}

  async categorize(input: CategorizeInput): Promise<number | null> {
    const byRules = await this.fallback.categorize(input);
    if (byRules !== null) return byRules;
    return this.suggest(input);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async suggest(_input: CategorizeInput): Promise<number | null> {
    return null; // TODO: integrar proveedor LLM
  }
}
