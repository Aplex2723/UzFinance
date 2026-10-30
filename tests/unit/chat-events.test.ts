import { describe, expect, it } from "vitest";
import { chatBody, encodeEvent, MAX_TOTAL_CHARS, MAX_TURN_CHARS, MAX_TURNS, parseEvents, type ChatEvent } from "@/lib/chat/events";

describe("protocolo NDJSON de UzChat", () => {
  it("codifica y vuelve a leer una secuencia de eventos", () => {
    const evs: ChatEvent[] = [{ type: "tool", id: "a", label: "Calculando", phase: "start" }, { type: "text", delta: "Hola\nmundo" }, { type: "done" }];
    const { events, rest } = parseEvents(evs.map(encodeEvent).join(""));
    expect(events).toEqual(evs);
    expect(rest).toBe("");
  });
  it("una línea a medias se queda en `rest` hasta que llega el resto", () => {
    const line = encodeEvent({ type: "text", delta: "abc" });
    const a = parseEvents(line.slice(0, 10));
    expect(a.events).toEqual([]);
    const b = parseEvents(a.rest + line.slice(10));
    expect(b.events).toEqual([{ type: "text", delta: "abc" }]);
  });
  it("ignora líneas vacías, corruptas o sin tipo", () => {
    const { events } = parseEvents(`\nno es json\n{"x":1}\n${encodeEvent({ type: "done" })}`);
    expect(events).toEqual([{ type: "done" }]);
  });
});

describe("cuerpo de /api/chat", () => {
  const ok = { messages: [{ role: "user", content: "hola" }] };
  it("acepta una conversación que termina en el usuario", () => {
    expect(chatBody.safeParse(ok).success).toBe(true);
    expect(chatBody.safeParse({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }).success).toBe(true);
  });
  it("rechaza vacío, rol ajeno (system/tool), último del asistente, mensajes enormes o de más y campos extra", () => {
    expect(chatBody.safeParse({ messages: [] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "system", content: "x" }] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "tool", content: "x" }] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "user", content: "   " }] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "user", content: "x".repeat(MAX_TURN_CHARS + 1) }] }).success).toBe(false);
    expect(chatBody.safeParse({ messages: Array.from({ length: MAX_TURNS + 1 }, () => ({ role: "user", content: "x" })) }).success).toBe(false);
    const turns = Math.ceil(MAX_TOTAL_CHARS / MAX_TURN_CHARS) + 1;
    expect(chatBody.safeParse({ messages: Array.from({ length: turns }, () => ({ role: "user", content: "x".repeat(MAX_TURN_CHARS) })) }).success).toBe(false);
    expect(chatBody.safeParse({ ...ok, model: "otro/modelo" }).success).toBe(false);
    expect(chatBody.safeParse({ messages: [{ role: "user", content: "a", extra: 1 }] }).success).toBe(false);
  });
});
