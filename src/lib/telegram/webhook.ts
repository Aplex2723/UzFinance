import { after as nextAfter } from "next/server";
import { json } from "@/lib/api";
import { claimMessage, claimMessageState, finishMessage, type ClaimState } from "@/lib/repo/whatsapp";
import { BodyTooLargeError, readLimitedBytes } from "@/lib/security/body";
import { telegramFailures, telegramIdPerUser, telegramPerIp } from "@/lib/security/ingest-limiters";
import type { RateLimiter } from "@/lib/security/ratelimit";
import { limiterIp } from "@/lib/security/trusted-ip";
import { handleInbound } from "@/lib/whatsapp/handler";
import * as R from "@/lib/whatsapp/replies";
import type { HandleDeps, InboundMessage, Sender, WhatsAppIO } from "@/lib/whatsapp/types";
import { createTelegramIO } from "./api";
import { findSender, getTelegramConfig, maskId, telegramConfigIssues, type TelegramConfig } from "./config";
import { extractUpdates, type ChatType, type ParsedItem } from "./payload";
import { SECRET_HEADER, verifySecret } from "./secret";

export const MAX_BODY = 256 * 1024;
/** Tiempo máximo que se retiene la respuesta a Telegram mientras se procesa; si se agota se responde 200 y el trabajo sigue en after(). */
export const PROCESS_BUDGET_MS = 20_000;
export const GENERIC_ERROR = "Ocurrió un error al procesar tu mensaje. Intenta de nuevo en un momento.";
/** Segundos que se pide esperar al proveedor cuando el mensaje está "en vuelo" (reclamado hace poco por otro intento). */
export const INFLIGHT_RETRY_SECONDS = 5;
export const BUSY_ERROR = "No pude registrar tu mensaje por un problema temporal. Reenvíalo en un minuto.";

export type TelegramWebhookDeps = {
  /** Se evalúa en cada petición (nunca se cachea: el secreto no vive en variables de módulo). */
  config: () => TelegramConfig | null;
  io: (cfg: TelegramConfig) => WhatsAppIO;
  handle: (msg: InboundMessage, sender: Sender, io: WhatsAppIO, deps: HandleDeps & { appUrl?: string }) => Promise<void>;
  /** Programa trabajo después de responder (con `after()` de Next en producción). Solo se usa si se agota el presupuesto de tiempo. */
  after: (fn: () => Promise<void>) => void;
  /** Reclamo con detalle (`new`/`stale`/`inflight`/`done`). Solo pruebas; por omisión `claimMessageState`. */
  claimState?: typeof claimMessageState;
  /** Solo pruebas: reclamo booleano (true = procesar, false = duplicado). Si viene `claimState`, este se ignora. */
  claim?: typeof claimMessage;
  finish?: typeof finishMessage;
  /** `perIp` y `failures` solo se consultan con peticiones NO autenticadas; `idPerUser` limita las respuestas a /id. */
  limiters?: { perIp: RateLimiter; failures: RateLimiter; idPerUser?: RateLimiter };
  /** Presupuesto de tiempo para procesar antes de responder (ms). */
  budgetMs?: number;
};

const pending = new Set<Promise<unknown>>();

/** `after()` de Next cuando hay solicitud; fuera de una (pruebas, scripts) como tarea suelta. */
export const defaultAfter = (fn: () => Promise<void>): void => {
  try {
    nextAfter(fn);
  } catch {
    const p = fn();
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
};

let warnedConfig = false;
const tooMany = (retry: number) => json({ error: "Demasiadas solicitudes" }, 429, { "Retry-After": String(retry) });
const shortId = (id: string) => id.slice(-8);
/** A dónde se responde: el chat (en un grupo no es el usuario); sin `replyTo`, el propio remitente. */
const target = (msg: InboundMessage) => msg.replyTo ?? msg.from;

/**
 * En grupos el bot no contesta "no entendí" ni "no tengo nada pendiente": aunque se le haya dirigido el mensaje, en una conversación de
 * varias personas esos avisos son ruido. El handler decide la respuesta, así que se descarta aquí (sin editarlo) por su texto fijo.
 */
export function groupQuietIO(io: WhatsAppIO): WhatsAppIO {
  const mute = new Set([R.clip(R.NOT_UNDERSTOOD), R.clip(R.OUT_OF_CONTEXT)]);
  return {
    sendText: async (to, body) => {
      if (mute.has(body)) return;
      await io.sendText(to, body);
    },
    downloadMedia: (id, max) => io.downloadMedia(id, max),
  };
}

export const idReply = (userId: string, chatId: string, chatType: ChatType) =>
  chatType === "private" ? `Tu ID de Telegram es ${userId}.` : `Tu ID de Telegram es ${userId}.\nEl ID de este chat es ${chatId}.`;

/**
 * Fábrica del webhook de Telegram: solo POST (Telegram no verifica por GET; GET → 405). Sin dependencias globales para poder
 * probarla con fakes.
 *
 * Seguridad y orden de una petición:
 *  1. Sin configuración válida → 503 (falla cerrado) sin detalles.
 *  2. Se compara PRIMERO el encabezado secreto en tiempo constante. Si es válido, la petición se procesa SIEMPRE: ningún límite por
 *     IP se consulta (la IP de Telegram no puede bloquearse con peticiones falsas). Si es inválido o falta: 429 si la IP (la
 *     ÚLTIMA entrada de X-Forwarded-For, la que pone el proxy de Azure) ya está bloqueada o excede el cupo, y si no 401 contando
 *     un fallo (10 en 10 min → bloqueo). El cuerpo NO se lee.
 *  3. Cuerpo con tope (413) → JSON tolerante → (grupos: solo chats de TELEGRAM_ALLOWED_CHATS y solo lo dirigido al bot, ver payload.ts)
 *     → autorización por remitente → claim (idempotencia) → handler.
 *  4. Todo eso ocurre ANTES de responder 200, con un presupuesto de tiempo: si el proceso muere a media ejecución, Telegram no
 *     recibió su 200 y reintenta el update. El claim distingue: nuevo o `received` de más de 2 min → se procesa; `done/failed/ignored`
 *     → duplicado (200); `received` RECIENTE ("en vuelo") → 503 con Retry-After para que Telegram reintente más tarde (si el primer
 *     intento sigue vivo y ya contestó 200, no habrá más reintentos). Si el presupuesto se agota, se responde 200 y el trabajo termina
 *     en `after()` (si el proceso muere después de eso no hay reproceso automático: el usuario reenvía).
 *  5. Tras autenticar SIEMPRE 200 (salvo 413 y el 503 de "en vuelo"), incluso con un payload raro.
 * Nunca se loguean textos, nombres, ids completos, tokens, secretos ni URLs de archivo.
 */
export function createTelegramWebhook(deps: TelegramWebhookDeps) {
  const perIp = deps.limiters?.perIp ?? telegramPerIp;
  const failures = deps.limiters?.failures ?? telegramFailures;
  const idPerUser = deps.limiters?.idPerUser ?? telegramIdPerUser;
  const claimState: typeof claimMessageState =
    deps.claimState ?? (deps.claim ? async (...a) => ((await deps.claim!(...a)) ? "new" : "done") : claimMessageState);
  const finish = deps.finish ?? finishMessage;
  const budgetMs = deps.budgetMs ?? PROCESS_BUDGET_MS;

  function configOrNull(): TelegramConfig | null {
    const cfg = deps.config();
    if (!cfg && !warnedConfig) {
      warnedConfig = true;
      // Solo nombres de variables, nunca valores.
      console.error(`[telegram] sin configuración válida (${telegramConfigIssues().join(", ") || "desconocida"}): el webhook no procesa nada`);
    }
    return cfg;
  }

  async function GET(): Promise<Response> {
    return new Response("Método no permitido", { status: 405, headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }

  /** Devuelve true si algún update estaba "en vuelo" (reclamado hace poco por otro intento): el POST debe responder 503 para que Telegram reintente. */
  async function processItems(cfg: TelegramConfig, items: ParsedItem[]): Promise<boolean> {
    const baseIo = deps.io(cfg);
    const groupIo = groupQuietIO(baseIo);
    let done = 0, failed = 0, ignored = 0, duplicate = 0, ids = 0, inflight = 0;
    // En SERIE: respetan el orden en que el usuario escribió y el OCR no se encima en el plan B1.
    for (const item of items) {
      try {
        if (item.kind === "id") {
          if (!idPerUser.hit(item.userId)) {
            ignored++;
            continue;
          }
          ids++;
          console.log(`[telegram] id solicitado por ${maskId(item.userId)}`);
          await baseIo.sendText(item.chatId, idReply(item.userId, item.chatId, item.chatType));
          continue;
        }
        const msg = item.message;
        const io = item.chatType === "private" ? baseIo : groupIo;
        const sender = findSender(cfg.allowed, msg.from);
        if (!sender) {
          ignored++;
          console.warn(`[telegram] remitente no autorizado ${maskId(msg.from)}: ignorado`);
          continue;
        }
        let state: ClaimState;
        try {
          state = await claimState(msg.id, msg.from, msg.type);
        } catch (e) {
          failed++;
          console.error(`[telegram] no se pudo registrar el mensaje ${shortId(msg.id)}:`, (e as Error)?.message);
          await io.sendText(target(msg), BUSY_ERROR); // sin fila: si el usuario reenvía, se procesa
          continue;
        }
        if (state === "inflight") {
          inflight++;
          continue;
        }
        if (state === "done") {
          duplicate++;
          continue;
        }
        try {
          // `now` = hora REAL de proceso (la del mensaje viaja en msg.timestamp): así la guarda de 48 h del handler sí funciona.
          await deps.handle(msg, sender, io, { now: new Date(), ...(cfg.appUrl ? { appUrl: cfg.appUrl } : {}) });
          done++;
        } catch (e) {
          failed++;
          console.error(`[telegram] error procesando ${shortId(msg.id)}:`, (e as Error)?.message);
          await finish(msg.id, "failed").catch((e2) => console.error("[telegram] no se pudo marcar failed:", (e2 as Error)?.message));
          await io.sendText(target(msg), GENERIC_ERROR);
        }
      } catch (e) {
        failed++;
        console.error("[telegram] fallo inesperado con un update:", (e as Error)?.message);
      }
    }
    console.log(`[telegram] procesados=${done} fallidos=${failed} duplicados=${duplicate} ignorados=${ignored} id=${ids}${inflight ? ` enVuelo=${inflight}` : ""}`);
    return inflight > 0;
  }

  async function POST(req: Request): Promise<Response> {
    const t0 = Date.now();
    const cfg = configOrNull();
    if (!cfg) return json({ error: "Servicio no disponible" }, 503, { "Retry-After": "300" });

    // Autenticación ANTES de cualquier límite por IP (ver el comentario de la fábrica).
    if (!verifySecret(cfg.webhookSecret, req.headers.get(SECRET_HEADER))) {
      const ip = limiterIp(req.headers);
      if (failures.blocked(ip) || !perIp.hit(ip)) return tooMany(failures.retryAfterSeconds(ip));
      failures.hit(ip);
      return json({ error: "No autorizado" }, 401);
    }

    let raw: Buffer;
    try {
      raw = await readLimitedBytes(req, MAX_BODY);
    } catch (e) {
      if (e instanceof BodyTooLargeError) return json({ error: "Cuerpo demasiado grande" }, 413);
      console.error("[telegram] no se pudo leer el cuerpo: ignorado");
      return json({ status: "ok" });
    }

    // Desde aquí el secreto es válido: pase lo que pase se responde 200.
    let items: ParsedItem[] = [];
    try {
      const body: unknown = JSON.parse(raw.toString("utf8"));
      const r = extractUpdates(body, { botUsername: cfg.botUsername, allowedChats: cfg.allowedChats });
      items = r.items;
      const s = r.stats;
      const why = Object.entries(s.reasons).map(([k, n]) => `${k}:${n}`).join(",");
      console.log(`[telegram] post updates=${s.updates} procesables=${items.length} descartados=${s.ignored}${why ? ` (${why})` : ""}${s.truncated ? ` recortados=${s.truncated}` : ""} ms=${Date.now() - t0}`);
    } catch {
      console.error("[telegram] post con cuerpo no interpretable: ignorado");
    }

    if (items.length) {
      const work = (async () => {
        try {
          return await processItems(cfg, items);
        } catch (e) {
          console.error("[telegram] fallo al procesar:", (e as Error)?.message);
          return false;
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        work.then((inflight) => ({ inflight })),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), budgetMs);
        }),
      ]);
      clearTimeout(timer);
      if (finished?.inflight) {
        // Un intento previo reclamó el update hace poco y no lo cerró: si murió, Telegram debe reintentar (y ya será reclamable).
        return json({ error: "Mensaje en proceso, reintenta" }, 503, { "Retry-After": String(INFLIGHT_RETRY_SECONDS) });
      }
      if (!finished) {
        console.warn(`[telegram] presupuesto de ${budgetMs} ms agotado: se responde 200 y el trabajo sigue en segundo plano`);
        try {
          deps.after(async () => void (await work));
        } catch {
          /* fuera de una solicitud: `work` ya está corriendo y nadie lo espera */
        }
      }
    }
    return json({ status: "ok" });
  }

  return { POST, GET };
}

/** Dependencias reales (Bot API, repositorio, `after()` de Next). */
export const telegramWebhook = createTelegramWebhook({
  config: () => getTelegramConfig(),
  io: (c) => createTelegramIO({ botToken: c.botToken }),
  handle: handleInbound,
  after: defaultAfter,
});

/** Para pruebas: espera las tareas sueltas de `defaultAfter`. */
export async function flushTelegramWork(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Para pruebas: vuelve a avisar de configuración inválida. */
export function resetTelegramConfigWarning(): void {
  warnedConfig = false;
}
