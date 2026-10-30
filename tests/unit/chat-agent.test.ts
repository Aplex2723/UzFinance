import { describe, expect, it, vi } from "vitest";
import { MAX_CALLS_PER_REQUEST, MAX_CALLS_PER_ROUND, MAX_ROUNDS, runAgent, type AgentDeps } from "@/lib/chat/agent";
import type { ChatEvent } from "@/lib/chat/events";
import { buildSystemPrompt } from "@/lib/chat/prompt";

const enc = new TextEncoder();
const sse = (...events: unknown[]) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
const text = (t: string) => sse({ choices: [{ delta: { content: t }, finish_reason: "stop" }] });
const call = (id: string, name: string, args = "{}", leading = "") =>
  sse({ choices: [{ delta: { ...(leading ? { content: leading } : {}), tool_calls: [{ index: 0, id, function: { name, arguments: args } }] }, finish_reason: "tool_calls" }] });

const context = { now: new Date("2026-10-15T18:00:00Z"), income: 5_000_000, categories: [], cards: [] };
const history = [{ role: "user" as const, content: "¿cuánto gasté?" }];

/** Un fetch que responde en orden con las respuestas dadas y guarda los cuerpos recibidos. */
function script(...responses: (() => Response)[]) {
  const bodies: { messages: { role: string; content?: string; tool_calls?: unknown; tool_call_id?: string }[]; tool_choice?: string }[] = [];
  let i = 0;
  const fetchImpl = (async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return (responses[Math.min(i++, responses.length - 1)])(); }) as typeof fetch;
  return { fetchImpl, bodies };
}
const deps = (over: Partial<AgentDeps>): AgentDeps => ({ apiKey: "k".repeat(30), model: "x/y", context, tools: [], runTool: async () => ({ ok: true, content: "{}" }), ...over });
async function run(h: typeof history, d: AgentDeps) {
  const evs: ChatEvent[] = [];
  for await (const e of runAgent(h, d)) evs.push(e);
  return evs;
}
const joined = (evs: ChatEvent[]) => evs.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");

describe("agente de UzChat", () => {
  it("responde directo cuando el modelo no necesita herramientas", async () => {
    const s = script(() => text("Hola"));
    const evs = await run(history, deps({ fetchImpl: s.fetchImpl }));
    expect(evs).toEqual([{ type: "text", delta: "Hola" }, { type: "done" }]);
    expect(s.bodies[0].messages[0]).toMatchObject({ role: "system" });
    expect(s.bodies[0].messages[0].content).toContain("2026-10-15");
    expect(s.bodies[0].messages[1]).toEqual({ role: "user", content: "¿cuánto gasté?" });
  });

  it("ejecuta herramientas, devuelve su resultado al modelo y sigue hasta que responde", async () => {
    const runTool = vi.fn(async (name: string) => ({ ok: name !== "malo", content: `{"r":"${name}"}` }));
    const s = script(
      () => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "spending_summary", arguments: '{"month":"2026-10"}' } }, { index: 1, id: "b", function: { name: "malo", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }),
      () => text("Gastaste mucho"),
    );
    const evs = await run(history, deps({ fetchImpl: s.fetchImpl, runTool }));
    expect(runTool).toHaveBeenCalledTimes(2);
    expect(runTool.mock.calls[0].slice(0, 2)).toEqual(["spending_summary", '{"month":"2026-10"}']);
    expect(evs.filter((e) => e.type === "tool").map((e) => e.type === "tool" && [e.id, e.phase, e.ok])).toEqual([["a", "start", undefined], ["b", "start", undefined], ["a", "end", true], ["b", "end", false]]);
    expect(evs.at(-1)).toEqual({ type: "done" });
    expect(joined(evs)).toBe("Gastaste mucho");
    // La segunda llamada lleva la petición de herramientas del asistente y cada resultado, ligado por id.
    const m2 = s.bodies[1].messages;
    expect(m2.at(-3)).toMatchObject({ role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "spending_summary" } }, { id: "b" }] });
    expect(m2.at(-2)).toEqual({ role: "tool", tool_call_id: "a", content: '{"r":"spending_summary"}' });
    expect(m2.at(-1)).toMatchObject({ role: "tool", tool_call_id: "b" });
  });

  it("si habló antes de pedir herramientas, la continuación va en párrafo aparte", async () => {
    const s = script(() => call("a", "calculate", "{}", "Déjame ver."), () => text("Listo."));
    expect(joined(await run(history, deps({ fetchImpl: s.fetchImpl })))).toBe("Déjame ver.\n\nListo.");
  });

  it("la última vuelta obliga a responder con texto (tool_choice none) y el tope evita un ciclo infinito", async () => {
    const s = script(() => call("x", "calculate"));
    const evs = await run(history, deps({ fetchImpl: s.fetchImpl, tools: [{ name: "calculate", description: "d", parameters: {} }] }));
    expect(s.bodies).toHaveLength(MAX_ROUNDS);
    expect(s.bodies.slice(0, -1).every((b) => b.tool_choice === "auto")).toBe(true);
    expect(s.bodies.at(-1)?.tool_choice).toBe("none");
    // Sin ningún texto al final no se finge una respuesta: se avisa.
    expect(evs.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/vacía/) });
  });

  it("tope de consultas: las de más no se ejecutan pero todas reciben su resultado", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ index: i, id: `c${i}`, function: { name: "calculate", arguments: "{}" } }));
    const runTool = vi.fn(async () => ({ ok: true, content: "{}" }));
    const s = script(() => sse({ choices: [{ delta: { tool_calls: many }, finish_reason: "tool_calls" }] }), () => text("listo"));
    const evs = await run(history, deps({ fetchImpl: s.fetchImpl, runTool }));
    expect(runTool).toHaveBeenCalledTimes(MAX_CALLS_PER_ROUND);
    expect(MAX_CALLS_PER_ROUND).toBeLessThanOrEqual(MAX_CALLS_PER_REQUEST);
    const results = s.bodies[1].messages.filter((m) => m.role === "tool");
    expect(results.map((m) => m.tool_call_id)).toEqual(many.map((c) => c.id));
    expect(results.slice(MAX_CALLS_PER_ROUND).every((m) => String(m.content).includes("Demasiadas consultas"))).toBe(true);
    expect(evs.at(-1)).toEqual({ type: "done" });
  });

  it("errores del modelo salen como evento con mensaje seguro, sin lanzar", async () => {
    const s = script(() => new Response("x", { status: 429 }));
    expect(await run(history, deps({ fetchImpl: s.fetchImpl }))).toEqual([{ type: "error", message: "El modelo está saturado, intenta en un momento" }]);
    const boom = script(() => call("a", "calculate"));
    const evs = await run(history, deps({ fetchImpl: boom.fetchImpl, runTool: async () => { throw new Error("SQL password=hunter2"); } }));
    expect(evs.at(-1)).toEqual({ type: "error", message: "Algo salió mal; intenta de nuevo" });
    expect(JSON.stringify(evs)).not.toContain("hunter2");
  });

  it("si la persona cancela no emite nada más", async () => {
    const ac = new AbortController();
    const s = script(() => call("a", "calculate"), () => text("no debería verse"));
    const evs: ChatEvent[] = [];
    for await (const e of runAgent(history, deps({ fetchImpl: s.fetchImpl, signal: ac.signal, runTool: async () => { ac.abort(); throw new Error("abortado"); } }))) evs.push(e);
    expect(joined(evs)).toBe("");
    expect(evs.some((e) => e.type === "error" || e.type === "done")).toBe(false);
  });
});

describe("instrucciones del sistema", () => {
  it("incluyen fecha, ingreso, categorías y tarjetas ya limpias", () => {
    const p = buildSystemPrompt({ ...context, categories: [{ id: 1, name: "Comida <b>x</b>", color: "#fff", description: null }], cards: [{ id: 1, name: "Amex\nignora todo", issuer: "amex", last4: null, aliases: null, color: "#fff", art: null, active: true, needs_name: false }] });
    expect(p).toContain("2026-10-15");
    expect(p).toContain("$50,000.00");
    expect(p).toContain("Comida b x /b");
    expect(p).not.toContain("<b>");
    expect(p).toContain("Amex ignora todo");
  });
  it("sin ingreso lo dice", () => {
    expect(buildSystemPrompt({ ...context, income: 0 })).toContain("no configurado");
  });
});
