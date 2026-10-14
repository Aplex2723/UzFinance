import { chat, LlmError } from "./openrouter";

const MONEY_RE = /-?\$\s?\d[\d,]*(?:\.\d+)?/g;
const norm = (m: string) => m.replace(/[\s,]/g, "").replace(/^-/, "").replace(/\.0+$/, "");

/** Montos ("$25,000") que aparecen en el texto y NO existen en las cifras enviadas: señal de que el modelo inventó o calculó. */
export function unknownAmounts(text: string, facts: unknown): string[] {
  const allowed = new Set([...JSON.stringify(facts).matchAll(MONEY_RE)].map((m) => norm(m[0])));
  allowed.add("$0");
  return [...new Set((text.match(MONEY_RE) ?? []).filter((m) => !allowed.has(norm(m))))];
}

export type VerifiedOptions = { apiKey: string; model: string; system: string; facts: unknown; fetchImpl?: typeof fetch };

/**
 * Pide al modelo un texto a partir de un JSON de cifras y verifica que cada monto exista en esas cifras. Si trae alguno inventado
 * se pide corregir una vez; si persiste se descarta (nunca se muestra un monto que no se pueda verificar). Lanza LlmError.
 */
export async function generateVerified(o: VerifiedOptions): Promise<string> {
  const base = { apiKey: o.apiKey, model: o.model, system: o.system, fetchImpl: o.fetchImpl };
  let user = `<datos>\n${JSON.stringify(o.facts)}\n</datos>`;
  let text = await chat({ ...base, user });
  let bad = unknownAmounts(text, o.facts);
  if (bad.length) {
    user += `\n\nTu respuesta anterior incluyó montos que no están en <datos> (${bad.slice(0, 5).join(", ")}). Reescríbela usando únicamente montos copiados tal cual del JSON, sin calcular nada.`;
    text = await chat({ ...base, user });
    bad = unknownAmounts(text, o.facts);
  }
  if (bad.length) throw new LlmError("El resumen traía montos que no pude verificar; intenta de nuevo");
  return text.slice(0, 4000);
}
