/**
 * Única fuente de verdad de las etiquetas de `transactions.sources` que ponen los bots de chat (WhatsApp y Telegram), y de los
 * fragmentos SQL que dependen de ellas: qué se puede fundir con el Atajo o el correo, qué se puede deshacer y qué cuenta como
 * "sin confirmar". Quien agregue un canal nuevo solo toca este archivo.
 *
 * Etiquetas (columna `sources`, VARCHAR(40), separadas por coma cuando varias fuentes confirman el mismo gasto):
 *   - `whatsapp` / `telegram`        gasto tecleado con la hora del mensaje: se puede fundir con el Atajo o el correo del banco.
 *   - `whatsapp-d` / `telegram-d`    gasto tecleado con FECHA explícita (no hoy): la hora es artificial (12:00), así que NO se funde
 *                                    solo con un Atajo o correo de otra compra parecida; sí cuenta como chat para deshacer,
 *                                    "sin confirmar" y las etiquetas de la app.
 *
 * Los fragmentos SQL se arman SOLO con constantes de este archivo (nunca con texto del usuario).
 */
export const CHAT_CHANNELS = ["whatsapp", "telegram"] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];

export const CHANNEL_NAME: Record<ChatChannel, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };

/** Sufijo de una fila de chat con fecha explícita. */
export const DATED_SUFFIX = "-d";

/** Etiquetas fusionables (hora real del mensaje). */
export const MERGEABLE_CHAT_SOURCES: readonly string[] = CHAT_CHANNELS;
/** Etiquetas de fila con fecha explícita (no fusionables solas). */
export const DATED_CHAT_SOURCES: readonly string[] = CHAT_CHANNELS.map((c) => `${c}${DATED_SUFFIX}`);
/** Todas las etiquetas de chat. */
export const CHAT_SOURCES: readonly string[] = [...MERGEABLE_CHAT_SOURCES, ...DATED_CHAT_SOURCES];

/** Etiqueta de `sources` para un gasto tecleado en `channel`; `dated` = trae fecha explícita distinta de hoy. */
export const chatSourceTag = (channel: ChatChannel, dated: boolean): string => (dated ? `${channel}${DATED_SUFFIX}` : channel);

/** Canal de un mensaje (WhatsApp por omisión). */
export const channelOf = (c: string | null | undefined): ChatChannel => (c === "telegram" ? "telegram" : "whatsapp");

/** ¿Este token suelto de `sources` es una etiqueta de chat? */
export const isChatSource = (token: string): boolean => CHAT_SOURCES.includes(token.trim());

/** ¿Se puede deshacer desde el chat? Solo si `sources` es EXACTAMENTE una etiqueta de chat o 'receipt' (nadie más lo ha tocado). */
export const isUndoableSources = (sources: string): boolean => sources === "receipt" || CHAT_SOURCES.includes(sources);

/** Etiquetas legibles de cada fuente (para "vía …"). */
export const SOURCE_LABELS: Record<string, string> = {
  shortcut: "Atajo",
  email: "correo",
  statement: "estado de cuenta",
  receipt: "comprobante PDF",
  manual: "la app",
  ...Object.fromEntries(CHAT_CHANNELS.flatMap((c) => [[c, CHANNEL_NAME[c]], [`${c}${DATED_SUFFIX}`, CHANNEL_NAME[c]]])),
};

/** `origin` con el que se guarda un PDF recibido por cada canal (`ck_documents_origin`: 'app', 'whatsapp', 'telegram'; migración 010). */
export const DOC_ORIGIN: Record<ChatChannel, "whatsapp" | "telegram"> = { whatsapp: "whatsapp", telegram: "telegram" };

/**
 * Etiquetas de la INTERFAZ de la app (capitalizadas; las fuentes con fecha explícita lo dicen). Distintas de `SOURCE_LABELS`, que son
 * las frases en minúscula de las respuestas del bot ("vía …") y no distinguen la fecha indicada. Sin dependencias de servidor:
 * se puede importar desde componentes de cliente.
 */
export const SOURCE_UI_LABELS: Record<string, string> = {
  shortcut: "Atajo",
  email: "Correo",
  statement: "Estado de cuenta",
  receipt: "Comprobante PDF",
  manual: "Manual",
  ...Object.fromEntries(CHAT_CHANNELS.flatMap((c) => [[c, CHANNEL_NAME[c]], [`${c}${DATED_SUFFIX}`, `${CHANNEL_NAME[c]} (fecha indicada)`]])),
};

/**
 * `transactions.sources` ("whatsapp,email", "telegram,shortcut,email", "telegram-d"…) → texto en español para la interfaz: una etiqueta
 * por fuente, sin repetir, en el orden en que vienen, unidas con `sep`. Una fuente desconocida se muestra tal cual (no se pierde
 * información); vacío da "".
 */
export function sourcesLabel(sources: string | null | undefined, sep = " + "): string {
  const out: string[] = [];
  for (const raw of String(sources ?? "").split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const label = SOURCE_UI_LABELS[tok] ?? tok;
    if (!out.includes(label)) out.push(label);
  }
  return out.join(sep);
}

/** `documents.origin` → texto para la interfaz ("la app" es lo normal y no lleva etiqueta). */
export const originLabel = (origin: string | null | undefined): string | null => (origin === "whatsapp" ? CHANNEL_NAME.whatsapp : origin === "telegram" ? CHANNEL_NAME.telegram : null);

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const withShortcut = MERGEABLE_CHAT_SOURCES.map((c) => `${c},shortcut`);

export const SQL = {
  /** `IN (…)` de filas de chat fusionables: 'whatsapp', 'telegram'. */
  mergeableChat: list(MERGEABLE_CHAT_SOURCES),
  /** Filas de chat que el CORREO puede absorber: Atajo solo, chat solo o chat + Atajo (nunca las de fecha explícita). */
  emailMergeable: list(["shortcut", ...MERGEABLE_CHAT_SOURCES, ...withShortcut]),
  /** Filas que se pueden borrar con "deshacer": una sola etiqueta de chat (fusionable o con fecha) o 'receipt'. */
  undoable: list([...CHAT_SOURCES, "receipt"]),
  /**
   * "Sin confirmar" (junto con Banamex, gasto y más de 24 h): Atajo solo, o chat (con o sin fecha, con o sin Atajo) y ningún correo.
   * `x` es el alias de la tabla de transacciones.
   */
  unconfirmed: (x = "x") => `(${x}.email_message_id IS NULL AND ${x}.sources IN (${list(["shortcut", ...CHAT_SOURCES, ...withShortcut])}))`,
} as const;
