import { z } from "zod";
import { senderId } from "./config";
import type { InboundMessage } from "@/lib/whatsapp/types";

/** Tope de updates por POST (Telegram manda UNO por POST; esto solo acota el trabajo ante un cuerpo anómalo). */
export const MAX_UPDATES_PER_POST = 50;
const MAX_TEXT = 4096;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export type IgnoreReason =
  | "invalid" | "no-message" | "chat-type" | "channel" | "no-sender" | "bot" | "other-bot"
  /** Mensaje de un grupo que NO está en `TELEGRAM_ALLOWED_CHATS`: se ignora por completo (salvo `/id`). */
  | "group-not-allowed"
  /** Mensaje de un grupo permitido que no es comando, ni responde al bot, ni lo menciona: conversación de personas, se ignora sin responder. */
  | "group-chatter";

export type ChatType = "private" | "group" | "supergroup";

export type ParsedItem =
  /** `chatType`: en grupos el webhook no responde "no entendí" (el bot escucha toda la conversación). */
  | { kind: "message"; message: InboundMessage; chatType: ChatType }
  /** `/id`: se contesta aquí mismo, nunca llega al handler (y es lo único que recibe respuesta sin estar autorizado). */
  | { kind: "id"; userId: string; chatId: string; chatType: ChatType };

export type ExtractResult = {
  items: ParsedItem[];
  /** Solo conteos (para logs): nunca contenido. */
  stats: { updates: number; ignored: number; truncated: number; reasons: Partial<Record<IgnoreReason, number>> };
};

// Esquemas TOLERANTES: Telegram agrega campos sin avisar, así que todo es `looseObject` y cada pieza se valida por separado
// (un campo con el tipo equivocado degrada el mensaje a "other" en vez de tumbar el update).
const topSchema = z.looseObject({ update_id: z.number().int().min(0).max(MAX_SAFE), message: z.unknown().optional() });
const userSchema = z.looseObject({ id: z.number().int().positive().max(MAX_SAFE), is_bot: z.boolean().optional(), username: z.string().max(64).optional() });
const replySchema = z.looseObject({ from: z.unknown().optional() });
const chatSchema = z.looseObject({ id: z.number().int().min(-MAX_SAFE).max(MAX_SAFE), type: z.string().max(30) });
const messageSchema = z.looseObject({
  date: z.unknown().optional(),
  from: z.unknown().optional(),
  chat: z.unknown().optional(),
  text: z.unknown().optional(),
  caption: z.unknown().optional(),
  reply_to_message: z.unknown().optional(),
  document: z.unknown().optional(),
  photo: z.unknown().optional(),
  voice: z.unknown().optional(),
  audio: z.unknown().optional(),
  video_note: z.unknown().optional(),
  animation: z.unknown().optional(),
});
const fileSchema = z.looseObject({
  file_id: z.string().min(1).max(200),
  mime_type: z.string().max(100).optional(),
  file_name: z.string().max(255).optional(),
  file_size: z.number().nonnegative().optional(),
});

const CHAT_TYPES: readonly ChatType[] = ["private", "group", "supergroup"];
/** `/start`, `/ayuda`, `/help` → ayuda (el argumento de un enlace profundo /start xyz no importa). */
const HELP_COMMANDS = new Set(["start", "ayuda", "help"]);
/** Comandos que el handler ya entiende como palabra suelta. */
const WORD_COMMANDS = new Set(["tarjetas", "resumen", "hoy", "deshacer", "cancelar"]);
const COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{1,32}))?(?=\s|$)([\s\S]*)$/;

export type Command = { text: string } | { id: true } | { ignore: "other-bot" };

/**
 * Traduce los comandos de Telegram al texto que ya entiende el handler. Respeta argumentos ("/hoy" → "hoy"), quita el sufijo
 * "@Bot" (si es de OTRO bot y se conoce el nuestro, se ignora el mensaje) y deja pasar lo desconocido como texto normal sin la "/".
 * Un texto que no empieza con "/" se devuelve igual.
 */
export function translateCommand(raw: string, botUsername: string | null): Command {
  if (!raw.startsWith("/")) return { text: raw };
  const m = COMMAND_RE.exec(raw);
  if (!m) return { text: raw.slice(1).trim() };
  const [, name, suffix, rest] = m;
  if (suffix && botUsername && suffix.toLowerCase() !== botUsername.toLowerCase()) return { ignore: "other-bot" };
  const cmd = name.toLowerCase();
  if (cmd === "id") return { id: true };
  if (HELP_COMMANDS.has(cmd)) return { text: "ayuda" };
  if (WORD_COMMANDS.has(cmd)) return { text: `${cmd} ${rest.trim()}`.trim() };
  return { text: `${name}${rest}`.trim() };
}

type Built = { item: ParsedItem } | { ignore: IgnoreReason };

export type ExtractOptions = {
  botUsername?: string | null;
  /** Ids de chat de grupo/supergrupo atendidos (`TELEGRAM_ALLOWED_CHATS`). Vacío u omitido: los grupos se ignoran por completo (salvo `/id`). */
  allowedChats?: readonly string[];
};

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionRe = (botUsername: string) => new RegExp(`(^|[^A-Za-z0-9_])@${escapeRe(botUsername)}(?![A-Za-z0-9_])`, "i");

/** ¿El mensaje responde a un mensaje de un bot (el nuestro, si se conoce su usuario)? */
function repliesToBot(replyTo: unknown, botUsername: string | null): boolean {
  const r = replySchema.safeParse(replyTo);
  if (!r.success) return false;
  const u = userSchema.safeParse(r.data.from);
  if (!u.success || u.data.is_bot !== true) return false;
  return !botUsername || (u.data.username ?? "").toLowerCase() === botUsername.toLowerCase();
}

function build(update: z.infer<typeof topSchema>, opts: ExtractOptions, nowSeconds: number): Built {
  const botUsername = opts.botUsername ?? null;
  const mp = messageSchema.safeParse(update.message);
  if (!mp.success) return { ignore: update.message === undefined || update.message === null ? "no-message" : "invalid" };
  const m = mp.data;

  const cp = chatSchema.safeParse(m.chat);
  if (!cp.success) return { ignore: "invalid" };
  const chatType = CHAT_TYPES.find((t) => t === cp.data.type);
  if (!chatType) return { ignore: cp.data.type === "channel" ? "channel" : "chat-type" };

  if (m.from === undefined || m.from === null) return { ignore: "no-sender" };
  const up = userSchema.safeParse(m.from);
  if (!up.success) return { ignore: "invalid" };
  if (up.data.is_bot === true) return { ignore: "bot" };

  const userId = String(up.data.id);
  const chatId = String(cp.data.id);
  const date = typeof m.date === "number" && Number.isInteger(m.date) && m.date > 0 ? m.date : nowSeconds;
  const base = { id: `tg:${update.update_id}`, from: senderId(userId), replyTo: chatId, timestamp: date, channel: "telegram" as const };

  const group = chatType !== "private";
  const rawText = typeof m.text === "string" ? m.text.slice(0, MAX_TEXT) : null;
  const cmd = rawText === null ? null : translateCommand(rawText, botUsername);
  if (cmd && "ignore" in cmd) return { ignore: cmd.ignore };
  // `/id` funciona en cualquier chat (es como se descubre el id de un grupo para TELEGRAM_ALLOWED_CHATS) y nunca llega al handler.
  if (cmd && "id" in cmd) return { item: { kind: "id", userId, chatId, chatType } };

  // Grupos: el bot oye TODA la conversación (privacidad desactivada), así que solo atiende chats permitidos y solo lo que se le dirige:
  // un comando "/", una respuesta a un mensaje del bot o una mención. Lo demás es plática entre personas y se ignora sin responder.
  let mentioned = false;
  if (group) {
    if (!(opts.allowedChats ?? []).includes(chatId)) return { ignore: "group-not-allowed" };
    const addressedText = rawText ?? (typeof m.caption === "string" ? m.caption.slice(0, MAX_TEXT) : "");
    mentioned = botUsername !== null && mentionRe(botUsername).test(addressedText);
    const isCommand = rawText !== null && rawText.startsWith("/");
    if (!isCommand && !mentioned && !repliesToBot(m.reply_to_message, botUsername)) return { ignore: "group-chatter" };
  }

  if (cmd) {
    let text = cmd.text;
    // "@MiBot 350 starbucks amex" → "350 starbucks amex"; solo la mención → ayuda.
    if (mentioned && botUsername) text = text.replace(new RegExp(mentionRe(botUsername).source, "gi"), "$1").replace(/\s+/g, " ").trim() || "ayuda";
    return { item: { kind: "message", chatType, message: { ...base, type: "text", text } } };
  }

  const other = (): Built => ({ item: { kind: "message", chatType, message: { ...base, type: "other" } } });
  // Un GIF llega con `animation` Y `document`: no es un documento.
  if (m.animation !== undefined) return other();

  if (m.document !== undefined) {
    const f = fileSchema.safeParse(m.document);
    if (!f.success) return other();
    return {
      item: {
        kind: "message",
        chatType,
        message: {
          ...base,
          type: "document",
          media: { id: f.data.file_id, ...(f.data.mime_type ? { mimeType: f.data.mime_type } : {}), ...(f.data.file_name ? { filename: f.data.file_name } : {}) },
        },
      },
    };
  }

  if (Array.isArray(m.photo)) {
    // Telegram manda la misma foto en varios tamaños: se toma el de mayor peso (o el último).
    const sizes = m.photo.map((p) => fileSchema.safeParse(p)).flatMap((r) => (r.success ? [r.data] : []));
    if (!sizes.length) return other();
    const best = sizes.reduce((a, b) => ((b.file_size ?? 0) >= (a.file_size ?? 0) ? b : a));
    return { item: { kind: "message", chatType, message: { ...base, type: "image", media: { id: best.file_id, mimeType: "image/jpeg" } } } };
  }

  for (const key of ["voice", "audio", "video_note"] as const) {
    if (m[key] === undefined) continue;
    const f = fileSchema.safeParse(m[key]);
    if (!f.success) return other();
    return { item: { kind: "message", chatType, message: { ...base, type: "audio", media: { id: f.data.file_id, ...(f.data.mime_type ? { mimeType: f.data.mime_type } : {}) } } } };
  }

  // sticker, video, ubicación, contacto, encuesta, dado, juego, etc.
  return other();
}

/**
 * Convierte el cuerpo de un POST de Telegram (un Update; por tolerancia también un arreglo de ellos) en elementos a procesar.
 * NUNCA lanza: cualquier forma inesperada se descarta y se cuenta. Solo `update.message` cuenta: edited_message, channel_post,
 * callback_query, my_chat_member, etc. se ignoran; también los chats de canal, los mensajes de bots y los sin remitente.
 */
export function extractUpdates(body: unknown, opts: ExtractOptions = {}, now = Date.now()): ExtractResult {
  const result: ExtractResult = { items: [], stats: { updates: 0, ignored: 0, truncated: 0, reasons: {} } };
  const ignore = (reason: IgnoreReason) => {
    result.stats.ignored++;
    result.stats.reasons[reason] = (result.stats.reasons[reason] ?? 0) + 1;
  };
  try {
    const list: unknown[] = Array.isArray(body) ? body : [body];
    const nowSeconds = Math.floor(now / 1000);
    for (const raw of list) {
      if (result.stats.updates >= MAX_UPDATES_PER_POST) {
        result.stats.truncated++;
        continue;
      }
      result.stats.updates++;
      try {
        const t = topSchema.safeParse(raw);
        if (!t.success) {
          ignore("invalid");
          continue;
        }
        const r = build(t.data, opts, nowSeconds);
        if ("ignore" in r) ignore(r.ignore);
        else result.items.push(r.item);
      } catch {
        ignore("invalid"); // getter hostil o valor imprevisto
      }
    }
  } catch {
    ignore("invalid");
  }
  return result;
}
