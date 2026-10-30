import { HttpError, protectedRoute, readJson } from "@/lib/api";
import { runAgent } from "@/lib/chat/agent";
import { loadChatContext } from "@/lib/chat/context";
import { chatBody, encodeEvent } from "@/lib/chat/events";
import { getEnv } from "@/lib/env";
import { DEFAULT_RECAP_MODEL } from "@/lib/llm/openrouter";
import { RateLimiter } from "@/lib/security/ratelimit";

export const dynamic = "force-dynamic";

/** Cada mensaje son varias llamadas al modelo: tope por hora (una sola instancia, igual que el resto de límites). */
const limiter = new RateLimiter(60, 60 * 60_000);

/** Conversación completa en el cuerpo (el servidor no guarda nada) y respuesta NDJSON por streaming: ver src/lib/chat/events.ts. */
export const POST = protectedRoute(async ({ req }) => {
  const { messages } = await readJson(req, chatBody, 256 * 1024);
  const env = getEnv();
  if (!env.OPENROUTER_API_KEY) throw new HttpError(503, "UzChat no está configurado (falta OPENROUTER_API_KEY)");
  if (!limiter.hit("chat")) throw new HttpError(429, `Ya mandaste muchos mensajes; intenta de nuevo en ${Math.ceil(limiter.retryAfterSeconds("chat") / 60)} min`);

  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const events = runAgent(messages, {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.CHAT_LLM_MODEL ?? env.GOALS_LLM_MODEL ?? DEFAULT_RECAP_MODEL,
    context: await loadChatContext(),
    signal: abort.signal,
  });

  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) controller.close();
      else controller.enqueue(enc.encode(encodeEvent(next.value)));
    },
    async cancel() {
      abort.abort();
      await events.return(undefined);
    },
  });
  // no-transform + identity: ni Next ni el proxy de App Service deben comprimir (y por tanto retener) el flujo.
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "Content-Encoding": "identity", "X-Accel-Buffering": "no" } });
});
