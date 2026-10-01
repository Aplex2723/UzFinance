import { createHash, timingSafeEqual } from "node:crypto";

function digest(s: string) {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Comparación en tiempo constante (se comparan digests de igual longitud). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{16,512})$/.exec(header);
  return m ? m[1] : null;
}

/** Acepta el token vigente y, durante una rotación, el anterior. */
export function verifyIngestToken(header: string | null, current: string, previous?: string): boolean {
  const supplied = extractBearer(header);
  if (!supplied) return false;
  // Se evalúan ambos siempre para no filtrar cuál coincidió por tiempo.
  const okCurrent = safeEqual(supplied, current);
  const okPrevious = previous ? safeEqual(supplied, previous) : false;
  return okCurrent || okPrevious;
}
