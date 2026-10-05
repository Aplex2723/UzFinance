import { RateLimiter } from "./ratelimit";

/** Por IP, en memoria de proceso (una sola instancia). */
export const ingestPerIp = new RateLimiter(60, 60_000); // 60 req/min
export const ingestFailures = new RateLimiter(10, 10 * 60_000); // 10 tokens inválidos / 10 min

/** Puente Gmail: el backfill envía lotes, por eso el cupo por IP es mayor. */
export const emailPerIp = new RateLimiter(120, 60_000);
export const emailFailures = new RateLimiter(10, 10 * 60_000);

/** Webhook de WhatsApp: Meta llama desde muchas IPs, por eso el cupo por IP es generoso; las firmas inválidas sí se castigan. */
export const whatsappPerIp = new RateLimiter(600, 60_000);
export const whatsappFailures = new RateLimiter(10, 10 * 60_000);

/** Webhook de Telegram: llama desde pocas IPs de Telegram, cupo generoso; un secreto inválido sí se castiga. */
export const telegramPerIp = new RateLimiter(600, 60_000);
export const telegramFailures = new RateLimiter(10, 10 * 60_000);
/** Respuestas a /id (el único comando que contesta a quien no está autorizado): por usuario, para no usar al bot como amplificador. */
export const telegramIdPerUser = new RateLimiter(5, 60_000);
