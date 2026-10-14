/**
 * Cliente mínimo de chat de OpenRouter (API compatible con OpenAI). Solo para texto que NO contiene datos sensibles
 * (cifras agregadas, nunca comercios ni descripciones). La API key jamás se loguea ni aparece en los errores.
 * `data_collection: "deny"` pide a OpenRouter enrutar solo a proveedores que no guardan ni entrenan con el contenido.
 */
export const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_RECAP_MODEL = "anthropic/claude-haiku-5.5";

export class LlmError extends Error {}

export type ChatOptions = {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Para pruebas. */
  fetchImpl?: typeof fetch;
};

/** Quita bloques de razonamiento (<think>…</think>) que algunos modelos mezclan con la respuesta. */
export const stripReasoning = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

export async function chat(o: ChatOptions): Promise<string> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "X-Title": "UzFinance" },
      body: JSON.stringify({
        model: o.model,
        temperature: 0.2,
        max_tokens: o.maxTokens ?? 900,
        provider: { data_collection: "deny" },
        messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 40_000),
    });
  } catch (e) {
    throw new LlmError((e as Error)?.name === "TimeoutError" ? "El modelo tardó demasiado" : "Sin conexión con el modelo");
  }
  if (!res.ok) throw new LlmError(res.status === 401 || res.status === 403 ? "La API key del modelo fue rechazada" : res.status === 402 ? "Sin saldo en OpenRouter" : res.status === 429 ? "El modelo está saturado, intenta en un momento" : `El modelo respondió ${res.status}`);
  const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const text = json?.choices?.[0]?.message?.content;
  const clean = typeof text === "string" ? stripReasoning(text) : "";
  if (!clean) throw new LlmError("El modelo devolvió una respuesta vacía");
  return clean;
}
