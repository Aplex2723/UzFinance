import { RateLimiter } from "./ratelimit";

/** Por IP, en memoria de proceso (una sola instancia). */
export const ingestPerIp = new RateLimiter(60, 60_000); // 60 req/min
export const ingestFailures = new RateLimiter(10, 10 * 60_000); // 10 tokens inválidos / 10 min
