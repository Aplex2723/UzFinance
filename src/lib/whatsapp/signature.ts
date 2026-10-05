import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER_RE = /^sha256=([0-9a-fA-F]{64})$/;

/** `sha256=` + HMAC-SHA256(appSecret, cuerpo crudo), como lo firma Meta en `X-Hub-Signature-256`. */
export function signBody(appSecret: string, rawBody: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

/**
 * Verifica la firma de Meta sobre el cuerpo CRUDO (antes de parsear nada). Comparación en tiempo constante entre digests de
 * igual longitud; una cabecera ausente o mal formada falla igual, sin atajos que revelen por qué.
 */
export function verifySignature(appSecret: string, rawBody: Uint8Array, header: string | null): boolean {
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const m = header ? HEADER_RE.exec(header.trim()) : null;
  const supplied = m ? Buffer.from(m[1], "hex") : Buffer.alloc(expected.length);
  const equal = timingSafeEqual(expected, supplied);
  return equal && m !== null;
}
