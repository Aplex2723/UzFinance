import { MAX_TOTAL_CHARS, MAX_TURN_CHARS, MAX_TURNS, type ChatTurn } from "./events";

type Say = { role: "user" | "assistant"; content: string };

/**
 * Conversación del navegador → lo que se manda al servidor: sin mensajes vacíos (una respuesta que falló), con los mensajes seguidos del
 * mismo rol unidos (algunos modelos exigen que alternen), empezando y terminando con el usuario, y recortada a lo que el servidor acepta.
 */
export function toHistory(messages: readonly Say[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const m of messages) {
    const content = m.content.trim();
    if (!content) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[out.length - 1].role !== "user") out.pop();
  const tail = out.slice(-MAX_TURNS);
  while (tail.length && tail[0].role !== "user") tail.shift();
  // Un mensaje enorme conserva su final (lo más reciente).
  const clipped = tail.map((t) => (t.content.length > MAX_TURN_CHARS ? { ...t, content: t.content.slice(-MAX_TURN_CHARS) } : t));
  // Presupuesto total: se sueltan los turnos más viejos (siempre queda al menos el último mensaje del usuario).
  let total = clipped.reduce((n, t) => n + t.content.length, 0);
  while (clipped.length > 1 && total > MAX_TOTAL_CHARS) total -= clipped.shift()!.content.length;
  while (clipped.length > 1 && clipped[0].role !== "user") clipped.shift();
  return clipped;
}
