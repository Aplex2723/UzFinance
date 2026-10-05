import { query, t } from "@/lib/db/pool";
import type { AlertSeverity } from "@/lib/alerts/types";

/**
 * Cola de avisos (`alert_outbox`) del lado del emisor. Todo es atómico por sentencia: dos corridas simultáneas (o dos instancias) no
 * pueden reclamar la misma fila. El reloj es el de la aplicación (`now`), el mismo para reservar y para medir esperas.
 */
export type OutboxChannel = "telegram";

/** Intentos máximos por aviso (el primero cuenta). */
export const MAX_ATTEMPTS = 3;
/** Un aviso `pending` reclamado hace más que esto se da por perdido (el proceso murió a medias) y vuelve a ser reclamable. */
export const CLAIM_LEASE_MINUTES = 5;
/** Espera mínima antes de reintentar un envío fallido, según los intentos ya hechos (creciente). */
export const retryWaitMinutes = (attempts: number): number => (attempts <= 1 ? 5 : 30);
/** Un aviso con más antigüedad que esto ya no sirve: pasa a `skipped`. */
export const MAX_AGE_HOURS = 24;

export type OutboxJob = {
  id: number;
  alertId: number;
  /** Intentos contando el que se está haciendo. */
  attempts: number;
  /** Ids de chat que ya lo recibieron. */
  sentTo: string[];
  severity: AlertSeverity;
  title: string;
  body: string;
};

/** Estado de la cola de un canal en UNA consulta barata (ver `outboxPulse`). */
export type OutboxPulse = {
  /** Filas abiertas (pendientes, o fallidas con intentos). */
  open: number;
  /** Con algo que hacer ahora (enviar, o limpiar una alerta ya leída o un envío colgado), fuera de las horas de silencio. */
  due: number;
  /** Lo mismo pero SOLO lo que sale en horas de silencio (graves y limpieza). */
  dueQuiet: number;
  /** No graves y sin leer que esperan (lo que retienen las horas de silencio). */
  held: number;
};

/**
 * "¿Hay algo vencido o elegible ahora?" en una sola consulta (sustituye a varias: el layout la corre en cada render). `open = 0` →
 * nada que consultar después. Una fila de más de 24 h cuenta como "por limpiar" (`skipExpired` la cierra) pero nunca como enviable.
 * Un aviso reservado hace poco por otra corrida (dentro de la reserva) está abierto pero NO vencido.
 */
export async function outboxPulse(channel: OutboxChannel, now: Date): Promise<OutboxPulse> {
  const lease = `o.claimed_at <= DATEADD(minute, -@lease, @now)`;
  const unseen = `a.dismissed_at IS NULL AND a.read_at IS NULL`;
  const fresh = `o.created_at >= DATEADD(hour, -${MAX_AGE_HOURS}, @now)`;
  const cleanup = `(o.created_at < DATEADD(hour, -${MAX_AGE_HOURS}, @now) OR a.dismissed_at IS NOT NULL OR a.read_at IS NOT NULL OR (o.status='pending' AND o.attempts>=@max AND ${lease}))`;
  const claimable = `(${fresh} AND ${unseen} AND ( (o.status='pending' AND o.attempts<@max AND (o.claimed_at IS NULL OR ${lease}))
            OR (o.status='failed' AND o.attempts<@max AND o.claimed_at <= DATEADD(minute, -(CASE WHEN o.attempts <= 1 THEN ${retryWaitMinutes(1)} ELSE ${retryWaitMinutes(2)} END), @now)) ))`;
  const r = await query<{ open_n: number; due: number | null; due_quiet: number | null; held: number | null }>(
    `SELECT COUNT(*) AS open_n,
            SUM(CASE WHEN ${cleanup} OR ${claimable} THEN 1 ELSE 0 END) AS due,
            SUM(CASE WHEN ${cleanup} OR (${claimable} AND a.severity='high') THEN 1 ELSE 0 END) AS due_quiet,
            SUM(CASE WHEN o.status='pending' AND o.attempts<@max AND a.severity <> 'high' AND ${fresh} AND ${unseen} THEN 1 ELSE 0 END) AS held
     FROM dbo.alert_outbox o JOIN dbo.alerts a ON a.id = o.alert_id
     WHERE o.channel=@ch AND (o.status='pending' OR (o.status='failed' AND o.attempts<@max))`,
    { ch: t.varchar(channel), max: t.int(MAX_ATTEMPTS), lease: t.int(CLAIM_LEASE_MINUTES), now: t.dt(now) },
  );
  const x = r[0];
  return { open: Number(x?.open_n ?? 0), due: Number(x?.due ?? 0), dueQuiet: Number(x?.due_quiet ?? 0), held: Number(x?.held ?? 0) };
}

/** Cierra como `skipped` lo abierto que ya no tiene sentido enviar. Devuelve cuántas filas. */
async function skipOpen(channel: OutboxChannel, reason: string, extraWhere = "", params: Record<string, ReturnType<(typeof t)[keyof typeof t]>> = {}): Promise<number> {
  const r = await query(
    `UPDATE o SET status='skipped', last_error=@why
     OUTPUT INSERTED.id
     FROM dbo.alert_outbox o JOIN dbo.alerts a ON a.id = o.alert_id
     WHERE o.channel=@ch AND (o.status='pending' OR (o.status='failed' AND o.attempts<@max)) ${extraWhere}`,
    { ch: t.varchar(channel), max: t.int(MAX_ATTEMPTS), why: t.str(reason), ...params },
  );
  return r.length;
}

/** Todo lo abierto del canal → `skipped` (canal apagado, sin configurar o sin destinatarios). */
export const skipAllOpen = (channel: OutboxChannel, reason: string) => skipOpen(channel, reason);

/** Avisos de más de `MAX_AGE_HOURS` → `skipped`. */
export const skipExpired = (channel: OutboxChannel, now: Date) =>
  skipOpen(channel, "caducó (más de 24 h)", `AND o.created_at < DATEADD(hour, -${MAX_AGE_HOURS}, @now)`, { now: t.dt(now) });

/** Alertas ya leídas o descartadas en la app → `skipped` (avisar de algo que ya viste no sirve). */
export const skipSeen = (channel: OutboxChannel) => skipOpen(channel, "la alerta ya estaba leída o descartada", "AND (a.dismissed_at IS NOT NULL OR a.read_at IS NOT NULL)");

/** `pending` agotado y sin respuesta (el proceso murió ≥ MAX_ATTEMPTS veces a medias) → `failed`, para que no quede colgado. */
export async function failStuck(channel: OutboxChannel, now: Date): Promise<void> {
  await query(
    `UPDATE dbo.alert_outbox SET status='failed', last_error=@why
     WHERE channel=@ch AND status='pending' AND attempts>=@max AND claimed_at <= DATEADD(minute, -@lease, @now)`,
    { ch: t.varchar(channel), max: t.int(MAX_ATTEMPTS), why: t.str("sin respuesta del envío"), lease: t.int(CLAIM_LEASE_MINUTES), now: t.dt(now) },
  );
}

/**
 * Reclama hasta `limit` avisos listos: `pending` (sin reservar o con la reserva vencida) y `failed` con intentos pendientes cuya espera
 * ya pasó; solo alertas sin leer ni descartar y de menos de 24 h. `onlyHigh` (horas de silencio) deja fuera todo lo que no sea grave.
 * La reserva es un solo UPDATE (suma el intento y marca `claimed_at`): quien no lo gana no recibe la fila.
 */
export async function claimOutbox(channel: OutboxChannel, now: Date, limit: number, onlyHigh: boolean): Promise<OutboxJob[]> {
  const claimed = await query<{ id: number; alert_id: number; attempts: number; sent_to: string | null }>(
    `WITH c AS (
       SELECT TOP (@lim) o.id, o.alert_id, o.attempts, o.sent_to, o.claimed_at
       FROM dbo.alert_outbox o JOIN dbo.alerts a ON a.id = o.alert_id
       WHERE o.channel=@ch AND a.dismissed_at IS NULL AND a.read_at IS NULL
         AND o.created_at >= DATEADD(hour, -${MAX_AGE_HOURS}, @now)
         AND (@high = 0 OR a.severity = 'high')
         AND ( (o.status='pending' AND o.attempts<@max AND (o.claimed_at IS NULL OR o.claimed_at <= DATEADD(minute, -@lease, @now)))
            OR (o.status='failed' AND o.attempts<@max AND o.claimed_at <= DATEADD(minute, -(CASE WHEN o.attempts <= 1 THEN ${retryWaitMinutes(1)} ELSE ${retryWaitMinutes(2)} END), @now)) )
       ORDER BY o.created_at, o.id
     )
     UPDATE c SET claimed_at=@now, attempts=attempts+1
     OUTPUT INSERTED.id, INSERTED.alert_id, INSERTED.attempts, INSERTED.sent_to`,
    { lim: t.int(Math.max(1, Math.floor(limit))), ch: t.varchar(channel), now: t.dt(now), high: t.int(onlyHigh ? 1 : 0), max: t.int(MAX_ATTEMPTS), lease: t.int(CLAIM_LEASE_MINUTES) },
  );
  if (!claimed.length) return [];
  const ids = claimed.map((r) => Number(r.alert_id)).filter((n) => Number.isSafeInteger(n)); // ids de la base, nunca texto del usuario
  const alerts = await query<{ id: number; severity: AlertSeverity; title: string; body: string }>(
    `SELECT id, severity, title, body FROM dbo.alerts WHERE id IN (${ids.join(",")})`,
  );
  const byId = new Map(alerts.map((a) => [Number(a.id), a]));
  const jobs: OutboxJob[] = [];
  for (const r of claimed) {
    const a = byId.get(Number(r.alert_id));
    if (!a) continue;
    jobs.push({ id: Number(r.id), alertId: Number(r.alert_id), attempts: Number(r.attempts), sentTo: r.sent_to ? r.sent_to.split(",").filter(Boolean) : [], severity: a.severity, title: a.title, body: a.body });
  }
  return jobs;
}

/** ¿La alerta se leyó o descartó entre la reserva y el envío? */
export async function isAlertSeen(alertId: number): Promise<boolean> {
  const r = await query("SELECT 1 AS x FROM dbo.alerts WHERE id=@id AND (dismissed_at IS NOT NULL OR read_at IS NOT NULL)", { id: t.big(alertId) });
  return r.length > 0;
}

/**
 * Guarda a quién ya se le entregó el aviso, SIN cerrarlo: se llama después de CADA persona para que un proceso que muera tras enviar a
 * la primera no le repita el aviso en el reintento. Solo toca filas abiertas.
 */
export async function saveSentTo(id: number, sentTo: string[]): Promise<void> {
  await query("UPDATE dbo.alert_outbox SET sent_to=@to WHERE id=@id AND status IN ('pending','failed')", {
    id: t.big(id), to: t.varchar(sentTo.length ? sentTo.join(",").slice(0, 120) : null),
  });
}

/** Deja el resultado del intento. Solo toca filas todavía abiertas (nunca pisa un `sent` ni un `skipped`). */
export async function finishOutbox(id: number, now: Date, r: { status: "sent" | "failed" | "skipped"; error?: string | null; sentTo?: string[] }): Promise<void> {
  await query(
    `UPDATE dbo.alert_outbox SET status=@s, last_error=@e, sent_to=@to, sent_at = CASE WHEN @s='sent' THEN @now ELSE sent_at END
     WHERE id=@id AND status IN ('pending','failed')`,
    { id: t.big(id), s: t.varchar(r.status), e: t.str(r.error ? r.error.slice(0, 300) : null), to: t.varchar(r.sentTo?.length ? r.sentTo.join(",").slice(0, 120) : null), now: t.dt(now) },
  );
}
