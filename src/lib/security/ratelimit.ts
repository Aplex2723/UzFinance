/**
 * Rate limiter de ventana fija en memoria. Suficiente para una sola
 * instancia (F1/B1 no escalan horizontalmente); documentado en el README.
 */
type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Cuenta un intento. Devuelve true si aún está dentro del límite. */
  hit(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    b.count += 1;
    return b.count <= this.limit;
  }

  /** ¿Ya agotó su cupo? (sin contar un intento nuevo) */
  blocked(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    return !!b && b.resetAt > now && b.count >= this.limit;
  }

  retryAfterSeconds(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    return b ? Math.max(1, Math.ceil((b.resetAt - now) / 1000)) : 1;
  }

  reset() {
    this.buckets.clear();
  }

  private sweep(now: number) {
    if (this.buckets.size < 5000) return;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Tope duro contra agotamiento de memoria.
    if (this.buckets.size >= 10000) this.buckets.clear();
  }
}

export function clientIp(headers: Headers): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = xff || headers.get("x-client-ip") || "unknown";
  // App Service añade ":puerto" a IPv4.
  return raw.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1").slice(0, 64);
}
