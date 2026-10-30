import { describe, expect, it } from "vitest";
import { MAX_TOTAL_CHARS, MAX_TURN_CHARS, MAX_TURNS, chatBody } from "@/lib/chat/events";
import { toHistory } from "@/lib/chat/history";

const u = (content: string) => ({ role: "user" as const, content });
const a = (content: string) => ({ role: "assistant" as const, content });

describe("historial que viaja al servidor", () => {
  it("conserva una conversación normal", () => {
    expect(toHistory([u("hola"), a("¿qué tal?"), u("gasto")])).toEqual([u("hola"), a("¿qué tal?"), u("gasto")]);
  });
  it("descarta respuestas vacías (fallidas) y une los mensajes seguidos del mismo rol", () => {
    expect(toHistory([u("uno"), a(""), u("dos")])).toEqual([u("uno\n\ndos")]);
    expect(toHistory([u("uno"), a("   "), u("dos"), a("ok"), u("tres")])).toEqual([u("uno\n\ndos"), a("ok"), u("tres")]);
  });
  it("termina en el usuario y empieza en el usuario", () => {
    expect(toHistory([a("hola"), u("x"), a("y")])).toEqual([u("x")]);
    expect(toHistory([a("solo yo")])).toEqual([]);
  });
  it("respeta el presupuesto total de caracteres soltando lo más viejo", () => {
    const big = "y".repeat(MAX_TURN_CHARS);
    const long = Array.from({ length: 28 }, (_, i) => (i % 2 ? a(big) : u(big)));
    const h = toHistory([...long, u("final")]);
    expect(h.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(h[0].role).toBe("user");
    expect(h.at(-1)).toEqual(u("final"));
    expect(chatBody.safeParse({ messages: h }).success).toBe(true);
  });
  it("recorta a lo que acepta el servidor: siempre pasa chatBody", () => {
    const long = Array.from({ length: 80 }, (_, i) => (i % 2 ? a(`r${i}`) : u(`p${i}`)));
    const h = toHistory([...long, u("final")]);
    expect(h.length).toBeLessThanOrEqual(MAX_TURNS);
    expect(h[0].role).toBe("user");
    expect(h.at(-1)).toEqual(u("final"));
    expect(chatBody.safeParse({ messages: h }).success).toBe(true);
    const huge = toHistory([u("x".repeat(MAX_TURN_CHARS * 2) + "FIN")]);
    expect(huge[0].content).toHaveLength(MAX_TURN_CHARS);
    expect(huge[0].content.endsWith("FIN")).toBe(true);
  });
});
