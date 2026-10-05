import { z } from "zod";
import type { WhatsAppIO } from "./types";

const GRAPH_ORIGIN = "https://graph.facebook.com";
export const MAX_SEND_CHARS = 4096;
const SEND_TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 30_000;
const MAX_META_JSON = 64 * 1024;
const MAX_REDIRECTS = 2;

export type GraphIOOptions = {
  accessToken: string;
  phoneNumberId: string;
  version: string;
  /** Para pruebas: nunca se usa la red real. */
  fetchImpl?: typeof fetch;
  /** Espera antes del único reintento (ms). */
  retryDelayMs?: number;
  sendTimeoutMs?: number;
  mediaTimeoutMs?: number;
};

/** Hosts de los que Meta sirve medios; cualquier otro (o http, IP, credenciales, puerto raro) se rechaza para evitar SSRF. */
export function isMetaMediaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  return h === "lookaside.fbsbx.com" || [".fbcdn.net", ".whatsapp.net", ".facebook.com"].some((s) => h.endsWith(s) && h.length > s.length);
}

/** Recorta sin partir un par sustituto (emoji) por la mitad. */
export function truncateForWhatsApp(body: string, max = MAX_SEND_CHARS): string {
  if (body.length <= max) return body;
  let cut = body.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const metaErrorCode = async (res: Response): Promise<number | string> => {
  try {
    const j = JSON.parse(await readCapped(res, MAX_META_JSON)) as { error?: { code?: unknown } };
    const c = j?.error?.code;
    return typeof c === "number" || (typeof c === "string" && /^\d{1,8}$/.test(c)) ? c : "?";
  } catch {
    return "?";
  }
};

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

const metaSchema = z.looseObject({
  url: z.string().max(4096),
  mime_type: z.string().max(200).optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
});

const cleanMime = (m: string | null | undefined): string | null => {
  const v = (m ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.+-]{0,60}\/[a-z0-9][a-z0-9.+-]{0,100}$/.test(v) ? v : null;
};

/**
 * Cliente de la Graph API de WhatsApp. Los errores son mensajes fijos: nunca incluyen el token, la URL firmada del medio,
 * números ni cuerpos de respuesta. Los logs llevan solo el status HTTP y el código de error de Meta.
 */
export function createGraphIO(opts: GraphIOOptions): WhatsAppIO {
  const f = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.accessToken}` };
  const sendTimeout = opts.sendTimeoutMs ?? SEND_TIMEOUT_MS;
  const mediaTimeout = opts.mediaTimeoutMs ?? MEDIA_TIMEOUT_MS;
  const retryDelay = opts.retryDelayMs ?? 800;
  const base = `${GRAPH_ORIGIN}/${opts.version}`;

  async function sendText(to: string, body: string): Promise<void> {
    try {
      if (!/^\d{8,20}$/.test(to) || !body.trim()) {
        console.error("[whatsapp] envío omitido: destinatario o cuerpo inválido");
        return;
      }
      const payload = JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { body: truncateForWhatsApp(body), preview_url: false },
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: Response;
        try {
          res = await f(`${base}/${opts.phoneNumberId}/messages`, {
            method: "POST",
            headers: { ...auth, "Content-Type": "application/json" },
            body: payload,
            redirect: "error",
            signal: AbortSignal.timeout(sendTimeout),
          });
        } catch (e) {
          // Tiempo agotado o red: no se reintenta (el mensaje pudo haber salido y se duplicaría).
          console.error(`[whatsapp] envío falló: ${(e as Error)?.name === "TimeoutError" ? "tiempo agotado" : "error de red"}`);
          return;
        }
        if (res.ok) {
          await res.body?.cancel().catch(() => {});
          return;
        }
        const code = await metaErrorCode(res);
        const retryable = res.status === 429 || res.status >= 500;
        console.error(`[whatsapp] envío falló: status=${res.status} code=${code}${retryable && attempt === 0 ? " (reintento)" : ""}`);
        if (!retryable || attempt === 1) return;
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : retryDelay;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch {
      console.error("[whatsapp] envío falló: error inesperado");
    }
  }

  async function downloadMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }> {
    if (!/^\d{5,40}$/.test(mediaId)) throw new Error("Identificador de archivo inválido");
    const signal = AbortSignal.timeout(mediaTimeout);
    try {
      // 1) Metadatos (URL temporal firmada, tipo y tamaño).
      const metaRes = await f(`${base}/${mediaId}`, { headers: auth, redirect: "manual", signal });
      if (!metaRes.ok) {
        const code = await metaErrorCode(metaRes);
        console.error(`[whatsapp] metadatos del archivo: status=${metaRes.status} code=${code}`);
        throw new Error("Meta no entregó el archivo");
      }
      let meta: z.infer<typeof metaSchema>;
      try {
        meta = metaSchema.parse(JSON.parse(await readCapped(metaRes, MAX_META_JSON)));
      } catch {
        throw new Error("Respuesta de Meta inválida");
      }
      const declared = Number(meta.file_size);
      if (meta.file_size !== undefined && Number.isFinite(declared) && declared > maxBytes) throw new Error("El archivo es demasiado grande");
      if (!isMetaMediaUrl(meta.url)) throw new Error("Origen del archivo no permitido");

      // 2) Descarga con el mismo Bearer; los redirects se siguen a mano revalidando el host (y sin filtrar el token fuera de Meta).
      let url = meta.url;
      let res: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        res = await f(url, { headers: auth, redirect: "manual", signal });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!loc) break;
        await res.body?.cancel().catch(() => {});
        let next: string;
        try {
          next = new URL(loc, url).toString();
        } catch {
          throw new Error("Origen del archivo no permitido");
        }
        if (!isMetaMediaUrl(next) || hop === MAX_REDIRECTS) throw new Error("Origen del archivo no permitido");
        url = next;
      }
      if (!res || !res.ok) {
        console.error(`[whatsapp] descarga del archivo: status=${res?.status ?? 0}`);
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
      return { bytes, mimeType: cleanMime(meta.mime_type) ?? cleanMime(res.headers.get("content-type")) ?? "application/octet-stream" };
    } catch (e) {
      if (e instanceof Error && SAFE_MESSAGES.has(e.message)) throw new Error(e.message);
      throw new Error(signal.aborted ? "Se agotó el tiempo al descargar el archivo" : "No se pudo descargar el archivo");
    }
  }

  return { sendText, downloadMedia };
}

/** Únicos mensajes que `downloadMedia` deja pasar tal cual; cualquier otro error (red, undici…) se reemplaza por uno genérico. */
const SAFE_MESSAGES = new Set([
  "Identificador de archivo inválido",
  "Meta no entregó el archivo",
  "Respuesta de Meta inválida",
  "El archivo es demasiado grande",
  "Origen del archivo no permitido",
  "No se pudo descargar el archivo",
]);
