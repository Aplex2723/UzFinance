import { getAlertConfig } from "@/lib/repo/alerts";
import {
  claimOutbox, failStuck, finishOutbox, isAlertSeen, outboxPulse, saveSentTo, skipAllOpen, skipExpired, skipSeen, type OutboxJob,
} from "@/lib/repo/alert-outbox";
import { getTelegramConfig, maskId, telegramConfigIssues, type TelegramConfig } from "@/lib/telegram/config";
import { createTelegramIO } from "@/lib/telegram/api";
import type { WhatsAppIO } from "@/lib/whatsapp/types";
import { inQuietHours } from "./quiet";
import { chatText } from "./text";

/** Avisos por corrida: un bug o una ráfaga no pueden inundar el chat (el resto sale en la siguiente corrida). */
export const FLUSH_LIMIT = 20;

export type FlushResult = {
  /** Avisos entregados a todas las personas. */
  sent: number;
  /** Avisos con algún envío fallido (se reintentan hasta 3 veces). */
  failed: number;
  /** Avisos descartados sin enviar (canal apagado, caducados, ya leídos). Un Telegram mal configurado NO descarta: deja los avisos pendientes. */
  skipped: number;
  /** Avisos que esperan a que terminen las horas de silencio. */
  held: number;
};

export type FlushOptions = {
  /** Solo pruebas: transporte falso. Por omisión, el cliente real de la Bot API. `sendText` que lanza = envío fallido. */
  io?: WhatsAppIO;
  now?: Date;
  limit?: number;
  /** Solo pruebas: configuración de Telegram. Por omisión la del entorno (`getTelegramConfig`). */
  config?: Pick<TelegramConfig, "allowed" | "botToken" | "appUrl"> | null;
};

const ZERO = (): FlushResult => ({ sent: 0, failed: 0, skipped: 0, held: 0 });

/** Nunca deja pasar un token ni una URL aunque algún error los trajera: el mensaje queda corto y sin datos sensibles. */
export function safeError(s: unknown): string {
  return String(s ?? "error")
    .replace(/\d{6,12}:[A-Za-z0-9_-]{20,}/g, "[token]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

/** Id de chat privado de una persona autorizada: su id numérico de Telegram, sin el prefijo `tg`. */
export const chatIdOf = (waId: string): string => waId.replace(/^tg/, "");

/**
 * El cliente real no lanza ni devuelve nada (sus errores son mensajes fijos en el log): se envuelve `fetch` para saber si el último
 * `sendMessage` salió bien, sin tocar el cliente. El motivo es siempre un texto corto: estado HTTP o "error de red", nunca URL ni cuerpo.
 */
function realIO(botToken: string): { io: WhatsAppIO; arm: () => void; failure: () => string | null } {
  let last: string | null = "sin respuesta de Telegram";
  const tracked: typeof fetch = async (input, init) => {
    try {
      const res = await fetch(input, init);
      last = res.ok ? null : `Telegram respondió ${res.status}${res.status === 400 || res.status === 403 ? " (la persona debe escribirle al bot primero)" : ""}`;
      return res;
    } catch (e) {
      last = (e as Error)?.name === "TimeoutError" ? "tiempo agotado" : "error de red";
      throw e;
    }
  };
  return { io: createTelegramIO({ botToken, fetchImpl: tracked }), arm: () => void (last = "sin respuesta de Telegram"), failure: () => last };
}

async function deliver(job: OutboxJob, cfg: Pick<TelegramConfig, "allowed" | "botToken" | "appUrl">, io: WhatsAppIO | null) {
  const real = io ? null : realIO(cfg.botToken);
  const out = io ?? real!.io;
  const text = chatText(job, cfg.appUrl);
  const delivered = new Set(job.sentTo);
  const errors: string[] = [];
  for (const person of cfg.allowed) {
    const chat = chatIdOf(person.waId);
    if (delivered.has(chat)) continue; // un reintento no repite el aviso a quien ya lo recibió
    real?.arm();
    try {
      await out.sendText(chat, text);
      const why = real?.failure() ?? null;
      if (why) errors.push(`${maskId(person.waId)}: ${why}`);
      else {
        delivered.add(chat);
        // Se persiste de inmediato: si el proceso muere antes de la siguiente persona, el reintento no repite el aviso a esta.
        await saveSentTo(job.id, [...delivered]).catch((e) => console.error(`[alerts] telegram: no se pudo guardar sent_to del aviso ${job.id}: ${safeError((e as Error)?.message)}`));
      }
    } catch (e) {
      errors.push(`${maskId(person.waId)}: ${safeError((e as Error)?.message)}`);
    }
  }
  const sentTo = [...delivered];
  if (!errors.length) return { status: "sent" as const, sentTo, error: null };
  console.error(`[alerts] telegram: aviso ${job.id} no se entregó a ${errors.length} persona(s) (intento ${job.attempts})`);
  return { status: "failed" as const, sentTo, error: safeError(errors.join("; ")) };
}

let warnedUnusable = false;

/**
 * Manda a Telegram los avisos de `alert_outbox` (canal `telegram`) a CADA persona autorizada (`TELEGRAM_ALLOWED`), en su chat privado, en
 * texto plano. NUNCA lanza y es best effort: un fallo de red no rompe ni retrasa nada (se reintenta: hasta 3 intentos con espera de 5 y
 * 30 min). Idempotente y seguro con corridas simultáneas: cada fila se reserva con un UPDATE atómico y un reintento solo escribe a quien
 * aún no lo recibió (`sent_to` se guarda después de CADA persona). No envía alertas leídas/descartadas ni de más de 24 h.
 *
 * Costo: la ruta caliente (el layout la corre en cada render) hace UNA consulta (`outboxPulse`) y termina si no hay filas abiertas o nada
 * vencido; en horas de silencio con avisos retenidos son dos (pulso + configuración de alertas).
 *
 * Qué pasa con lo pendiente:
 *  - canal APAGADO en la configuración de alertas → `skipped` (decisión del usuario);
 *  - Telegram mal configurado o sin destinatarios → se queda `pending` (un error de configuración, p. ej. un `TELEGRAM_ALLOWED` mal escrito,
 *    no debe borrar avisos): sale solo cuando se corrige y caduca a las 24 h;
 *  - horas de silencio → solo salen las graves; el resto queda `pending` y sale en la primera corrida después. No hay temporizador: esa
 *    corrida ocurre cuando alguien abre la app o llega una ingesta.
 */
export async function flushTelegramOutbox(opts: FlushOptions = {}): Promise<FlushResult> {
  const res = ZERO();
  try {
    const now = opts.now ?? new Date();
    const pulse = await outboxPulse("telegram", now);
    if (!pulse.open || !pulse.due) return res;
    const acfg = await getAlertConfig();
    if (!acfg.telegram.enabled) {
      res.skipped += await skipAllOpen("telegram", "avisos por Telegram apagados");
      return res;
    }
    const tg = opts.config === undefined ? getTelegramConfig() : opts.config;
    if (!tg || !tg.allowed.length) {
      if (!warnedUnusable) {
        warnedUnusable = true;
        // Solo nombres de variables, nunca valores.
        console.error(`[alerts] telegram: ${tg ? "sin destinatarios autorizados" : `configuración inválida (${telegramConfigIssues().join(", ") || "desconocida"})`}: los avisos quedan pendientes`);
      }
      res.skipped += await skipExpired("telegram", now); // lo caducado sí se cierra: ya no se enviaría de todos modos
      return res;
    }
    const quiet = inQuietHours(now, acfg.quietHours);
    if (quiet) {
      res.held = pulse.held;
      if (!pulse.dueQuiet) return res; // solo hay avisos retenidos: nada más que consultar
    }
    await failStuck("telegram", now);
    res.skipped += await skipExpired("telegram", now);
    res.skipped += await skipSeen("telegram");
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? FLUSH_LIMIT) || FLUSH_LIMIT, 1), 100);
    const jobs = await claimOutbox("telegram", now, limit, quiet);
    for (const job of jobs) {
      try {
        if (await isAlertSeen(job.alertId)) {
          await finishOutbox(job.id, now, { status: "skipped", error: "la alerta ya estaba leída o descartada", sentTo: job.sentTo });
          res.skipped++;
          continue;
        }
        const r = await deliver(job, tg, opts.io ?? null);
        await finishOutbox(job.id, now, r);
        if (r.status === "sent") res.sent++;
        else res.failed++;
      } catch (e) {
        console.error(`[alerts] telegram: aviso ${job.id} falló: ${safeError((e as Error)?.message)}`);
        res.failed++;
      }
    }
    return res;
  } catch (e) {
    console.error(`[alerts] flushTelegramOutbox: ${safeError((e as Error)?.message)}`);
    return res;
  }
}

/** Para pruebas: vuelve a avisar de configuración inválida. */
export function resetTelegramSenderWarning(): void {
  warnedUnusable = false;
}
