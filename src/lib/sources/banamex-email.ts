/**
 * Parser PURO (sin I/O) de los correos de notificación de Banamex.
 *
 * El cuerpo es entrada NO confiable: solo se aplican regex acotadas sobre campos
 * conocidos; nada del texto se interpreta como instrucción ni se devuelve completo.
 * Todo lo que no se entiende devuelve { kind: "unparsed", reason } (nunca lanza).
 */
import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import { normalizeMerchant } from "@/lib/merchant";
import { TZ } from "@/lib/time";

export const BANAMEX_SENDER = "notificaciones@banamex.com";

const MAX_SKEW_MS = 7 * 86_400_000;

export type CardVariant = "credit" | "additional" | "debit";
export type BankCardRef = { variant: CardVariant; digits: string; product: string };

/**
 * Clave única de tarjeta: producto + bandera de adicional + dígitos.
 * El débito lleva producto "DEBITO", así que nunca choca con un crédito de iguales dígitos.
 */
export function cardKey(c: BankCardRef): string {
  const product = c.product.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${product}|${c.variant === "additional" ? "ADIC" : "TIT"}|${c.digits}`.slice(0, 80);
}

export type ParsedEmailTx = {
  type: "A" | "B" | "C" | "D" | "E";
  kind: "expense" | "card_payment";
  amountCents: number;
  merchantRaw: string;
  merchantNormalized: string;
  occurredAt: Date;
  /** null en domiciliaciones: no pertenecen a una tarjeta (ver accountRef / payeeCardDigits). */
  card: BankCardRef | null;
  /** Últimos dígitos de la "Cuenta de cargo" (domiciliación). Es una referencia, no una tarjeta. */
  accountRef: string | null;
  /** Últimos dígitos de la tarjeta pagada (fila "Referencia establecimiento"), si el comercio es una tarjeta propia. */
  payeeCardDigits: string | null;
  authCode: string | null;
  recurring: boolean;
  notes: string | null;
};

export type ParseResult =
  | { kind: "tx"; tx: ParsedEmailTx }
  | { kind: "ignored"; reason: string }
  | { kind: "unparsed"; reason: string };

export type EmailInput = { subject: string; bodyText: string; receivedAt: Date };
export type ParseOptions = {
  /** Fragmentos de comercio que son tarjetas propias (configurables en la app). */
  ownPayees?: string[];
};

/* ───────────────────────── asuntos ───────────────────────── */

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

type TxType = ParsedEmailTx["type"];
const SUBJECT_TO_TYPE: Record<string, TxType> = {
  "retiro/compra con tarjeta banamex": "A",
  "retiro/compra con tarjeta adicional": "B",
  "retiro/compra con cuenta banamex": "C",
  "cargo a cuenta para pago a establecimiento": "D",
  "deposito a cuenta o tarjeta banamex": "E",
};

/** Asuntos conocidos que NO son gasto (punto F). Coincidencia por prefijo. */
const IGNORED_SUBJECT_PREFIXES = [
  "alta de cuenta",
  "modificacion de cuenta",
  "cambio de preferencias de notificaciones",
  "notificacion de cambio de nip",
  "aviso de modificacion de monto transaccional",
  "confirmacion de modificacion de monto transaccional",
  "superaste tu limite de transaccion",
  "rechazo de cargo a cuenta",
  "contratacion de",
  "creacion de",
  "modificacion de",
  "cuenta micuenta te da la bienvenida",
].map(fold);

/** Asuntos que el Apps Script deja pasar (solo transacciones). */
export const SUPPORTED_SUBJECTS = Object.keys(SUBJECT_TO_TYPE);

export function classifySubject(subject: string): { type: TxType } | { ignored: true } | { unknown: true } {
  const s = fold(subject);
  if (s in SUBJECT_TO_TYPE) return { type: SUBJECT_TO_TYPE[s] };
  if (IGNORED_SUBJECT_PREFIXES.some((p) => s.startsWith(p))) return { ignored: true };
  return { unknown: true };
}

/* ───────────────────────── celdas / etiquetas ───────────────────────── */

const LABELS = [
  "Monto",
  "Establecimiento",
  "Fecha y hora",
  "Estatus",
  "No. Autorización",
  "Operación",
  "Cuenta de cargo",
  "Referencia establecimiento",
  "Referencia 4",
  "Medio",
  "Fecha de corte",
  "Fecha límite de pago",
  "Mínimo a pagar",
];
const LABEL_KEYS = new Set(LABELS.map(fold));
const labelKey = (cell: string) => fold(cell).replace(/[:.]+$/, "").replace(/^no\.? ?autorizacion$/, "no. autorizacion");
const KEY = (l: string) => labelKey(l);

/**
 * Convierte el texto plano en celdas [etiqueta, valor, …] sin depender del layout:
 * separa por saltos de línea, tabuladores y "|"; y si todo viene en una línea,
 * inserta cortes antes de cada etiqueta conocida.
 */
export function toCells(body: string): string[] {
  let text = body.slice(0, 60_000).replace(/\r/g, "\n");
  let cells = text.split(/[\n\t|]+/).map((c) => c.trim()).filter(Boolean);
  if (cells.length < 4) {
    const re = new RegExp(`(${LABELS.map((l) => l.replace(/[.]/g, "\\.").replace(/ /g, "\\s+").replace(/[óo]/g, "[óo]").replace(/[íi]/g, "[íi]")).join("|")})`, "gi");
    text = text.replace(/\s+/g, " ").replace(re, "\n$1\n");
    cells = text.split("\n").map((c) => c.trim()).filter(Boolean);
  }
  return cells;
}

/** Valor de una fila "Etiqueta | valor" (también "Etiqueta valor" en una misma celda). */
export function fieldValue(cells: string[], label: string): string | null {
  const want = KEY(label);
  for (let i = 0; i < cells.length; i++) {
    const k = labelKey(cells[i]);
    if (k === want) {
      // Se salta una etiqueta repetida (p. ej. "…pago a Establecimiento" + "Establecimiento").
      let j = i + 1;
      while (j < cells.length && labelKey(cells[j]) === want) j++;
      const v = cells[j];
      if (v !== undefined && !LABEL_KEYS.has(labelKey(v))) return v;
      continue;
    }
    // "Monto $1,423.58" en la misma celda
    const f = fold(cells[i]);
    if (f.startsWith(want + " ") || f.startsWith(want + ":")) {
      const rest = cells[i].slice(label.length).replace(/^[\s:]+/, "");
      if (rest && !LABEL_KEYS.has(labelKey(rest))) return rest;
    }
  }
  return null;
}

/* ───────────────────────── monto ───────────────────────── */

const OTHER_CURRENCY = /\b(USD|US\$|DLLS?|DLS|EUR|GBP|CAD)\b|US\$|€|£/i;

export function parseMoney(value: string): { cents: number } | { error: string } {
  const head = value.slice(0, 40);
  if (OTHER_CURRENCY.test(head)) return { error: "moneda distinta de MXN" };
  const m = /^\s*(?:MXN\s*)?\$?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|-?\d+(?:\.\d{1,2})?)\s*(?:M\.?\s?N\.?|MXN|MX)?\s*$/i.exec(head);
  if (!m) return { error: "formato de monto no reconocido" };
  try {
    return { cents: parseAmountToCents(m[1]) };
  } catch (e) {
    if (e instanceof MoneyParseError) return { error: e.message };
    throw e;
  }
}

/* ───────────────────────── fecha ───────────────────────── */

const MONTHS: Record<string, number> = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8,
  sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, mer: string | undefined): Date | null {
  if (y < 100) y += 2000;
  const m = mer?.toLowerCase().replace(/[^ap]/g, "");
  // h > 12: se ignora AM/PM (algunos correos traen "20:17 PM"). h ≤ 12: se aplica.
  if (h <= 12 && m) h = m === "p" ? (h === 12 ? 12 : h + 12) : h === 12 ? 0 : h;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  // Rechaza días inexistentes (31 de febrero).
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return zonedToUtc(y, mo, d, h, mi, s);
}

const zoneFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
});
function offsetMs(at: number): number {
  const p = Object.fromEntries(zoneFmt.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}
/** Hora de pared en la zona IANA de la app (America/Mexico_City) → instante UTC. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): Date {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wall - offsetMs(wall);
  guess = wall - offsetMs(guess);
  return new Date(guess);
}

/** Soporta: 2026/10/1 12:44:22 PM · 01 Octubre 2026 / 17:16:59 · 01/10/26 20:17:22 PM */
export function parseDateTime(value: string): Date | null {
  const v = value.slice(0, 60).trim();
  let m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/.exec(v);
  if (m) return build(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0), m[7]);
  m = /^(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3,12})\.?,?\s+(\d{4})\s*[/\-,]?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/.exec(v);
  if (m) {
    const mo = MONTHS[fold(m[2]).slice(0, 3)];
    return mo ? build(+m[3], mo, +m[1], +m[4], +m[5], +(m[6] ?? 0), m[7]) : null;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?\s?[Mm]\.?)?/.exec(v);
  if (m) return build(+m[3], +m[2], +m[1], +m[4], +m[5], +(m[6] ?? 0), m[7]);
  return null;
}

/* ───────────────────────── tarjeta ───────────────────────── */

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

export function parseCardRef(cells: string[], fullText: string): BankCardRef | null {
  const hay = [...cells, fullText.replace(/\s+/g, " ").slice(0, 20_000)];
  for (const h of hay) {
    let m = /([A-ZÁÉÍÓÚÑ]{3,20})\s+BANAMEX\s+Adicional\s*\*{0,3}\s*(\d{3,4})\b/i.exec(h);
    if (m) return { variant: "additional", digits: m[2], product: `${titleCase(m[1])} Banamex` };
    m = /([A-ZÁÉÍÓÚÑ]{3,20})\s+BANAMEX\s*\*{2,3}\s*(\d{3,4})\b/i.exec(h);
    if (m) return { variant: "credit", digits: m[2], product: `${titleCase(m[1])} Banamex` };
    m = /Tarjeta\s+M\.?\s?N\.?\s*\*{2,4}\s*(\d{3,4})\b/i.exec(h);
    if (m) return { variant: "debit", digits: m[1], product: "Débito" };
  }
  return null;
}

/* ───────────────────────── comercio ───────────────────────── */

/** Quita sufijos de ciudad/país que Banamex agrega al nombre del establecimiento. */
export function normalizeBanamexMerchant(raw: string): string {
  let s = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  s = s.replace(/\s+CR\s+.*$/, ""); // "… CR CIUDAD DE MEX001MX"
  s = s.replace(/\s+(CIUDAD DE MEX|CDMX|MEXICO|MEX)[A-Z]*\s*\d*\s*MX$/, "");
  s = s.replace(/\s*\d{3}MX$/, "").replace(/\s+MX$/, "");
  return normalizeMerchant(s);
}

/** Valores iniciales de la tabla own_payees (se administran en Configuración). */
export const DEFAULT_OWN_PAYEES = ["AMERICAN EXPRESS", "AMEX"];

/** ¿El comercio de una domiciliación es una tarjeta mía? Coincidencia por palabras completas. */
export function isOwnCardPayee(merchantNormalized: string, payees: string[] = DEFAULT_OWN_PAYEES): boolean {
  const m = ` ${merchantNormalized} `;
  return payees.some((p) => {
    const n = normalizeMerchant(p);
    return n.length > 0 && m.includes(` ${n} `);
  });
}

/* ───────────────────────── despacho ───────────────────────── */

const unparsed = (reason: string): ParseResult => ({ kind: "unparsed", reason });

export function parseBanamexEmail(input: EmailInput, opts: ParseOptions = {}): ParseResult {
  const cls = classifySubject(input.subject);
  if ("ignored" in cls) return { kind: "ignored", reason: "asunto sin gasto" };
  if ("unknown" in cls) return unparsed("asunto desconocido");

  const cells = toCells(input.bodyText);
  const type = cls.type;

  const status = fieldValue(cells, "Estatus");
  if (status && fold(status).split(" ")[0] !== "exitoso") return { kind: "ignored", reason: "estatus no exitoso" };

  const amountText = fieldValue(cells, "Monto");
  if (!amountText) return unparsed("falta Monto");
  const money = parseMoney(amountText);
  if ("error" in money) return unparsed(`Monto: ${money.error}`);

  const when = fieldValue(cells, "Fecha y hora");
  if (!when) return unparsed("falta Fecha y hora");
  const occurredAt = parseDateTime(when);
  if (!occurredAt) return unparsed("Fecha y hora con formato desconocido");
  if (Math.abs(occurredAt.getTime() - input.receivedAt.getTime()) > MAX_SKEW_MS) return unparsed("fecha incoherente con la de recepción");

  const authRaw = fieldValue(cells, "No. Autorización");
  const authCode = authRaw ? (/^[A-Z0-9]+(?: \d{4,})?/i.exec(authRaw.trim())?.[0] ?? null) : null;
  const authFinal = authCode && authCode.length <= 30 ? authCode.toUpperCase() : null;

  if (type === "D") {
    const merchant = fieldValue(cells, "Establecimiento");
    if (!merchant) return unparsed("falta Establecimiento");
    const acct = fieldValue(cells, "Cuenta de cargo");
    const accountRef = acct ? (/^\W*\*{0,4}\s*(\d{3,20})\b/.exec(acct)?.[1]?.slice(-4) ?? null) : null;
    if (!accountRef) return unparsed("falta Cuenta de cargo");
    const merchantRaw = merchant.slice(0, 200);
    const norm = normalizeBanamexMerchant(merchantRaw);
    if (!norm) return unparsed("Establecimiento vacío");
    const payment = isOwnCardPayee(norm, opts.ownPayees);
    const ref = fieldValue(cells, "Referencia establecimiento");
    const payeeCardDigits = payment && ref ? (/^\W*\*{0,4}\s*(\d{3,20})\b/.exec(ref)?.[1]?.slice(-4) ?? null) : null;
    return {
      kind: "tx",
      tx: {
        type, kind: payment ? "card_payment" : "expense", amountCents: money.cents, merchantRaw, merchantNormalized: norm,
        occurredAt, card: null, accountRef, payeeCardDigits, authCode: authFinal, recurring: !payment, notes: null,
      },
    };
  }

  const card = parseCardRef(cells, input.bodyText);
  if (!card) return unparsed("no se reconoció la tarjeta");

  if (type === "E") {
    // Un depósito a una cuenta de débito no es ni gasto ni pago de tarjeta de crédito.
    if (card.variant === "debit") return { kind: "ignored", reason: "depósito a cuenta de débito" };
    const medio = fieldValue(cells, "Medio");
    const medioSafe = medio && /^[A-Za-z0-9 _-]{1,20}$/.test(medio.trim()) ? medio.trim() : null;
    return {
      kind: "tx",
      tx: {
        type, kind: "card_payment", amountCents: money.cents, merchantRaw: "Pago a tarjeta Banamex", merchantNormalized: "PAGO A TARJETA BANAMEX",
        occurredAt, card, accountRef: null, payeeCardDigits: null, authCode: authFinal, recurring: false, notes: medioSafe ? `Medio: ${medioSafe}` : null,
      },
    };
  }

  const merchant = fieldValue(cells, "Establecimiento");
  if (!merchant) return unparsed("falta Establecimiento");
  const merchantRaw = merchant.slice(0, 200);
  const norm = normalizeBanamexMerchant(merchantRaw);
  if (!norm) return unparsed("Establecimiento vacío");
  return {
    kind: "tx",
    tx: { type, kind: "expense", amountCents: money.cents, merchantRaw, merchantNormalized: norm, occurredAt, card, accountRef: null, payeeCardDigits: null, authCode: authFinal, recurring: false, notes: null },
  };
}
