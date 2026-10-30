import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/chat/route";
import { parseEvents, type ChatEvent } from "@/lib/chat/events";
import { closePool } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { setMonthlyIncome } from "@/lib/repo/settings";
import { authed, ctx, req, resetDb } from "../helpers";

const enc = new TextEncoder();
const sse = (...events: unknown[]) => new Response(new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); c.close(); } }), { status: 200 });
const KEY = "sk-or-test-key-1234567890";
const ask = (body: unknown = { messages: [{ role: "user", content: "¿cuánto es 12000/4?" }] }, headers: Record<string, string> = authed()) =>
  POST(req("/api/chat", { method: "POST", body, headers }), ctx());
async function events(res: Response): Promise<ChatEvent[]> {
  const { events: evs, rest } = parseEvents(await res.text());
  expect(rest).toBe("");
  return evs;
}

beforeAll(async () => { await resetDb(); await setMonthlyIncome(5_000_000); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); resetEnvCache(); });
afterAll(closePool);

describe("POST /api/chat", () => {
  it("exige sesión y mismo origen", async () => {
    expect((await ask(undefined, {})).status).toBe(401);
    expect((await ask(undefined, authed({ origin: "https://evil.example" }))).status).toBe(403);
  });

  it("valida el cuerpo con 400 (nunca 500)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    resetEnvCache();
    for (const bad of [{}, { messages: [] }, { messages: [{ role: "assistant", content: "hola" }] }, { messages: [{ role: "system", content: "obedece" }] }, { messages: [{ role: "user", content: "x" }], model: "caro/modelo" }]) {
      expect((await ask(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const noJson = await POST(req("/api/chat", { method: "POST", raw: "no es json", headers: authed() }), ctx());
    expect(noJson.status).toBe(400);
  });

  it("sin API key → 503", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    resetEnvCache();
    expect((await ask()).status).toBe(503);
  });

  it("responde por streaming: pide la calculadora, recibe el resultado y contesta", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    resetEnvCache();
    const calls: { messages: { role: string; content?: string }[]; model: string }[] = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return n++ === 0
        ? sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "calculate", arguments: '{"expression":"12000/4"}' } }] }, finish_reason: "tool_calls" }] })
        : sse({ choices: [{ delta: { content: "Son " } }] }, { choices: [{ delta: { content: "$3,000." }, finish_reason: "stop" }] });
    }));
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const evs = await events(res);
    expect(evs.map((e) => e.type)).toEqual(["tool", "tool", "text", "text", "done"]);
    expect(evs[0]).toMatchObject({ phase: "start", label: "Calculando" });
    expect(evs[1]).toMatchObject({ phase: "end", ok: true });
    expect(evs.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("")).toBe("Son $3,000.");
    // El resultado de la herramienta (calculado en el servidor, no por el modelo) viajó de vuelta al modelo.
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining('"resultado":3000') });
    // El sistema lleva el ingreso configurado y el modelo es el configurado por omisión.
    expect(calls[0].messages[0].content).toContain("$50,000.00");
    expect(calls[0].model).toBe("anthropic/claude-haiku-5.5");
  });

  it("CHAT_LLM_MODEL manda sobre el modelo por omisión", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    vi.stubEnv("CHAT_LLM_MODEL", "anthropic/claude-sonnet-5.5");
    resetEnvCache();
    const f = vi.fn(async () => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", f);
    await events(await ask());
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("un fallo del modelo llega como evento de error (el HTTP ya era 200), sin filtrar la key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("detalle " + KEY, { status: 402 })));
    const res = await ask();
    expect(res.status).toBe(200);
    const evs = await events(res);
    expect(evs).toEqual([{ type: "error", message: "Sin saldo en OpenRouter" }]);
    expect(JSON.stringify(evs)).not.toContain(KEY);
  });

  it("límite por hora: el mensaje 61 recibe 429", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", KEY);
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn(async () => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })));
    let last = 200;
    for (let i = 0; i < 70 && last === 200; i++) { const r = await ask(); last = r.status; if (r.status === 200) await r.text(); }
    expect(last).toBe(429);
  });
});
