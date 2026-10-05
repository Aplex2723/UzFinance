import { z } from "zod";
import type { InboundKind, InboundMessage } from "./types";

/** Tope de mensajes procesados por POST (Meta agrupa pocos; esto solo acota el trabajo ante un payload anómalo). */
export const MAX_MESSAGES_PER_POST = 50;
const MAX_TEXT = 4096;

export type ExtractResult = {
  messages: InboundMessage[];
  /** Solo conteos (para logs): nunca contenido. */
  stats: { entries: number; changes: number; statuses: number; foreignNumber: number; skipped: number; truncated: number };
  /** true si el cuerpo no tenía la forma de un webhook de WhatsApp Business. */
  notWhatsApp: boolean;
};

// Esquemas TOLERANTES: Meta agrega campos sin avisar, así que todo es `looseObject` y cada nivel se valida por separado
// (un mensaje raro se descarta sin tumbar a los demás).
const top = z.looseObject({ object: z.string(), entry: z.array(z.unknown()).optional() });
const entrySchema = z.looseObject({ changes: z.array(z.unknown()).optional() });
const changeSchema = z.looseObject({ field: z.string().optional(), value: z.unknown().optional() });
const valueSchema = z.looseObject({
  metadata: z.looseObject({ phone_number_id: z.union([z.string(), z.number()]).optional() }).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});
const mediaSchema = z.looseObject({ id: z.string().min(1).max(100), mime_type: z.string().max(100).optional(), filename: z.string().max(255).optional() });
const messageSchema = z.looseObject({
  id: z.string().min(1).max(120),
  from: z.string().regex(/^\d{8,20}$/),
  timestamp: z.union([z.string(), z.number()]).optional(),
  type: z.string().max(40).optional(),
  text: z.looseObject({ body: z.string() }).optional(),
  document: mediaSchema.optional(),
  image: mediaSchema.optional(),
  audio: mediaSchema.optional(),
});

const MEDIA_KINDS = ["document", "image", "audio"] as const;

function toMessage(raw: unknown, nowSeconds: number): InboundMessage | null {
  const p = messageSchema.safeParse(raw);
  if (!p.success) return null;
  const m = p.data;
  const ts = Number(m.timestamp);
  const timestamp = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : nowSeconds;
  const base = { id: m.id, from: m.from, timestamp };

  if (m.type === "text") {
    return m.text ? { ...base, type: "text", text: m.text.body.slice(0, MAX_TEXT) } : { ...base, type: "other" };
  }
  const kind = MEDIA_KINDS.find((k) => k === m.type);
  if (kind) {
    const media = m[kind];
    if (!media) return { ...base, type: "other" };
    return {
      ...base,
      type: kind satisfies InboundKind,
      media: { id: media.id, ...(media.mime_type ? { mimeType: media.mime_type } : {}), ...(media.filename ? { filename: media.filename } : {}) },
    };
  }
  // reaction, button, interactive, location, contacts, sticker, system, order, unsupported…
  return { ...base, type: "other" };
}

/**
 * Convierte el payload de Meta en mensajes entrantes. NUNCA lanza: cualquier forma inesperada se descarta y se cuenta.
 * Ignora `statuses` (acuses de entrega) y todo `value` cuyo `metadata.phone_number_id` no sea el configurado.
 */
export function extractMessages(body: unknown, phoneNumberId: string, now = Date.now()): ExtractResult {
  const result: ExtractResult = { messages: [], stats: { entries: 0, changes: 0, statuses: 0, foreignNumber: 0, skipped: 0, truncated: 0 }, notWhatsApp: false };
  try {
    const t = top.safeParse(body);
    if (!t.success || t.data.object !== "whatsapp_business_account") {
      result.notWhatsApp = true;
      return result;
    }
    const nowSeconds = Math.floor(now / 1000);
    for (const e of t.data.entry ?? []) {
      const entry = entrySchema.safeParse(e);
      if (!entry.success) continue;
      result.stats.entries++;
      for (const c of entry.data.changes ?? []) {
        const change = changeSchema.safeParse(c);
        if (!change.success || (change.data.field !== undefined && change.data.field !== "messages")) continue;
        const value = valueSchema.safeParse(change.data.value);
        if (!value.success) continue;
        result.stats.changes++;
        result.stats.statuses += value.data.statuses?.length ?? 0;
        if (String(value.data.metadata?.phone_number_id ?? "") !== phoneNumberId) {
          result.stats.foreignNumber++;
          continue;
        }
        for (const raw of value.data.messages ?? []) {
          if (result.messages.length >= MAX_MESSAGES_PER_POST) {
            result.stats.truncated++;
            continue;
          }
          const msg = toMessage(raw, nowSeconds);
          if (msg) result.messages.push(msg);
          else result.stats.skipped++;
        }
      }
    }
  } catch {
    // Defensa extra: ni un getter hostil ni un valor imprevisto deben propagarse.
    result.notWhatsApp = true;
  }
  return result;
}
