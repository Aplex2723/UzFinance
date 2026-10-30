import { LlmError } from "@/lib/llm/openrouter";
import { streamChat, type ChatMessage, type StreamResult, type ToolSpec } from "@/lib/llm/stream";
import type { ChatEvent, ChatTurn } from "./events";
import { buildSystemPrompt, type PromptContext } from "./prompt";
import { executeTool, TOOL_SPECS, toolLabel, type ToolCtx, type ToolOutcome } from "./tools";

/** Vueltas máximas modelo → herramientas → modelo por mensaje (la última obliga a responder con texto). */
export const MAX_ROUNDS = 6;
/** Consultas máximas por vuelta y por mensaje: un modelo desbocado no puede disparar cientos de consultas ni de vueltas caras. */
export const MAX_CALLS_PER_ROUND = 6;
export const MAX_CALLS_PER_REQUEST = 12;

export type AgentDeps = {
  apiKey: string;
  model: string;
  context: PromptContext & ToolCtx;
  signal?: AbortSignal;
  /** Para pruebas. */
  fetchImpl?: typeof fetch;
  tools?: ToolSpec[];
  runTool?: (name: string, args: string, ctx: ToolCtx) => Promise<ToolOutcome>;
};

/**
 * Bucle del agente: el modelo responde con texto (se emite en vivo) o pide herramientas; se ejecutan (en paralelo), se le devuelve el
 * resultado y se repite hasta que responde con texto. Es un generador de eventos para que la ruta los mande por streaming. Nunca lanza:
 * cualquier fallo termina en un evento `error` con un mensaje seguro para mostrar.
 */
export async function* runAgent(history: ChatTurn[], d: AgentDeps): AsyncGenerator<ChatEvent> {
  const messages: ChatMessage[] = [{ role: "system", content: buildSystemPrompt(d.context) }, ...history];
  const tools = d.tools ?? TOOL_SPECS;
  const run = d.runTool ?? executeTool;
  let wroteText = false;
  let callsMade = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const last = round === MAX_ROUNDS - 1;
      let result: StreamResult | null = null;
      let needBreak = wroteText;
      for await (const part of streamChat({ apiKey: d.apiKey, model: d.model, messages, tools, toolChoice: last ? "none" : "auto", signal: d.signal, fetchImpl: d.fetchImpl })) {
        if (part.kind === "end") { result = part.result; continue; }
        // Si ya hubo texto en una vuelta anterior (antes de pedir herramientas), la continuación va en párrafo aparte.
        if (needBreak) { yield { type: "text", delta: "\n\n" }; needBreak = false; }
        wroteText = true;
        yield { type: "text", delta: part.delta };
      }
      if (!result) throw new LlmError("El modelo no respondió");
      if (!result.toolCalls.length || last) {
        if (!wroteText) throw new LlmError("El modelo devolvió una respuesta vacía");
        yield { type: "done" };
        return;
      }

      messages.push({
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } })),
      });
      for (const c of result.toolCalls) yield { type: "tool", id: c.id, label: toolLabel(c.name), phase: "start" };
      // Las llamadas de más no se ejecutan, pero cada una recibe su resultado (el protocolo exige uno por cada `id`).
      const outcomes = await Promise.all(result.toolCalls.map((c, i) => {
        if (i >= MAX_CALLS_PER_ROUND || callsMade + i >= MAX_CALLS_PER_REQUEST) return Promise.resolve<ToolOutcome>({ ok: false, content: JSON.stringify({ error: "Demasiadas consultas en un mismo mensaje; responde con lo que ya tienes" }) });
        return run(c.name, c.arguments, d.context);
      }));
      callsMade += result.toolCalls.length;
      for (const [i, c] of result.toolCalls.entries()) {
        yield { type: "tool", id: c.id, label: toolLabel(c.name), phase: "end", ok: outcomes[i].ok };
        messages.push({ role: "tool", tool_call_id: c.id, content: outcomes[i].content });
      }
    }
  } catch (e) {
    // Cancelado por la persona: no hay nadie escuchando.
    if (d.signal?.aborted) return;
    if (e instanceof LlmError) yield { type: "error", message: e.message };
    else {
      console.error("[chat] error del agente:", (e as Error)?.message);
      yield { type: "error", message: "Algo salió mal; intenta de nuevo" };
    }
  }
}
