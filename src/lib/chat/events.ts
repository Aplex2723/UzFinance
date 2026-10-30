import { z } from "zod";

/**
 * Protocolo entre `POST /api/chat` y el chat del navegador: NDJSON (un evento JSON por línea). Módulo sin dependencias de servidor:
 * lo importan la ruta, el agente y el componente de cliente.
 */
export type ChatEvent =
  /** El agente consulta una herramienta (`start`) o terminó (`end`); `label` ya viene en español para mostrarlo. */
  | { type: "tool"; id: string; label: string; phase: "start" | "end"; ok?: boolean }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };

export const encodeEvent = (e: ChatEvent): string => `${JSON.stringify(e)}\n`;

/** Saca los eventos completos de un búfer de texto; lo que queda (una línea a medias) se devuelve en `rest`. Líneas ilegibles se ignoran. */
export function parseEvents(buffer: string): { events: ChatEvent[]; rest: string } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as ChatEvent;
      if (e && typeof e === "object" && typeof e.type === "string") events.push(e);
    } catch { /* línea corrupta: se salta */ }
  }
  return { events, rest };
}

export const MAX_TURNS = 30;
export const MAX_TURN_CHARS = 4000;
/** Tope de caracteres de TODA la conversación que se reenvía al modelo en cada vuelta (acota el costo de un mensaje). */
export const MAX_TOTAL_CHARS = 40_000;

/** Lo que manda el navegador: solo el texto de la conversación (las llamadas a herramientas no se guardan; el modelo vuelve a consultar). */
export const chatBody = z
  .object({
    messages: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(MAX_TURN_CHARS) }).strict())
      .min(1)
      .max(MAX_TURNS)
      .refine((m) => m[m.length - 1]?.role === "user", "El último mensaje debe ser del usuario")
      .refine((m) => m.reduce((n, t) => n + t.content.length, 0) <= MAX_TOTAL_CHARS, "La conversación es demasiado larga"),
  })
  .strict();

export type ChatTurn = z.infer<typeof chatBody>["messages"][number];
