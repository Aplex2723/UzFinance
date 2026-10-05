import { safeEqual } from "@/lib/security/token";

/** Encabezado en el que Telegram devuelve el `secret_token` configurado en setWebhook. */
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * ¿El encabezado trae el secreto configurado? Comparación en tiempo constante entre digests (la longitud tampoco se filtra);
 * ausente, vacío o distinto fallan igual y sin atajos que revelen por qué.
 */
export function verifySecret(expected: string, header: string | null | undefined): boolean {
  const supplied = header ?? "";
  const equal = safeEqual(supplied, expected);
  return equal && supplied.length > 0 && expected.length > 0;
}
