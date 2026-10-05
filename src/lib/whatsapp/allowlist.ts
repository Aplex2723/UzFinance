import type { Sender } from "./types";

const NAME_RE = /^[\p{L} .'-]{1,30}$/u;
export const MAX_ALLOWED = 5;

/**
 * Número en su forma canónica para comparar: solo dígitos y, ÚNICAMENTE para México, `521` + 10 dígitos → `52` + 10 dígitos (Meta manda
 * los móviles de México con el 1 histórico y la lista puede traerlos con o sin él). El resto de países se compara tal cual. Se compara el
 * número COMPLETO: recortar a 10 dígitos haría coincidir `+52 55 1234 5678` con `+1 551 234 5678`.
 */
export function normalizeNumber(n: string): string {
  const digits = n.replace(/\D/g, "");
  return /^521\d{10}$/.test(digits) ? `52${digits.slice(3)}` : digits;
}

/**
 * "5215512345678=Uziel,5215587654321=Ana" → [{waId, name}]. `null` si algo es inválido (falla cerrado: una lista a medias
 * podría autorizar de más o de menos). Acepta espacios y un "+" inicial; número CON lada de país (11 a 15 dígitos, sin 0 inicial: un
 * número de 10 dígitos sin lada es ambiguo y se rechaza); 1 a 5 personas sin repetir número (ni con y sin el "1" de México).
 */
export function parseAllowed(raw: string): Sender[] | null {
  const out: Sender[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i < 1) return null;
    const num = part.slice(0, i).trim().replace(/^\+/, "");
    const name = part.slice(i + 1).trim();
    if (!/^[1-9]\d{10,14}$/.test(num) || !NAME_RE.test(name) || name.replace(/[ .'-]/g, "") === "") return null;
    if (out.some((s) => normalizeNumber(s.waId) === normalizeNumber(num))) return null;
    out.push({ waId: num, name });
  }
  return out.length >= 1 && out.length <= MAX_ALLOWED ? out : null;
}

/**
 * Busca al remitente por el NÚMERO COMPLETO normalizado (ver `normalizeNumber`). El `waId` devuelto es el que mandó Meta (`from`), para
 * responder al mismo número y mantener estable la llave de la conversación.
 */
export function findSender(allowed: readonly Sender[], from: string): Sender | null {
  const digits = from.replace(/\D/g, "");
  if (digits.length < 10) return null;
  const key = normalizeNumber(digits);
  let found: Sender | null = null;
  // Sin cortocircuito: tiempo independiente de cuál coincide.
  for (const s of allowed) if (normalizeNumber(s.waId) === key && !found) found = { waId: digits, name: s.name };
  return found;
}

/** "5215512345678" → "***5678": lo único del número que se escribe en logs. */
export const maskNumber = (n: string) => `***${n.replace(/\D/g, "").slice(-4)}`;
