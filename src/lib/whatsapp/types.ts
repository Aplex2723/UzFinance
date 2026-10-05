/**
 * Contrato del bot de chat (WhatsApp por la API de la nube de Meta, y Telegram: ambos comparten TODA la lógica de conversación). El webhook (`src/app/api/whatsapp`) valida firma y remitente, convierte el
 * payload de Meta en `InboundMessage` y llama a `handleInbound`; toda la lógica (texto, PDF, deshacer…) vive detrás de ese contrato y
 * habla con el exterior solo a través de `WhatsAppIO`, así se prueba sin red.
 */
export type InboundKind = "text" | "document" | "image" | "audio" | "other";

export type InboundMessage = {
  /** wamid de Meta (o `tg:<update_id>` en Telegram): único, base de la idempotencia. */
  id: string;
  /** Número del remitente, solo dígitos (wa_id de Meta). */
  from: string;
  /**
   * Canal de chat de donde viene (por omisión WhatsApp). Telegram reutiliza TODA la lógica de conversación: el transporte
   * (`src/lib/telegram`) arma `InboundMessage` con `channel: "telegram"`, `from: "tg<idDeUsuario>"` (por persona: pendientes y
   * "deshacer" son por remitente), `replyTo: "<idDelChat>"` (a dónde se responde: en un grupo no es el usuario) e `id: "tg:<update_id>"`.
   */
  channel?: "whatsapp" | "telegram";
  /** A dónde responder si no es `from` (p. ej. el chat de grupo de Telegram). Sin esto se responde a `from`. */
  replyTo?: string;
  /** Segundos desde epoch, como lo mandan Meta y Telegram: es la hora en que se ENVIÓ el mensaje (no la de proceso). */
  timestamp: number;
  type: InboundKind;
  /** Solo type="text". */
  text?: string;
  /** Solo type="document" | "image" | "audio". */
  media?: { id: string; mimeType?: string; filename?: string };
};

/** Persona autorizada (lista blanca de configuración). */
export type Sender = { waId: string; name: string };

export interface WhatsAppIO {
  /** Responde al remitente. Nunca lanza (un fallo de red no debe romper el procesamiento). */
  sendText(to: string, body: string): Promise<void>;
  /** Descarga un archivo recibido. Lanza si pesa más de `maxBytes` o no se puede obtener. */
  downloadMedia(mediaId: string, maxBytes: number): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

export type HandleDeps = {
  /** Categorizador de comercios (por omisión el de la app). */
  categorizer?: import("@/lib/categorizer").Categorizer;
  /**
   * Hora REAL de proceso. Por omisión `new Date()`; el transporte debe dejarlo así (o pasar `new Date()`), NUNCA la hora del mensaje:
   * la hora del mensaje es `msg.timestamp` (el handler la recorta a `now` si viene adelantada) y es la que decide "hoy"/"ayer" y la
   * caducidad de lo pendiente; `now - msg.timestamp > 48 h` rechaza el mensaje ("reenvíalo"). Si el transporte pasa la hora del
   * mensaje como `now`, esa guarda de 48 h jamás se activa. Solo las pruebas fijan `now` a propósito.
   */
  now?: Date;
  /** Base de la app para los enlaces (https://…, sin barra final). Si no viene, se omiten los enlaces. */
  appUrl?: string;
  /** Solo pruebas: OCR de los comprobantes en PDF de imagen (por omisión, el OCR local real). */
  ocr?: (bytes: Uint8Array) => Promise<import("@/lib/pdf/ocr").OcrResult>;
};

/** Hora de un último dígito: Meta manda 521… para móviles de México; se compara por los últimos 10 dígitos. */
export const lastDigits = (n: string, k = 10) => n.replace(/\D/g, "").slice(-k);

/**
 * A dónde se responde: `replyTo` si el transporte lo manda (el chat de Telegram, que en un grupo no es el usuario) y, si no, el remitente.
 * En WhatsApp, un móvil de México que llega como `521` + 10 dígitos se contesta a `52` + 10 dígitos: así suelen guardarse los destinatarios
 * de prueba de Meta, y con `521` el envío falla (código 131030, "destinatario no está en la lista permitida").
 */
export function replyAddress(msg: Pick<InboundMessage, "from" | "replyTo" | "channel">): string {
  const to = msg.replyTo ?? msg.from;
  if (msg.channel === "telegram") return to;
  const digits = to.replace(/^\+/, "");
  return /^521\d{10}$/.test(digits) ? `52${digits.slice(3)}` : to;
}
