import { CHAT_URL, LlmError, statusMessage } from "./openrouter";

/**
 * Chat de OpenRouter con herramientas y respuesta en streaming (SSE). Es el cliente de UzChat: a diferencia de `chat()` (una sola
 * respuesta de texto, sin herramientas) aquí el modelo puede pedir llamadas a funciones y el texto llega a pedazos. La API key jamás
 * se loguea ni aparece en los errores.
 */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type StreamOptions = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** "none" obliga a responder con texto (se usa en la última vuelta del agente). */
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  timeoutMs?: number;
  /** Cancelación del cliente (cerró el chat): corta la llamada al modelo y deja de gastar tokens. */
  signal?: AbortSignal;
  /** Para pruebas. */
  fetchImpl?: typeof fetch;
};

export type StreamResult = { text: string; toolCalls: ToolCall[]; finishReason: string | null };
export type StreamPart = { kind: "text"; delta: string } | { kind: "end"; result: StreamResult };

type Chunk = {
  /** Marca interna: llegó el `data: [DONE]` final. */
  done?: true;
  error?: unknown;
  choices?: { finish_reason?: string | null; delta?: { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
};

/** Reparte el cuerpo SSE en eventos `data:` ya parseados (ignora comentarios `: …` y el `[DONE]` final). */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Chunk> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const parse = (line: string): Chunk | null => {
    if (!line.startsWith("data:")) return null;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return { done: true };
    if (!data) return null;
    try { return JSON.parse(data) as Chunk; } catch { return null; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const c = parse(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
        if (c) yield c;
      }
    }
    const tail = parse(buf.replace(/\r$/, ""));
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Una llamada al modelo: emite el texto conforme llega y termina con el resultado completo (texto + llamadas a herramientas). */
export async function* streamChat(o: StreamOptions): AsyncGenerator<StreamPart> {
  const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(o.timeoutMs ?? 60_000)]);
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json", "X-Title": "UzFinance" },
      body: JSON.stringify({
        model: o.model,
        stream: true,
        temperature: 0.3,
        max_tokens: o.maxTokens ?? 1500,
        // Sin "razonamiento": Haiku 5.5 piensa por defecto y esos tokens se comen el tope (ver docs/GUIA.md).
        reasoning: { effort: "none" },
        provider: { data_collection: "deny" },
        messages: o.messages,
        ...(o.tools?.length ? { tools: o.tools.map((t) => ({ type: "function", function: t })), tool_choice: o.toolChoice ?? "auto" } : {}),
      }),
      signal,
    });
  } catch {
    throw new LlmError(o.signal?.aborted ? "Cancelado" : signal.aborted ? "El modelo tardó demasiado" : "Sin conexión con el modelo");
  }
  if (!res.ok || !res.body) throw new LlmError(statusMessage(res.status));

  let text = "";
  let finishReason: string | null = null;
  const calls: ToolCall[] = [];
  const slot = new Map<number, ToolCall>();
  let sawDone = false;
  try {
    for await (const chunk of sseChunks(res.body)) {
      if (chunk.done) { sawDone = true; continue; }
      if (chunk.error) throw new LlmError("El modelo falló a media respuesta; intenta de nuevo");
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta?.content;
      if (typeof delta === "string" && delta) { text += delta; yield { kind: "text", delta }; }
      for (const tc of choice.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        let cur = slot.get(i);
        // Algunos proveedores mandan varias llamadas en paralelo con el mismo `index` pero distinto `id`: cada `id` es una llamada.
        if (!cur || (tc.id && cur.id && tc.id !== cur.id)) { cur = { id: "", name: "", arguments: "" }; calls.push(cur); slot.set(i, cur); }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError(o.signal?.aborted ? "Cancelado" : signal.aborted ? "El modelo tardó demasiado" : "Se cortó la conexión con el modelo");
  }
  // Un flujo que se cierra sin `finish_reason` ni `[DONE]` se cortó a medias: nunca se toma por una respuesta completa.
  if (!finishReason && !sawDone) throw new LlmError("Se cortó la conexión con el modelo");
  // Un texto cortado por el tope de tokens nunca se muestra como si estuviera completo.
  if (finishReason === "length") throw new LlmError("El modelo cortó la respuesta; intenta de nuevo");
  const toolCalls = calls.map((c, i) => ({ ...c, id: c.id || `call_${i}` })).filter((c) => c.name);
  yield { kind: "end", result: { text, toolCalls, finishReason } };
}
