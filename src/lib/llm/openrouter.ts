/**
 * Cliente mínimo de chat de OpenRouter (API compatible con OpenAI). Solo para texto que NO contiene datos sensibles
 * (cifras agregadas, nunca comercios ni descripciones). La API key jamás se loguea ni aparece en los errores.
 * `data_collection: "deny"` pide a OpenRouter enrutar solo a proveedores que no guardan ni entrenan con el contenido.
 */
export const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_RECAP_MODEL = "anthropic/claude-haiku-5.5";

export class LlmError extends Error {}

/** Mensaje seguro (sin detalles internos) para un estado HTTP de error de OpenRouter. */
export const statusMessage = (status: number) =>
  status === 401 || status === 403 ? "La API key del modelo fue rechazada" : status === 402 ? "Sin saldo en OpenRouter" : status === 429 ? "El modelo está saturado, intenta en un momento" : `El modelo respondió ${status}`;

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

/** El contenido puede ser texto o una lista de bloques ({type:"text", text}). */
export function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("");
  return "";
}

export async function chat(o: ChatOptions): Promise<string> {
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "X-Title": "UzFinance" },
      body: JSON.stringify({
        model: o.model,
        temperature: 0.2,
        // Sin "razonamiento": Haiku 5.5 piensa por defecto y esos tokens se comen el tope, dejando la respuesta vacía o cortada.
        max_tokens: o.maxTokens ?? 1500,
        reasoning: { effort: "none" },
        provider: { data_collection: "deny" },
        messages: [{ role: "system", content: o.system }, { role: "user", content: o.user }],
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 40_000),
    });
  } catch (e) {
    throw new LlmError((e as Error)?.name === "TimeoutError" ? "El modelo tardó demasiado" : "Sin conexión con el modelo");
  }
  if (!res.ok) throw new LlmError(statusMessage(res.status));
  const json = (await res.json().catch(() => null)) as { choices?: { finish_reason?: string; message?: { content?: unknown } }[] } | null;
  const choice = json?.choices?.[0];
  const clean = stripReasoning(contentText(choice?.message?.content));
  if (!clean) throw new LlmError("El modelo devolvió una respuesta vacía");
  // Un texto cortado por el tope de tokens nunca se muestra como si estuviera completo.
  if (choice?.finish_reason === "length") throw new LlmError("El modelo cortó la respuesta; intenta de nuevo");
  return clean;
}
