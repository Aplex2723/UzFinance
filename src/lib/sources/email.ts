import type { TransactionSource } from "./types";

/**
 * STUB documentado: parser de correos de notificación de Banamex / American Express.
 *
 * Diseño previsto (no implementado):
 *  1. Un buzón dedicado (reenvío automático de las alertas) → webhook o Graph API.
 *  2. Un parser por emisor que extraiga comercio, monto, últimos 4 y fecha del HTML.
 *  3. Devolver RawTransaction[] y reutilizar `ingestTransactions(rows, "email")`:
 *     la deduplicación por hash evita duplicar lo que ya llegó por el Atajo.
 *
 * Los formatos de correo cambian sin aviso: cada parser debe llevar pruebas
 * con muestras anonimizadas y fallar de forma ruidosa (errors[]), no en silencio.
 */
export const emailSource: TransactionSource<string> = {
  kind: "email",
  parse() {
    throw new Error("emailSource no está implementado todavía (ver comentario del módulo).");
  },
};
