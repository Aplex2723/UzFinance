import { after as nextAfter } from "next/server";
import { json } from "@/lib/api";
import { claimMessage, claimMessageState, finishMessage, type ClaimState } from "@/lib/repo/whatsapp";
import { BodyTooLargeError, readLimitedBytes } from "@/lib/security/body";
import { whatsappFailures, whatsappPerIp } from "@/lib/security/ingest-limiters";
import type { RateLimiter } from "@/lib/security/ratelimit";
import { safeEqual } from "@/lib/security/token";
import { limiterIp } from "@/lib/security/trusted-ip";
import { findSender, maskNumber } from "./allowlist";
import { getWhatsAppConfig, whatsAppConfigIssues, type WhatsAppConfig } from "./config";
import { createGraphIO } from "./graph";
import { handleInbound } from "./handler";
import { extractMessages } from "./payload";
import { verifySignature } from "./signature";
import type { HandleDeps, InboundMessage, Sender, WhatsAppIO } from "./types";

export const MAX_BODY = 256 * 1024;
/** Tiempo máximo que se retiene la respuesta a Meta mientras se procesa; si se agota se responde 200 y el trabajo sigue en after(). */
export const PROCESS_BUDGET_MS = 20_000;
export const GENERIC_ERROR = "Ocurrió un error al procesar tu mensaje. Intenta de nuevo en un momento.";
/** Segundos que se pide esperar al proveedor cuando el mensaje está "en vuelo" (reclamado hace poco por otro intento). */
export const INFLIGHT_RETRY_SECONDS = 5;
export const BUSY_ERROR = "No pude registrar tu mensaje por un problema temporal. Reenvíalo en un minuto.";

export type WebhookDeps = {
  /** Se evalúa en cada petición (nunca se cachea: el secreto no vive en variables de módulo). */
  config: () => WhatsAppConfig | null;
  io: (cfg: WhatsAppConfig) => WhatsAppIO;
  handle: (msg: InboundMessage, sender: Sender, io: WhatsAppIO, deps: HandleDeps & { appUrl?: string }) => Promise<void>;
  /** Programa trabajo después de responder (con `after()` de Next en producción). Solo se usa si se agota el presupuesto de tiempo. */
  after: (fn: () => Promise<void>) => void;
  /** Reclamo con detalle (`new`/`stale`/`inflight`/`done`). Solo pruebas; por omisión `claimMessageState`. */
  claimState?: typeof claimMessageState;
  /** Solo pruebas: reclamo booleano (true = procesar, false = duplicado). Si viene `claimState`, este se ignora. */
  claim?: typeof claimMessage;
  finish?: typeof finishMessage;
  /** Ambos se consultan SOLO con peticiones NO autenticadas (firma o verify token inválidos/ausentes). */
  limiters?: { perIp: RateLimiter; failures: RateLimiter };
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

/**
 * Fábrica del webhook de Meta: GET (verificación del suscriptor) y POST (mensajes). Sin dependencias globales para poder probarla
 * con fakes.
 *
 * Seguridad y orden de un POST:
 *  1. Sin configuración válida → 503 (falla cerrado) sin detalles.
 *  2. Sin cabecera de firma: no se lee ni el cuerpo. Con ella se lee el cuerpo CRUDO con tope (413) y se verifica la firma HMAC
 *     PRIMERO. Firma VÁLIDA → se procesa SIEMPRE: ningún límite por IP se consulta (la IP de Meta no puede bloquearse con peticiones
 *     falsas). Firma inválida/ausente → 429 si la IP (la ÚLTIMA entrada de X-Forwarded-For, la que pone el proxy de Azure; la primera
 *     la controla el cliente) ya está bloqueada o excede el cupo, y si no 401 contando un fallo (10 en 10 min → bloqueo).
 *  3. JSON tolerante → remitente autorizado → claim (idempotencia) → handler, en SERIE, ANTES de responder 200 y dentro de un
 *     presupuesto de tiempo: si el proceso muere a media ejecución Meta no recibió su 200 y reintenta. El claim distingue: fila
 *     nueva o `received` de más de 2 min → se procesa; `done/failed/ignored` → duplicado (200); `received` RECIENTE ("en vuelo") →
 *     503 con Retry-After para que Meta reintente más tarde (si el primer intento sigue vivo y ya contestó 200, no habrá más
 *     reintentos). Si el presupuesto se agota, se responde 200 y el trabajo termina en `after()`.
 *  4. Tras una firma válida SIEMPRE 200 (salvo 413 y el 503 de "en vuelo"), incluso con un payload raro (Meta desactiva el webhook ante errores repetidos).
 * GET: un verify token correcto nunca se bloquea por IP; uno incorrecto cuenta como fallo y sí está sujeto a los límites.
 * Nunca se loguean cuerpos, textos, nombres, números completos, tokens ni cabeceras.
 */
export function createWebhookHandlers(deps: WebhookDeps) {
  const perIp = deps.limiters?.perIp ?? whatsappPerIp;
  const failures = deps.limiters?.failures ?? whatsappFailures;
  const claimState: typeof claimMessageState =
    deps.claimState ?? (deps.claim ? async (...a) => ((await deps.claim!(...a)) ? "new" : "done") : claimMessageState);
  const finish = deps.finish ?? finishMessage;
  const budgetMs = deps.budgetMs ?? PROCESS_BUDGET_MS;

  function configOrNull(): WhatsAppConfig | null {
    const cfg = deps.config();
    if (!cfg && !warnedConfig) {
      warnedConfig = true;
      // Solo nombres de variables, nunca valores.
      console.error(`[whatsapp] sin configuración válida (${whatsAppConfigIssues().join(", ") || "desconocida"}): el webhook no procesa nada`);
    }
    return cfg;
  }

  async function GET(req: Request): Promise<Response> {
    const cfg = configOrNull();
    if (!cfg) return new Response("Servicio no disponible", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

    const q = new URL(req.url).searchParams;
    const mode = q.get("hub.mode");
    const token = q.get("hub.verify_token") ?? "";
    const challenge = q.get("hub.challenge") ?? "";
    // Se evalúa todo sin cortocircuito para no filtrar por tiempo qué falló.
    const tokenOk = safeEqual(token, cfg.verifyToken);
    const challengeOk = /^[A-Za-z0-9_.-]{1,200}$/.test(challenge);
    const forbidden = () => new Response("Prohibido", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    if (tokenOk) {
      // Token correcto: jamás se consulta un límite por IP (la IP de Meta no puede bloquearse con peticiones falsas).
      if (mode !== "subscribe" || !challengeOk) return forbidden();
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const ip = limiterIp(req.headers);
    if (failures.blocked(ip) || !perIp.hit(ip)) return tooMany(failures.retryAfterSeconds(ip));
    failures.hit(ip);
    return forbidden();
  }

  /** Devuelve true si algún mensaje estaba "en vuelo" (reclamado hace poco por otro intento): el POST debe responder 503 para que Meta reintente. */
  async function processMessages(cfg: WhatsAppConfig, messages: InboundMessage[]): Promise<boolean> {
    const io = deps.io(cfg);
    let done = 0, failed = 0, ignored = 0, duplicate = 0, inflight = 0;
    // En SERIE: respetan el orden en que el usuario escribió y el OCR no se encima en el plan B1.
    for (const msg of messages) {
      try {
        const sender = findSender(cfg.allowed, msg.from);
        if (!sender) {
          ignored++;
          console.warn(`[whatsapp] remitente no autorizado ${maskNumber(msg.from)}: ignorado`);
          continue;
        }
        let state: ClaimState;
        try {
          state = await claimState(msg.id, msg.from, msg.type);
        } catch (e) {
          failed++;
          console.error(`[whatsapp] no se pudo registrar el mensaje ${shortId(msg.id)}:`, (e as Error)?.message);
          await io.sendText(msg.from, BUSY_ERROR); // sin fila: si el usuario reenvía, se procesa
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
          console.error(`[whatsapp] error procesando ${shortId(msg.id)}:`, (e as Error)?.message);
          await finish(msg.id, "failed").catch((e2) => console.error("[whatsapp] no se pudo marcar failed:", (e2 as Error)?.message));
          await io.sendText(msg.from, GENERIC_ERROR);
        }
      } catch (e) {
        failed++;
        console.error(`[whatsapp] fallo inesperado con ${shortId(msg.id)}:`, (e as Error)?.message);
      }
    }
    console.log(`[whatsapp] procesados=${done} fallidos=${failed} duplicados=${duplicate} ignorados=${ignored}${inflight ? ` enVuelo=${inflight}` : ""}`);
    return inflight > 0;
  }

  async function POST(req: Request): Promise<Response> {
    const t0 = Date.now();
    const cfg = configOrNull();
    if (!cfg) return json({ error: "Servicio no disponible" }, 503, { "Retry-After": "300" });

    // Petición NO autenticada (firma ausente o inválida, o cuerpo ilegible/enorme): AQUÍ y solo aquí se aplican los límites por IP.
    const reject = (status: number, error: string) => {
      const ip = limiterIp(req.headers);
      if (failures.blocked(ip) || !perIp.hit(ip)) return tooMany(failures.retryAfterSeconds(ip));
      failures.hit(ip);
      return json({ error }, status);
    };

    // Sin firma no se gasta ni lectura del cuerpo.
    const header = req.headers.get("x-hub-signature-256");
    if (!header) return reject(401, "No autorizado");

    let raw: Buffer;
    try {
      raw = await readLimitedBytes(req, MAX_BODY);
    } catch (e) {
      return e instanceof BodyTooLargeError ? reject(413, "Cuerpo demasiado grande") : reject(400, "Solicitud inválida");
    }
    if (!verifySignature(cfg.appSecret, raw, header)) return reject(401, "No autorizado");

    // Desde aquí la firma es válida: ningún límite por IP y, pase lo que pase, se responde 200.
    let messages: InboundMessage[] = [];
    try {
      const body: unknown = JSON.parse(raw.toString("utf8"));
      const r = extractMessages(body, cfg.phoneNumberId);
      messages = r.messages;
      const s = r.stats;
      console.log(
        `[whatsapp] post mensajes=${messages.length} statuses=${s.statuses} otroNumero=${s.foreignNumber} descartados=${s.skipped}${s.truncated ? ` recortados=${s.truncated}` : ""}${r.notWhatsApp ? " motivo=no-whatsapp" : ""} ms=${Date.now() - t0}`,
      );
    } catch {
      console.error("[whatsapp] post con cuerpo no interpretable: ignorado");
    }

    if (messages.length) {
      const work = (async () => {
        try {
          return await processMessages(cfg, messages);
        } catch (e) {
          console.error("[whatsapp] fallo al procesar:", (e as Error)?.message);
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
        // Un intento previo reclamó el mensaje hace poco y no lo cerró: si murió, Meta debe reintentar (y ya será reclamable).
        return json({ error: "Mensaje en proceso, reintenta" }, 503, { "Retry-After": String(INFLIGHT_RETRY_SECONDS) });
      }
      if (!finished) {
        console.warn(`[whatsapp] presupuesto de ${budgetMs} ms agotado: se responde 200 y el trabajo sigue en segundo plano`);
        try {
          deps.after(async () => void (await work));
        } catch {
          /* fuera de una solicitud: `work` ya está corriendo y nadie lo espera */
        }
      }
    }
    return json({ status: "ok" });
  }

  return { GET, POST };
}

/** Dependencias reales (Graph API, repositorio, `after()` de Next). */
export const webhook = createWebhookHandlers({
  config: () => getWhatsAppConfig(),
  io: (c) => createGraphIO({ accessToken: c.accessToken, phoneNumberId: c.phoneNumberId, version: c.graphVersion }),
  handle: handleInbound,
  after: defaultAfter,
});

/** Para pruebas: espera las tareas sueltas de `defaultAfter`. */
export async function flushWebhookWork(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** Para pruebas: vuelve a avisar de configuración inválida. */
export function resetConfigWarning(): void {
  warnedConfig = false;
}
