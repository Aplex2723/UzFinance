import { z } from "zod";
import { telegramEnvShape, whatsappEnvShape } from "@/lib/env";
import type { Sender } from "@/lib/whatsapp/types";

export type TelegramConfig = {
  botToken: string;
  webhookSecret: string;
  /** Personas autorizadas (0 a 5). `waId` = "tg" + id numérico de usuario de Telegram. Vacía = modo descubrimiento (solo /id). */
  allowed: Sender[];
  /** Ids de chat de grupo/supergrupo donde el bot atiende (strings, p. ej. "-1001234567890"). Vacía (por omisión) = los grupos se ignoran por completo. Los chats privados no dependen de esta lista. */
  allowedChats: string[];
  /** Usuario del bot en minúsculas y sin "@", o null (entonces no se filtran comandos dirigidos a otro bot). */
  botUsername: string | null;
  /** URL pública de la app (sin "/" final) o null si no se pudo deducir. */
  appUrl: string | null;
};

export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;
export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,31}$/;
const NAME_RE = /^[\p{L} .'-]{1,30}$/u;
const USER_ID_RE = /^[1-9]\d{0,14}$/;
export const MAX_ALLOWED = 5;
export const MAX_ALLOWED_CHATS = 10;
/** Ids de chat: enteros distintos de cero, con "-" para grupos (supergrupos: -100…, 13 dígitos). */
const CHAT_ID_RE = /^-?[1-9]\d{0,14}$/;

/** Los ids de usuario de Telegram son enteros positivos; el prefijo "tg" mantiene `wa_id` ≤ 20 caracteres y separa canales. */
export const senderId = (userId: string | number) => `tg${userId}`;

/**
 * "123456789=Alex,987654321=Sam" → [{waId: "tg123456789", name}]. Vacía ("" o solo espacios) es VÁLIDA y da []: modo descubrimiento.
 * `null` si algo es inválido (falla cerrado: una lista a medias podría autorizar de más o de menos). 0 a 5 personas sin repetir id.
 */
export function parseAllowed(raw: string | undefined): Sender[] | null {
  const out: Sender[] = [];
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i < 1) return null;
    const id = part.slice(0, i).trim();
    const name = part.slice(i + 1).trim();
    if (!USER_ID_RE.test(id) || !NAME_RE.test(name) || name.replace(/[ .'-]/g, "") === "") return null;
    if (out.some((s) => s.waId === senderId(id))) return null;
    out.push({ waId: senderId(id), name });
  }
  return out.length <= MAX_ALLOWED ? out : null;
}

/**
 * "-1001234567890,-100987" → ["-1001234567890", "-100987"]. Vacía es VÁLIDA y da [] (ningún grupo atendido). `null` si algo es inválido
 * (falla cerrado: una lista a medias podría atender un grupo que no se quería) o hay repetidos o más de 10.
 */
export function parseAllowedChats(raw: string | undefined): string[] | null {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    if (!CHAT_ID_RE.test(part) || out.includes(part)) return null;
    out.push(part);
  }
  return out.length <= MAX_ALLOWED_CHATS ? out : null;
}

/** Busca al remitente por su `from` ("tg<id>"). Compara todos sin cortocircuito. */
export function findSender(allowed: readonly Sender[], from: string): Sender | null {
  let found: Sender | null = null;
  for (const s of allowed) if (s.waId === from && !found) found = { ...s };
  return found;
}

/** "tg123456789" → "***6789": lo único de un id que se escribe en logs. */
export const maskId = (id: string) => `***${id.replace(/\D/g, "").slice(-4)}`;

type Source = Record<string, string | undefined>;

const rawSchema = z.object({ ...telegramEnvShape, APP_URL: whatsappEnvShape.APP_URL, WEBSITE_HOSTNAME: whatsappEnvShape.WEBSITE_HOSTNAME });

/** Sin `source` lee process.env en cada llamada (barato): un cambio de App Settings aplica al reiniciar y las pruebas pueden variarlo. */
function read(source: Source) {
  const p = rawSchema.safeParse(source);
  const r: Record<string, unknown> = p.success ? p.data : {};
  return (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string).trim() : undefined);
}

function deduceAppUrl(v: ReturnType<typeof read>): string | null {
  const explicit = v("APP_URL");
  if (explicit) {
    try {
      const u = new URL(explicit);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.origin;
    } catch {
      /* cae a WEBSITE_HOSTNAME */
    }
  }
  const host = v("WEBSITE_HOSTNAME");
  if (host && /^[A-Za-z0-9.-]{1,253}$/.test(host)) return `https://${host.toLowerCase()}`;
  return null;
}

const normUsername = (raw: string | undefined) => (raw === undefined ? undefined : raw.replace(/^@/, ""));

/** Nombres (nunca valores) de las variables que faltan o son inválidas. Vacío = configuración completa. */
export function telegramConfigIssues(source: Source = process.env): string[] {
  const v = read(source);
  const bad: string[] = [];
  const token = v("TELEGRAM_BOT_TOKEN");
  if (!token || !TOKEN_RE.test(token)) bad.push("TELEGRAM_BOT_TOKEN");
  const secret = v("TELEGRAM_WEBHOOK_SECRET");
  if (!secret || !SECRET_RE.test(secret)) bad.push("TELEGRAM_WEBHOOK_SECRET");
  if (parseAllowed(v("TELEGRAM_ALLOWED")) === null) bad.push("TELEGRAM_ALLOWED");
  if (parseAllowedChats(v("TELEGRAM_ALLOWED_CHATS")) === null) bad.push("TELEGRAM_ALLOWED_CHATS");
  const user = normUsername(v("TELEGRAM_BOT_USERNAME"));
  if (user !== undefined && !USERNAME_RE.test(user)) bad.push("TELEGRAM_BOT_USERNAME");
  return bad;
}

/**
 * Configuración del bot o `null` si falta o es inválido CUALQUIER dato (token, secreto, lista de autorizados, usuario del bot):
 * el webhook falla cerrado y no procesa nada. Nunca incluye secretos en errores ni en logs.
 */
export function getTelegramConfig(source: Source = process.env): TelegramConfig | null {
  if (telegramConfigIssues(source).length) return null;
  const v = read(source);
  const user = normUsername(v("TELEGRAM_BOT_USERNAME"));
  return {
    botToken: v("TELEGRAM_BOT_TOKEN")!,
    webhookSecret: v("TELEGRAM_WEBHOOK_SECRET")!,
    allowed: parseAllowed(v("TELEGRAM_ALLOWED"))!,
    allowedChats: parseAllowedChats(v("TELEGRAM_ALLOWED_CHATS"))!,
    botUsername: user ? user.toLowerCase() : null,
    appUrl: deduceAppUrl(v),
  };
}
