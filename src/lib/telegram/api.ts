import { z } from "zod";
import { stripFormat } from "@/lib/whatsapp/replies";
import type { WhatsAppIO } from "@/lib/whatsapp/types";
import { SECRET_RE, TOKEN_RE } from "./config";

/** Host FIJO: ni la respuesta de getFile ni un redirect pueden llevar la descarga (cuya URL contiene el token) a otro host. */
const API_ORIGIN = "https://api.telegram.org";
export const MAX_SEND_CHARS = 4096;
const SEND_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 30_000;
const MAX_JSON = 64 * 1024;
const MAX_RETRY_AFTER_S = 5;

export type TelegramIOOptions = {
  botToken: string;
  /** Para pruebas: nunca se usa la red real. */
  fetchImpl?: typeof fetch;
  /** Espera antes del único reintento tras un 5xx (ms). */
  retryDelayMs?: number;
  sendTimeoutMs?: number;
  mediaTimeoutMs?: number;
};

/** Recorta sin partir un par sustituto (emoji) por la mitad. */
export function truncateForTelegram(body: string, max = MAX_SEND_CHARS): string {
  if (body.length <= max) return body;
  let cut = body.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Ruta de archivo de getFile (p. ej. "documents/file_12.pdf"): sin "..", sin esquema, sin "//", solo caracteres seguros. */
export function isSafeFilePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= 300 &&
    /^[A-Za-z0-9_./-]+$/.test(p) &&
    !p.startsWith("/") &&
    !p.includes("//") &&
    p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
  );
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error("respuesta demasiado grande");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type ApiError = { code: number | string; description: string; retryAfter: number | null };

/** Cuerpo de error de la Bot API: `{ok:false, error_code, description, parameters:{retry_after}}`. Nunca lanza. */
async function readApiError(res: Response): Promise<ApiError> {
  try {
    const j = JSON.parse(await readCapped(res, MAX_JSON)) as { error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };
    const code = typeof j?.error_code === "number" || (typeof j?.error_code === "string" && /^\d{1,8}$/.test(j.error_code)) ? j.error_code : "?";
    const ra = Number(j?.parameters?.retry_after);
    return { code, description: typeof j?.description === "string" ? j.description : "", retryAfter: Number.isFinite(ra) && ra >= 0 ? ra : null };
  } catch {
    return { code: "?", description: "", retryAfter: null };
  }
}

/** Mensajes de error que se dejan salir tal cual: fijos, sin token, URL ni cuerpos de respuesta. */
const SAFE_MESSAGES = new Set([
  "Identificador de archivo inválido",
  "Telegram no entregó el archivo",
  "Respuesta de Telegram inválida",
  "El archivo es demasiado grande",
  "Origen del archivo no permitido",
  "No se pudo descargar el archivo",
]);

const fileInfoSchema = z.looseObject({
  ok: z.literal(true),
  result: z.looseObject({ file_path: z.string().max(500).optional(), file_size: z.number().nonnegative().optional() }),
});

/** Nombre limpio de la ruta para decidir el tipo (la ruta ya está validada). */
const isPdfPath = (p: string) => /\.pdf$/i.test(p);
const startsWithPdfMagic = (b: Uint8Array) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d;

/** Quita el prefijo "tg" de un id de remitente: el handler puede pasar `from` ("tg123") cuando no hay `replyTo`. */
const chatTarget = (to: string) => to.replace(/^tg(?=\d)/, "");

/**
 * Cliente de la Bot API de Telegram. Los errores son mensajes fijos: nunca incluyen el token, la URL de descarga (que lo lleva),
 * ids ni cuerpos de respuesta. Los logs llevan solo el status HTTP y el `error_code` de Telegram.
 */
export function createTelegramIO(opts: TelegramIOOptions): WhatsAppIO {
  const f = opts.fetchImpl ?? fetch;
  const sendTimeout = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const mediaTimeout = opts.mediaTimeoutMs ?? MEDIA_TIMEOUT_MS;
  const retryDelay = opts.retryDelayMs ?? 800;
  const base = `${API_ORIGIN}/bot${opts.botToken}`;

  async function sendText(to: string, body: string): Promise<void> {
    try {
      const chat = chatTarget(String(to));
      // Los textos fijos del bot marcan *negritas* al estilo de WhatsApp; aquí se manda texto plano (sin parse_mode), así que se quitan.
      const text = stripFormat(String(body));
      if (!/^-?\d{1,20}$/.test(chat) || !text.trim()) {
        console.error("[telegram] envío omitido: destinatario o cuerpo inválido");
        return;
      }
      // Texto plano (sin parse_mode): un comercio hostil no puede romper el formato ni inyectar enlaces con marcado.
      const payload = JSON.stringify({ chat_id: chat, text: truncateForTelegram(text), disable_web_page_preview: true });
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: Response;
        try {
          res = await f(`${base}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: payload,
            redirect: "error",
            signal: AbortSignal.timeout(sendTimeout),
          });
        } catch (e) {
          // Tiempo agotado o red: no se reintenta (el mensaje pudo haber salido y se duplicaría).
          console.error(`[telegram] envío falló: ${(e as Error)?.name === "TimeoutError" ? "tiempo agotado" : "error de red"}`);
          return;
        }
        if (res.ok) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        const err = await readApiError(res);
        const retryable = res.status === 429 || res.status >= 500;
        // 429: solo se espera si Telegram pide ≤ 5 s; si pide más, no vale la pena retener el procesamiento.
        const tooLong = res.status === 429 && (err.retryAfter === null ? false : err.retryAfter > MAX_RETRY_AFTER_S);
        const willRetry = retryable && attempt === 0 && !tooLong;
        console.error(`[telegram] envío falló: status=${res.status} error_code=${err.code}${willRetry ? " (reintento)" : ""}`);
        if (!willRetry) return;
        const wait = res.status === 429 && err.retryAfter !== null ? err.retryAfter * 1000 : retryDelay;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch {
      console.error("[telegram] envío falló: error inesperado");
    }
  }

  async function downloadMedia(fileId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (typeof fileId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(fileId)) throw new Error("Identificador de archivo inválido");
    const signal = AbortSignal.timeout(mediaTimeout);
    try {
      // 1) getFile: ruta y tamaño. Redirect "manual": cualquier 3xx se rechaza (el host no puede cambiar).
      const metaRes = await f(`${base}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        redirect: "manual",
        signal,
      });
      if (metaRes.status >= 300 && metaRes.status < 400) {
        await metaRes.body?.cancel().catch(() => {});
        throw new Error("Origen del archivo no permitido");
      }
      if (!metaRes.ok) {
        const err = await readApiError(metaRes);
        console.error(`[telegram] metadatos del archivo: status=${metaRes.status} error_code=${err.code}`);
        // Telegram solo entrega hasta 20 MB: "Bad Request: file is too big".
        throw new Error(/too big/i.test(err.description) ? "El archivo es demasiado grande" : "Telegram no entregó el archivo");
      }
      let filePath: string;
      let declared: number | undefined;
      try {
        const meta = fileInfoSchema.parse(JSON.parse(await readCapped(metaRes, MAX_JSON)));
        if (!isSafeFilePath(meta.result.file_path)) throw new Error("ruta");
        filePath = meta.result.file_path;
        declared = meta.result.file_size;
      } catch {
        throw new Error("Respuesta de Telegram inválida");
      }
      if (declared !== undefined && declared > maxBytes) throw new Error("El archivo es demasiado grande");

      // 2) Descarga desde el host fijo. La URL lleva el token: jamás se loguea ni se pone en un error.
      const url = `${API_ORIGIN}/file/bot${opts.botToken}/${filePath}`;
      if (new URL(url).origin !== API_ORIGIN) throw new Error("Origen del archivo no permitido");
      const res = await f(url, { redirect: "manual", signal });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new Error("Origen del archivo no permitido");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        console.error(`[telegram] descarga del archivo: status=${res.status}`);
        throw new Error("No se pudo descargar el archivo");
      }
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new Error("El archivo es demasiado grande");
      }

      // 3) Lectura con tope duro de bytes (no se confía en file_size ni en Content-Length).
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error("El archivo es demasiado grande");
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        bytes.set(c, off);
        off += c.byteLength;
      }
      // El contrato no trae el tipo del mensaje: se deduce PDF por extensión o por los bytes; lo demás es genérico.
      return { bytes, mimeType: isPdfPath(filePath) || startsWithPdfMagic(bytes) ? "application/pdf" : "application/octet-stream" };
    } catch (e) {
      if (e instanceof Error && SAFE_MESSAGES.has(e.message)) throw new Error(e.message);
      throw new Error(signal.aborted ? "Se agotó el tiempo al descargar el archivo" : "No se pudo descargar el archivo");
    }
  }

  return { sendText, downloadMedia };
}

// ---------------------------------------------------------------------------------------------------------------------
// Puesta en marcha (nunca se llaman desde la app en runtime: scripts/telegram-setup.sh hace lo mismo con python3).
// ---------------------------------------------------------------------------------------------------------------------

type SetupOpts = { botToken: string; fetchImpl?: typeof fetch; timeoutMs?: number };

async function callApi(method: string, o: SetupOpts, body?: Record<string, unknown>): Promise<unknown> {
  if (!TOKEN_RE.test(o.botToken)) throw new Error("Token del bot inválido");
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${API_ORIGIN}/bot${o.botToken}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? SEND_TIMEOUT_MS),
    });
  } catch {
    throw new Error("No se pudo contactar a Telegram");
  }
  let json: { ok?: unknown; result?: unknown } | null = null;
  try {
    json = JSON.parse(await readCapped(res, MAX_JSON));
  } catch {
    json = null;
  }
  if (!res.ok || json?.ok !== true) throw new Error(`Telegram rechazó la solicitud (status ${res.status})`);
  return json.result;
}

/** `getMe`: id y @usuario del bot (valida el token). */
export async function getMe(o: SetupOpts): Promise<{ id: number; username: string; firstName: string }> {
  const r = z.looseObject({ id: z.number(), username: z.string().optional(), first_name: z.string().optional() }).safeParse(await callApi("getMe", o));
  if (!r.success || !r.data.username) throw new Error("Respuesta de Telegram inválida");
  return { id: r.data.id, username: r.data.username, firstName: r.data.first_name ?? "" };
}

/** `setWebhook` con secret_token, solo `message`, 5 conexiones y descartando lo pendiente. */
export async function setTelegramWebhook(o: SetupOpts & { url: string; secret: string; maxConnections?: number; dropPendingUpdates?: boolean }): Promise<void> {
  let u: URL;
  try {
    u = new URL(o.url);
  } catch {
    throw new Error("URL del webhook inválida");
  }
  if (u.protocol !== "https:" || u.username || u.password) throw new Error("URL del webhook inválida");
  if (!SECRET_RE.test(o.secret)) throw new Error("Secreto del webhook inválido");
  await callApi("setWebhook", o, {
    url: u.toString(),
    secret_token: o.secret,
    allowed_updates: ["message"],
    max_connections: o.maxConnections ?? 5,
    drop_pending_updates: o.dropPendingUpdates ?? true,
  });
}

export async function deleteTelegramWebhook(o: SetupOpts & { dropPendingUpdates?: boolean }): Promise<void> {
  await callApi("deleteWebhook", o, { drop_pending_updates: o.dropPendingUpdates ?? true });
}
