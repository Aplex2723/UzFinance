import { describe, expect, it } from "vitest";
import { LlmError } from "@/lib/llm/openrouter";
import { streamChat, type StreamOptions, type StreamPart, type StreamResult } from "@/lib/llm/stream";

const enc = new TextEncoder();
/** Respuesta SSE como la manda OpenRouter, cortada en los pedazos dados (para probar líneas partidas entre chunks). */
const sse = (chunks: string[], init: ResponseInit = { status: 200 }) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), init);
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (d: unknown, finish: string | null = null) => data({ choices: [{ delta: d, finish_reason: finish }] });

const base = (fetchImpl: typeof fetch): StreamOptions => ({ apiKey: "k".repeat(30), model: "x/y", messages: [{ role: "user", content: "hola" }], fetchImpl });
async function collect(o: StreamOptions) {
  const parts: StreamPart[] = [];
  for await (const p of streamChat(o)) parts.push(p);
  return { texts: parts.flatMap((p) => (p.kind === "text" ? [p.delta] : [])), result: (parts.find((p) => p.kind === "end") as { result: StreamResult }).result };
}

describe("streamChat (OpenRouter SSE)", () => {
  it("emite el texto conforme llega y devuelve el texto completo", async () => {
    const f = (async () => sse([": OPENROUTER PROCESSING\n\n", delta({ content: "Ho" }), delta({ content: "la" }), delta({}, "stop"), "data: [DONE]\n\n"])) as typeof fetch;
    const { texts, result } = await collect(base(f));
    expect(texts).toEqual(["Ho", "la"]);
    expect(result).toEqual({ text: "Hola", toolCalls: [], finishReason: "stop" });
  });
  it("tolera eventos partidos entre pedazos y saltos \\r\\n", async () => {
    const whole = delta({ content: "ok" }, "stop").replace(/\n/g, "\r\n");
    const f = (async () => sse([whole.slice(0, 7), whole.slice(7, 25), whole.slice(25)])) as typeof fetch;
    expect((await collect(base(f))).result.text).toBe("ok");
  });
  it("arma las llamadas a herramientas a partir de fragmentos de argumentos", async () => {
    const f = (async () => sse([
      delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "calculate", arguments: '{"expres' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'sion":"1+1"}' } }] }),
      delta({ tool_calls: [{ index: 1, id: "c2", function: { name: "savings_goals", arguments: "{}" } }] }, "tool_calls"),
    ])) as typeof fetch;
    const { result } = await collect(base(f));
    expect(result.toolCalls).toEqual([{ id: "c1", name: "calculate", arguments: '{"expression":"1+1"}' }, { id: "c2", name: "savings_goals", arguments: "{}" }]);
    expect(result.finishReason).toBe("tool_calls");
  });
  it("manda herramientas y tool_choice solo cuando hay herramientas, y pide no guardar datos", async () => {
    let body: Record<string, unknown> = {};
    const f = (async (_u: unknown, init?: RequestInit) => { body = JSON.parse(String(init?.body)); return sse([delta({ content: "a" }, "stop")]); }) as typeof fetch;
    await collect(base(f));
    expect(body).toMatchObject({ stream: true, provider: { data_collection: "deny" }, reasoning: { effort: "none" } });
    expect(body).not.toHaveProperty("tools");
    await collect({ ...base(f), tools: [{ name: "t", description: "d", parameters: { type: "object" } }], toolChoice: "none" });
    expect(body).toMatchObject({ tool_choice: "none", tools: [{ type: "function", function: { name: "t" } }] });
  });
  it("errores HTTP con mensajes seguros (sin la key)", async () => {
    const key = "SECRET-KEY-".repeat(3);
    for (const [status, msg] of [[401, /rechazada/], [402, /saldo/], [429, /saturado/], [500, /500/]] as const) {
      const f = (async () => new Response("detalle interno " + key, { status })) as typeof fetch;
      const e = await collect({ ...base(f), apiKey: key }).catch((x) => x);
      expect(e).toBeInstanceOf(LlmError);
      expect(e.message).toMatch(msg);
      expect(e.message).not.toContain("SECRET");
    }
  });
  it("un error a media respuesta o el tope de tokens no se muestran como respuesta completa", async () => {
    const mid = (async () => sse([delta({ content: "a" }), data({ error: { message: "boom" } })])) as typeof fetch;
    await expect(collect(base(mid))).rejects.toThrow(/a media respuesta/);
    const cut = (async () => sse([delta({ content: "a" }, "length")])) as typeof fetch;
    await expect(collect(base(cut))).rejects.toThrow(/cortó la respuesta/);
  });
  it("un flujo que se cierra sin finish_reason ni [DONE] se cortó a medias", async () => {
    const cut = (async () => sse([delta({ content: "a medias" })])) as typeof fetch;
    await expect(collect(base(cut))).rejects.toThrow(/Se cortó la conexión/);
    // Con [DONE] (aunque no venga finish_reason) es un final válido.
    const ok = (async () => sse([delta({ content: "ok" }), "data: [DONE]\n\n"])) as typeof fetch;
    expect((await collect(base(ok))).result.text).toBe("ok");
  });
  it("llamadas en paralelo que comparten index pero tienen distinto id son llamadas distintas", async () => {
    const f = (async () => sse([
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "calculate", arguments: '{"expression":"1+1"}' } }] }),
      delta({ tool_calls: [{ index: 0, id: "b", function: { name: "savings_goals", arguments: "{}" } }] }, "tool_calls"),
    ])) as typeof fetch;
    expect((await collect(base(f))).result.toolCalls).toEqual([{ id: "a", name: "calculate", arguments: '{"expression":"1+1"}' }, { id: "b", name: "savings_goals", arguments: "{}" }]);
  });
  it("un carácter de varios bytes partido entre pedazos no se corrompe", async () => {
    const bytes = enc.encode(delta({ content: "gasté €5 ñandú 🚀" }, "stop"));
    const cut = bytes.indexOf(0xf0) + 2; // a la mitad del emoji
    const f = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, cut)); c.enqueue(bytes.slice(cut)); c.close(); } }), { status: 200 })) as typeof fetch;
    expect((await collect(base(f))).result.text).toBe("gasté €5 ñandú 🚀");
  });
  it("sin conexión, y cancelación por la persona", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(collect(base(down))).rejects.toThrow(/Sin conexión/);
    const ac = new AbortController();
    ac.abort();
    const aborted = (async (_u: unknown, init?: RequestInit) => { if (init?.signal?.aborted) throw new DOMException("x", "AbortError"); return sse([]); }) as typeof fetch;
    await expect(collect({ ...base(aborted), signal: ac.signal })).rejects.toThrow(/Cancelado/);
  });
});
