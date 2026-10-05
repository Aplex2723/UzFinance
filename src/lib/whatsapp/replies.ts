import { CHANNEL_NAME, SOURCE_LABELS, type ChatChannel } from "@/lib/chat-sources";
import { formatMXN } from "@/lib/money";
import { cardLabel, type CardLite } from "./cards";
import type { AmountNote } from "./parse-expense";
import type { IntakeResult } from "@/lib/docs/intake";

/**
 * Todos los textos que el bot manda (WhatsApp y Telegram comparten los mismos). Funciones puras: sin base de datos ni red. Los textos fijos
 * marcan *negritas* con asteriscos (formato de WhatsApp): lo que viene del usuario o de un PDF pasa por `plain` para que nunca se
 * interprete como formato, y un transporte que no admita ese formato puede quitar los asteriscos con `stripFormat`.
 */
export const MAX_REPLY = 3800;

/** Texto del usuario (comercio, nombre de tarjeta…) sin caracteres que WhatsApp interprete como formato. */
export const plain = (s: string, max = 120) => s.replace(/[*_~`]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

/** Quita las marcas de *negrita* de los textos fijos (para un transporte que manda texto plano). Lo del usuario ya viene sin asteriscos. */
export const stripFormat = (s: string) => s.replace(/\*([^*\n]+)\*/g, "$1");

export const clip = (s: string) => (s.length > MAX_REPLY ? `${s.slice(0, MAX_REPLY - 1)}…` : s);

export const money = (cents: number) => formatMXN(cents);

/** Ayuda del canal: menciona dónde estás y, en Telegram, que los comandos también van con barra. */
export function help(channel: ChatChannel = "whatsapp"): string {
  const lines = [
    `👋 Soy el bot de UzFinance en ${CHANNEL_NAME[channel]}. Mándame un gasto en una línea, por ejemplo:`,
    "• 350 starbucks amex",
    "• ayer 450 oxxo débito",
    "• gasté $1,200.50 en gasolina con la explora",
    "",
    "También leo comprobantes de transferencia y estados de cuenta en PDF.",
    "Comandos: *tarjetas*, *hoy*, *resumen*, *deshacer*, *cancelar*.",
  ];
  if (channel === "telegram") lines.push("También sirven con barra (/tarjetas, /hoy, /resumen, /deshacer, /cancelar). En un grupo, cada quien tiene sus propios pendientes y su *deshacer*.");
  return lines.join("\n");
}
export const HELP = help("whatsapp");

export const NOT_UNDERSTOOD = "No encontré un monto en tu mensaje 🤔. Prueba así: *350 starbucks amex*. Escribe *ayuda* para ver más.";
export const OUT_OF_CONTEXT = "No tengo nada pendiente contigo. Mándame un gasto como *350 starbucks amex* o escribe *ayuda*.";
export const NO_CARDS = "Todavía no hay tarjetas activas en la app. Agrégalas en UzFinance y vuelve a intentar.";
export const TOO_OLD = "Ese mensaje es de hace más de 48 horas y ya no puedo procesarlo con seguridad. Reenvíalo y lo registro.";
export const MEDIA_UNSUPPORTED = "Por ahora leo texto y PDF 📄. Si es un comprobante, mándalo como PDF; si es un gasto, escríbelo: *350 starbucks amex*.";
export const INTERNAL_ERROR = "Algo falló de mi lado y no pude completarlo. No guardé nada; inténtalo de nuevo en un momento.";
export const CANCELLED = "Listo, lo cancelé. No guardé nada.";
export const NOTHING_TO_CANCEL = "No había nada pendiente que cancelar.";
export const GAVE_UP = "No pude entender la respuesta y cancelé el registro. Cuando quieras, mándame el gasto de nuevo.";
export const SAME_TWICE = "Ese gasto ya estaba registrado (mismo comercio, monto y minuto), no lo dupliqué.";
export const NOT_ANOTHER = "Listo, no registré el gasto: ya estaba.";

export const undoNothing = () => "No tengo ningún gasto tuyo reciente que deshacer (solo los de los últimos 30 minutos).";
export const undone = (merchant: string, cents: number, card: string) => `↩️ Deshecho: ${plain(merchant)} ${money(cents)} (${plain(card)}). Ya no aparece en la app.`;
export const undoConfirmed = (merchant: string, cents: number) =>
  `${plain(merchant)} ${money(cents)} ya fue confirmado por el banco o el Atajo, así que no lo borro desde aquí. Si hay que corregirlo, edítalo en la app.`;

export function cardsList(cards: CardLite[]): string {
  if (!cards.length) return NO_CARDS;
  return ["💳 Tus tarjetas activas:", ...cards.map((c) => `• ${plain(cardLabel(c))}`), "", "Escríbeme el gasto y el nombre de la tarjeta, por ejemplo: *350 starbucks amex*."].join("\n");
}

export type Summary = { merchant: string | null; cents: number | null };
const what = (s: Summary) => [s.cents ? money(s.cents) : null, s.merchant ? plain(s.merchant) : null].filter(Boolean).join(" · ");

const int = (digits: string) => `$${Number(digits).toLocaleString("en-US")}`;
/** "$7" si son pesos exactos, "$12.50" si no. */
const plainMoney = (cents: number) => (cents % 100 === 0 ? int(String(cents / 100)) : money(cents));

/** `why`: por qué no se tomó un monto (true = varios números, por compatibilidad); null/false = simplemente falta. */
export function askAmount(s: Summary, why: AmountNote | boolean | null): string {
  const note = why === true ? ({ kind: "many" } as const) : why || null;
  if (note?.kind === "last4") {
    return `«${plain(note.digits, 4)}»: ¿${int(note.digits)} o terminación ${plain(note.digits, 4)}? Responde *${int(note.digits)}* si es el monto, o *terminación ${plain(note.digits, 4)}* si es la tarjeta (luego te pregunto el monto). (O *cancelar*.)`;
  }
  if (note?.kind === "either") {
    const amount = plainMoney(note.cents);
    return `${s.merchant ? `${plain(s.merchant)}: ` : ""}¿Cuánto fue: $${Number(note.ending).toLocaleString("en-US")} o ${amount}? Escribe solo el monto, por ejemplo *$350.50*. Si ${plain(note.ending, 4)} es la terminación de tu tarjeta, responde *terminación ${plain(note.ending, 4)}* y el monto será ${amount}. (O *cancelar*.)`;
  }
  const head =
    note?.kind === "time" ? `Vi una hora («${plain(note.raw, 30)}») pero no un monto. `
    : note?.kind === "many" ? "Vi varios números en tu mensaje. "
    : note?.kind === "installments" ? "Vi una cifra de meses sin intereses, que no es el monto. "
    : note?.kind === "mil" ? `No me quedó claro «${plain(note.raw, 30)}» (¿mil, mil quinientos…?). `
    : "";
  return `${head}¿Cuánto fue${s.merchant ? ` lo de ${plain(s.merchant)}` : ""}${note?.kind === "installments" ? " en total" : ""}? Escribe solo el monto, por ejemplo *$350.50*. (O *cancelar*.)`;
}
export const askMerchant = (s: Summary) => `${s.cents ? `${money(s.cents)}. ` : ""}¿En qué comercio? (O *cancelar*.)`;

/** Lista numerada de tarjetas (máx. 9, se responde con el número). */
export function askCard(s: Summary, cards: CardLite[], opts: { hint?: string | null; subset: boolean }): string {
  const shown = cards.slice(0, 9);
  const lines = shown.map((c, i) => `${i + 1}. ${plain(cardLabel(c))}`);
  const more = cards.length > shown.length ? [`…y ${cards.length - shown.length} más: escribe el nombre de la tarjeta.`] : [];
  const head = opts.hint ? `No encontré una tarjeta que termine en ${plain(opts.hint, 4)}. ` : "";
  return [`${what(s)}`, `${head}${opts.subset ? "Hay varias tarjetas posibles." : "No supe con qué tarjeta fue."} ¿Con cuál? Responde con el número:`, ...lines, ...more, "(O *cancelar*.)"].filter((x) => x !== "").join("\n");
}

export const askConfirm = (s: Summary, cardName: string, when: string) =>
  `⚠️ Es un monto alto: ${what(s)} · ${plain(cardName)} · ${when}. ¿Lo registro? Responde *sí* o *no*.`;

export const SOURCE_LABEL: Record<string, string> = SOURCE_LABELS;
export const viaLabel = (sources: string) => [...new Set(sources.split(",").map((x) => SOURCE_LABEL[x.trim()] ?? x.trim()).filter(Boolean))].join(" + ") || "la app";

export const askDuplicate = (existing: { merchant: string; cents: number; when: string; sources: string }) =>
  `Ya hay un gasto igual: ${plain(existing.merchant)} ${money(existing.cents)} (${existing.when}, vía ${viaLabel(existing.sources)}). ¿Es otro? Responde *sí* (lo registro) o *no*.`;

export const retry = (question: string, why?: string) => `${why ?? "No te entendí."} ${question}`;

export function registered(o: { cents: number; merchant: string; card: string; when: string; category: string | null }): string {
  return `✅ Registrado: ${money(o.cents)} · ${plain(o.merchant)} · ${plain(o.card)} · ${o.when} · ${o.category ? `Categoría ${plain(o.category)}` : "Sin categoría"}. Responde *deshacer* si no es correcto.`;
}

export const alreadyRegistered = () => SAME_TWICE;

export function todayList(o: { rows: { merchant: string; cents: number; card: string; time: string }[]; total: number; totalCents: number }): string {
  if (!o.rows.length) return "Hoy todavía no hay gastos registrados.";
  const more = o.total > o.rows.length ? ` (mostrando los últimos ${o.rows.length} de ${o.total})` : "";
  return [`🧾 Hoy llevas ${money(o.totalCents)} en ${o.total} ${o.total === 1 ? "gasto" : "gastos"}${more}:`, ...o.rows.map((r) => `• ${r.time} · ${plain(r.merchant)} ${money(r.cents)} · ${plain(r.card)}`)].join("\n");
}

export function summary(o: { todayCents: number; todayCount: number; monthLabel: string; monthCents: number; monthCount: number; incomeCents: number }): string {
  const pct = o.incomeCents > 0 ? ` · ${Math.round((o.monthCents / o.incomeCents) * 100)}% de tu ingreso` : "";
  return [
    "📊 Resumen",
    `Hoy: ${money(o.todayCents)} (${o.todayCount} ${o.todayCount === 1 ? "gasto" : "gastos"})`,
    `${o.monthLabel}: ${money(o.monthCents)} (${o.monthCount} ${o.monthCount === 1 ? "gasto" : "gastos"})${pct}`,
  ].join("\n");
}

// ---- PDF -----------------------------------------------------------------------------------------------------------------------------

export const PDF_NOT_PDF = "Solo puedo leer archivos PDF 📄. Si es un comprobante o estado de cuenta, mándalo como PDF.";
export const PDF_TOO_BIG = "El PDF pesa demasiado (máximo 12 MB). Súbelo desde la app.";
export const PDF_DOWNLOAD_FAILED = "No pude descargar el archivo. Intenta mandarlo de nuevo.";
export const PDF_INVALID = "Ese archivo no parece un PDF válido. Mándalo de nuevo como PDF.";
export const PDF_EMPTY = "El archivo llegó vacío. Mándalo de nuevo.";
export const PDF_FAILED = "No pude procesar el PDF. Inténtalo de nuevo en un momento o súbelo desde la app.";

const link = (appUrl: string | undefined, id: number) => (appUrl ? `\n${appUrl.replace(/\/+$/, "")}/documentos/${id}` : "");

/** `tx`: el movimiento ya registrado (para mostrar monto y comercio), si lo hay. */
export function pdfReply(r: IntakeResult, o: { appUrl?: string; tx?: { cents: number; merchant: string; card: string } | null } = {}): string {
  const detail = r.detail ? plain(r.detail, 300) : "";
  const title = r.title ? plain(r.title, 160) : "";
  const to = link(o.appUrl, r.documentId);

  if (r.status === "failed") {
    if (/contrase/i.test(r.detail ?? "")) return "🔒 Ese PDF está protegido con contraseña: súbelo desde la app, ahí puedes indicarla.";
    return `No pude leer el PDF${detail ? `: ${detail}` : "."}`;
  }
  if (r.status === "rejected") return `No pude usar este PDF${detail ? `: ${detail}` : "."}`;

  if (r.kind === "statement") {
    const parts = [`📄 Estado de cuenta recibido${title ? `: ${title}` : ""}.`];
    if (detail) parts.push(detail);
    if (r.needsMapping?.length) parts.push(`Hay tarjetas por relacionar en la app: ${r.needsMapping.map((x) => plain(x, 60)).join(", ")}.`);
    const open = r.openFindings ?? 0;
    parts.push(open > 0 ? `Diferencias abiertas: ${open}${r.highFindings ? ` (${r.highFindings} importantes)` : ""}. Revísalas en la app.` : "Sin diferencias abiertas.");
    return parts.join(" ") + to;
  }

  if (r.status === "needs_review") return `📎 Lo recibí pero necesito que lo revises en la app${detail ? `: ${detail}` : "."}${to}`;

  // Comprobante de transferencia procesado
  if (r.registered === "duplicate") return "Esa transferencia ya estaba registrada.";
  if (r.registered === "merged") return `✅ Esa transferencia ya la había registrado el correo del banco; la completé con el comprobante.${to}`;
  if (r.registered === "inserted" || r.txId) {
    const what = o.tx ? `${money(o.tx.cents)} · ${plain(o.tx.merchant)} · ${plain(o.tx.card)}` : title;
    return `✅ Registré la transferencia de ${what}${title && o.tx ? ` (${title})` : ""}. Responde *deshacer* si no es correcto.`;
  }
  return `📎 Recibí el PDF${title ? ` (${title})` : ""}${detail ? `: ${detail}` : "."}${to}`;
}

/** El mismo PDF (misma huella) ya se había procesado: no se repite nada, solo se avisa en qué quedó. */
export function pdfAlready(r: IntakeResult, appUrl?: string): string {
  const to = link(appUrl, r.documentId);
  if (r.status === "processed" && r.kind === "transfer_receipt") return "Ese comprobante ya lo había recibido y la transferencia ya estaba registrada. No dupliqué nada.";
  if (r.kind === "statement") return `Ese estado de cuenta ya lo había recibido. Revisa el resultado en la app.${to}`;
  if (r.status === "needs_review") return `Ese PDF ya lo había recibido y sigue esperando tu revisión en la app.${to}`;
  if (r.status === "rejected") return `Ese PDF ya lo había recibido y no sirve para registrar nada${r.detail ? `: ${plain(r.detail, 300)}` : "."}`;
  return `Ese PDF ya lo había recibido antes.${to}`;
}
