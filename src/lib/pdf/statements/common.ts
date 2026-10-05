import type { PdfPage, PdfWord } from "../text";

/**
 * Utilidades compartidas por los extractores de estados de cuenta (port de scripts/statements/common.py).
 * Funciones puras (sin I/O): parsear dinero y fechas, marcadores de mensualidad, limpiar comercios y armar el JSON
 * normalizado. Todo el dinero va en centavos enteros y las fechas como "YYYY-MM-DD" (sin Date: nada de zonas horarias).
 * Además trae la capa que adapta los ítems de pdf.js a "palabras" y renglones con el comportamiento de pdfplumber,
 * porque los extractores (portados de Python) se escribieron contra pdfplumber.
 */

// --------------------------------------------------------------------------- texto de pdf.js -> palabras / renglones

// Caracteres invisibles que pdf.js deja pasar y que rompen las expresiones regulares (los espacios raros SÍ se tratan como espacio).
const INVISIBLE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const LIGATURES: Record<string, string> = { "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl" };

/**
 * Texto de un ítem de pdf.js listo para los extractores: sin invisibles ni ligaduras, con los espacios raros (NBSP, finos…)
 * como espacio normal, el signo menos tipográfico (U+2212) y los guiones largos pegados a un importe como "-", y los miles
 * separados con espacio duro ("1 234.56") como "1,234.56".
 */
export const cleanText = (s: string) =>
  s.normalize("NFC").replace(INVISIBLE, "").replace(/[\ufb00-\ufb04]/g, (c) => LIGATURES[c])
    .replace(/(\d)[\u00a0\u2009\u202f](?=\d{3}\.\d{2}(?!\d))/g, "$1,")
    .replace(/\u2212/g, "-")
    .replace(/(^|\s)[\u2012-\u2015\ufe63\uff0d](?=\s?\$)/g, "$1-")
    .replace(/[\s\u00a0]+/g, " ");

/**
 * pdf.js mide `top` con el tamaño de la fuente completo; pdfminer/pdfplumber lo mide sin el descendente (~0.2 del cuerpo).
 * Los umbrales de los extractores se calibraron con pdfplumber, así que se emula ese corrimiento.
 */
const DESCENT = 0.19;
/** Separación máxima (pt) para unir dos ítems contiguos sin espacio entre ellos (el `x_tolerance` de pdfplumber). */
const GLUE_GAP = 3;

/**
 * Palabras al estilo `extract_words` de pdfplumber. Un ítem de pdf.js puede traer varias palabras (se parte por espacios
 * repartiendo x proporcionalmente al número de caracteres) y una palabra puede venir partida en varios ítems pegados:
 * se unen si no hay espacio entre ellos y la separación es ≤ 3 pt. pdf.js inventa espacios sueltos junto a las notas al pie en
 * superíndice ("Intereses" + "8" sale como "Intereses 8", pdfplumber da "Intereses8"): los extractores toleran ese espacio.
 * No depende del orden en que pdf.js entrega los ítems.
 */
export function pageWords(page: PdfPage): PdfWord[] {
  type Tok = PdfWord & { item: number; lead: boolean; trail: boolean };
  const toks: Tok[] = [];
  page.words.forEach((it, idx) => {
    const str = cleanText(it.str);
    if (!str.trim() || it.rot) return; // el texto girado (sellos laterales) no forma parte de las tablas
    const fs = Math.max(0, it.bottom - it.top);
    const shift = fs * DESCENT;
    const width = it.x1 - it.x0;
    const total = str.length || 1;
    for (const m of str.matchAll(/\S+/g)) {
      const a = m.index;
      const b = a + m[0].length;
      toks.push({
        str: m[0], x0: it.x0 + (width * a) / total, x1: it.x0 + (width * b) / total,
        top: it.top + shift, bottom: it.bottom + shift,
        item: idx, lead: str.startsWith(" ") && a === 1, trail: (str.endsWith(" ") && b === str.length - 1) || (!!it.sp && b === str.length),
      });
    }
  });
  const out: PdfWord[] = [];
  for (const line of clusterByTop(toks, 3)) {
    line.sort((a, b) => a.x0 - b.x0);
    let last: Tok | undefined;
    for (const t of line) {
      const prev = out.at(-1);
      const gap = last ? t.x0 - last.x1 : Infinity;
      if (prev && last && last.item !== t.item && !last.trail && !t.lead && gap < GLUE_GAP && gap > -2) {
        prev.str += t.str;
        prev.x1 = Math.max(prev.x1, t.x1);
        prev.top = Math.min(prev.top, t.top);
        prev.bottom = Math.max(prev.bottom, t.bottom);
      } else out.push({ str: t.str, x0: t.x0, x1: t.x1, top: t.top, bottom: t.bottom });
      last = t;
    }
  }
  return out;
}

/** Agrupa por altura encadenando: cada `top` (ordenado) a ≤ tol del anterior cae en el mismo grupo (como `cluster_objects` de pdfplumber). */
function clusterByTop<T extends { top: number }>(items: T[], tol: number): T[][] {
  const sorted = [...items].sort((a, b) => a.top - b.top);
  const groups: T[][] = [];
  let lastTop = -Infinity;
  for (const w of sorted) {
    if (groups.length && w.top <= lastTop + tol) groups.at(-1)!.push(w);
    else groups.push([w]);
    lastTop = w.top;
  }
  return groups;
}

/** Renglones de palabras: igual que `group_lines` de common.py (compara con la PRIMERA palabra del renglón). */
export function wordLines(words: PdfWord[], tol = 2.5): PdfWord[][] {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.x0 - b.x0);
  const lines: PdfWord[][] = [];
  for (const w of sorted) {
    const last = lines.at(-1);
    if (last && Math.abs(last[0].top - w.top) <= tol) last.push(w);
    else lines.push([w]);
  }
  return lines.map((l) => l.sort((a, b) => a.x0 - b.x0));
}

export const joinWords = (ws: PdfWord[]) => ws.map((w) => w.str).join(" ");

/**
 * Renglones de texto como `page.extract_text()` de pdfplumber: se agrupan por altura encadenando (cada `top` a ≤ 3 pt del
 * anterior ordenado), se ordenan por x y se unen con un espacio. Sin renglones vacíos.
 */
export function pageLines(page: PdfPage, tol = 3): string[] {
  return clusterByTop(pageWords(page), tol).map((l) => joinWords(l.sort((a, b) => a.x0 - b.x0)).trim()).filter(Boolean);
}

// --------------------------------------------------------------------------- meses

const MONTH_NAMES: string[][] = [
  ["ene", "enero", "jan", "january"],
  ["feb", "febrero", "february"],
  ["mar", "marzo", "march"],
  ["abr", "abril", "apr", "april"],
  ["may", "mayo"],
  ["jun", "junio", "june"],
  ["jul", "julio", "july"],
  ["ago", "agosto", "aug", "august"],
  ["sep", "sept", "septiembre", "setiembre", "september"],
  ["oct", "octubre", "october"],
  ["nov", "noviembre", "november"],
  ["dic", "diciembre", "dec", "december"],
];
const MONTHS = new Map<string, number>(MONTH_NAMES.flatMap((names, i) => names.map((n) => [n, i + 1] as const)));

/** minúsculas sin acentos. */
export const norm = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();

export const monthNumber = (name: string): number | null => MONTHS.get(norm(name).replace(/^\.+|\.+$/g, "")) ?? null;

// --------------------------------------------------------------------------- dinero

const MONEY_RE = /^([+-])?\$?(\d[\d,]*)(?:\.(\d{1,2}))?$/;

/**
 * Convierte texto de dinero a centavos (con signo si trae + o -). Soporta "$1,487.42", "+$1,487.42", "- $18,890.87",
 * "-$16,050.00" y dígitos separados por espacios como "$ 1 2 5 . 0 0". Sin punto decimal se interpretan pesos.
 * El signo menos tipográfico (U+2212) y los guiones largos (U+2013/2014) valen como "-". Devuelve null si no es dinero.
 */
export function parseMoneyOrNull(s: string): number | null {
  const t = s.replace(/[\s\u00a0]+/g, "").replace(INVISIBLE, "").replace(/[\u2212\u2013\u2014\u2012\ufe63\uff0d]/g, "-");
  const m = MONEY_RE.exec(t);
  if (!m) return null;
  const [, sign, whole, frac] = m;
  const cents = Number(whole.replace(/,/g, "")) * 100 + Number((frac ?? "0").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return sign === "-" ? -cents : cents;
}

export function parseMoney(s: string): number {
  const c = parseMoneyOrNull(s);
  if (c === null) throw new Error(`monto no reconocido: ${JSON.stringify(s)}`);
  return c;
}

export function centsToStr(c: number): string {
  const sign = c < 0 ? "-" : "";
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------- fechas

const RE_DMY_DASH = /^(\d{1,2})-([A-Za-z]{3,4})-(\d{4})$/;
const RE_DMY_SPACE = /^(\d{1,2}) ([A-Za-z]{3,10}) (\d{4})$/;
const RE_D_DE_M = /^(\d{1,2}) ?de ?([A-Za-záéíóú]+)(?: ?de ?(\d{4}))?$/i;
const RE_DM = /^(\d{1,2}) ([A-Za-z]{3,10})$/;
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" si (y, m, d) es una fecha real; null si no (p. ej. 31 de febrero). */
export function mkDate(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Fechas de los estados: "dd-mon-yyyy", "dd MON yyyy", "dd de Mes [de yyyy]" (también pegado: "dd deMes"), "dd Mon"
 * (requiere `year`) e ISO. Si falta el año se usa `year`; si además se da `notAfter` y la fecha resultante lo excede,
 * se resta un año. Devuelve null si no se reconoce (nunca lanza).
 */
export function parseDate(s: string, year?: number | null, notAfter?: string | null): string | null {
  s = s.trim();
  let m = RE_ISO.exec(s);
  if (m) return mkDate(+m[1], +m[2], +m[3]);
  m = RE_DMY_DASH.exec(s) ?? RE_DMY_SPACE.exec(s);
  if (m) {
    const mo = monthNumber(m[2]);
    return mo === null ? null : mkDate(+m[3], mo, +m[1]);
  }
  m = RE_D_DE_M.exec(s);
  if (m) {
    const mo = monthNumber(m[2]);
    if (mo === null) return null;
    const y = m[3] ? +m[3] : year;
    if (y == null) return null;
    const d = mkDate(y, mo, +m[1]);
    return !m[3] && notAfter && d && d > notAfter ? mkDate(y - 1, mo, +m[1]) : d;
  }
  m = RE_DM.exec(s);
  if (m && year != null) {
    const mo = monthNumber(m[2]);
    if (mo === null) return null;
    const d = mkDate(year, mo, +m[1]);
    return notAfter && d && d > notAfter ? mkDate(year - 1, mo, +m[1]) : d;
  }
  return null;
}

const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/** Año de una fecha "dd MON" dentro de un periodo [start, end] (ISO). */
export function inferYear(day: number, month: number, start: string, end: string): number {
  const s = dayNum(start);
  const e = dayNum(end);
  for (const y of [+start.slice(0, 4), +end.slice(0, 4)]) {
    const d = mkDate(y, month, day);
    if (!d) continue;
    const n = dayNum(d);
    if (s - 3 <= n && n <= e + 3) return y;
  }
  return +end.slice(0, 4);
}

/** Suma `n` días a una fecha ISO. */
export const addDaysIso = (iso: string, n: number) => new Date((dayNum(iso) + n) * 86_400_000).toISOString().slice(0, 10);

// --------------------------------------------------------------------------- mensualidades

export type Installment = { n: number; total: number };

const INST_PATTERNS = [
  /\((\d{1,3}):(\d{1,3})\)/, //                        (013:024)
  /\bCARGO\s+(\d{1,2})\s+DE\s*(\d{1,2})\b/i, //       CARGO 05 DE 06 / DE03
  /\b(\d{3}) de (\d{3})\b/i, //                        012 de 024
  /\s+-\s*(\d{1,2})\/(\d{1,2})\b/, //                  - 1/3
  /(?<![\d/])(\d{1,2})\/(\d{1,2})$/, //                1/3 al final
];

/** Busca un marcador de mensualidad. Devuelve [{n,total} | null, texto sin el marcador]. */
export function parseInstallment(text: string): [Installment | null, string] {
  for (const pat of INST_PATTERNS) {
    const m = pat.exec(text);
    if (!m) continue;
    const n = +m[1];
    const total = +m[2];
    if (total < 1 || n > total) continue;
    const cleaned = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.trim();
    return [{ n, total }, cleaned.replace(/\s+/g, " ")];
  }
  return [null, text];
}

// --------------------------------------------------------------------------- comercios

// RFC (o parte de él) al final de la descripción Banamex: [letras 0-4][AAMMDD][2-3 homoclave][MX|EX opcional]
const RFC_RE = /^[A-Z&Ñ]{0,4}\d{6}[A-Z0-9]{2,3}(?:MX|EX)?$/;
const COUNTRY_CODES = new Set(["MX", "NL", "US", "ES", "GB", "DE", "FR", "IE", "CA", "SG", "LU", "AR", "BR", "CL", "CO", "PE"]);
const STATE_CODES = new Set(["VER", "YUC", "CDMX", "DF", "MEX", "NL", "QR", "JAL"]);

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const isLetter = (c: string) => /\p{L}/u.test(c);

/** "K E T E N" -> "KETEN" (corridas de >=3 letras sueltas). */
function collapseSpacedLetters(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (j < tokens.length && [...tokens[j]].length === 1 && isLetter(tokens[j])) j++;
    if (j - i >= 3) {
      out.push(tokens.slice(i, j).join(""));
      i = j;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/**
 * Separa la descripción en [comercio, código_adquirente, rfc]. Quita el RFC final y el código de 2-3 letras mayúsculas que
 * lo precede. Si no hay RFC no se toca nada salvo país/estado final. El texto original debe conservarse en `raw`.
 */
export function splitBanamexRfc(desc: string): [string, string | null, string | null] {
  let toks = words(desc);
  let rfc: string | null = null;
  let acq: string | null = null;
  if (toks.length > 1 && (toks.at(-1) === "MX" || toks.at(-1) === "EX") && RFC_RE.test(toks.at(-2)!)) toks = toks.slice(0, -1);
  if (toks.length && RFC_RE.test(toks.at(-1)!) && /\d/.test(toks.at(-1)!)) {
    rfc = toks.pop()!;
    if (toks.length > 1 && /^[A-Z]{2,3}$/.test(toks.at(-1)!)) acq = toks.pop()!;
  } else if (toks.length > 2 && COUNTRY_CODES.has(toks.at(-1)!)) {
    // sin RFC: 'UBER *EATS AMSTERDAM NL', 'SERV COSTA VERDE VERACRUZ VER MX'
    const cc = toks.pop()!;
    if (cc === "MX") {
      if (toks.length && STATE_CODES.has(toks.at(-1)!)) toks.pop();
    } else if (toks.length > 1) toks.pop(); // ciudad
  }
  return [collapseSpacedLetters(toks).join(" "), acq, rfc];
}

/**
 * Nombre de comercio limpio a partir de una descripción de tarjeta Banamex. `known` es un diccionario opcional
 * {clave_sin_espacios: nombre_limpio} con marcas ya conocidas.
 */
export function cleanBanamexMerchant(desc: string, known?: Record<string, string>): string {
  const [, c0] = parseInstallment(desc);
  const cleaned = c0.replace(/\s+/g, " ").trim();
  if (known) {
    const key = cleaned.toUpperCase().replace(/[^A-Z0-9*]/g, "");
    let best: [string, string] | null = null;
    for (const [k, v] of Object.entries(known)) if (key.startsWith(k) && (!best || k.length > best[0].length)) best = [k, v];
    if (best) return best[1];
  }
  return splitBanamexRfc(cleaned)[0] || cleaned;
}

// Ciudades / estados que Amex pega al final del comercio (frases, de más larga a más corta).
// El PDF trae "Mérida" con un carácter de reemplazo según el lector: se acepta cualquier cosa en la "é" (ver amexCityKey).
const AMEX_CITY_PHRASES = [
  "CIUDAD DE MEX", "SOUTH SAN FRANC", "HTTPS://HELP.UB", "BOCA DEL RIO", "BENITO JUAREZ",
  "MEXICO CITY", "MERIDA YUC", "VERACRUZ VER", "MERIDA", "M?RIDA", "VERACRUZ", "YUCATAN",
  "APODACA", "CONKAL", "CDMX", "MEXICO", "YUC", "VER", "DF", "MX", "KANASIN",
].sort((a, b) => b.length - a.length);

/** Clave de comparación de un tramo final: mayúsculas, sin acentos y con "?"/U+FFFD/É equivalentes a la É de Mérida. */
const amexCityKey = (s: string) => norm(s).toUpperCase().replace(/[?�]/g, "E");

/** "COMERCIO CIUDAD" -> [comercio, ciudad]. Conserva al menos una palabra. */
export function splitAmexCity(text: string): [string, string | null] {
  let work = text.replace(/\s+/g, " ").trim();
  const cityParts: string[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    const up = amexCityKey(work);
    for (const ph of AMEX_CITY_PHRASES) {
      const key = amexCityKey(ph);
      if (up.endsWith(` ${key}`)) {
        cityParts.unshift(work.slice(-ph.length));
        work = work.slice(0, -ph.length).trimEnd();
        changed = true;
        break;
      }
    }
  }
  return [work, cityParts.length ? cityParts.join(" ") : null];
}

// --------------------------------------------------------------------------- JSON normalizado

export const TXN_TYPES = [
  "purchase", "fee", "interest", "payment", "installment", "installment_credit", "transfer_own", "transfer_out", "income",
  "domiciliation_card_payment", "domiciliation_other", "cash_withdrawal", "tax", "refund",
] as const;
export type TxnType = (typeof TXN_TYPES)[number];
export type Foreign = { currency: string; amount: string; fx: string };
export type PlanRef = { merchant: string; original_cents: number } | null;

type TxnBase = {
  date: string | null;
  post_date: string | null;
  time: string | null;
  merchant: string;
  raw: string;
  amount_cents: number;
  type: TxnType;
  holder: string | null;
  section: string;
  installment: Installment | null;
  pending: boolean;
  foreign: Foreign | null;
  note: string | null;
};
/** Los campos propios de cada fuente (rfc, plan_ref, balance_cents…) viajan como extras. */
export type Txn = TxnBase & Record<string, unknown>;

type PlanBase = {
  merchant: string;
  original_cents: number;
  pending_cents: number;
  monthly_cents: number;
  n_current: number;
  n_total: number;
  rate_pct: string;
  with_interest: boolean;
  op_date: string | null;
  kind: "purchase" | "cash_advance" | "auto_msi";
  holder: string | null;
  note: string | null;
};
export type Plan = PlanBase & Record<string, unknown>;

export type Check = { name: string; expected_cents: number; actual_cents: number; ok: boolean; unit?: "count" };

export type RawDoc = {
  document: string;
  card_key: string;
  period: { start: string; end: string } | null;
  as_of: string | null;
  transactions: Txn[];
  plans: Plan[];
  checks: Check[];
  warnings: string[];
} & Record<string, unknown>;

export function makeTxn(
  p: Pick<TxnBase, "date" | "merchant" | "raw" | "amount_cents" | "type"> & Partial<TxnBase> & Record<string, unknown>,
): Txn {
  const { date, merchant, raw, amount_cents, type, post_date = null, time = null, holder = null, section = "regular", installment = null, pending = false, foreign = null, note = null, ...extra } = p;
  return { date, post_date, time, merchant, raw: raw.replace(/\s+/g, " ").trim(), amount_cents, type, holder, section, installment, pending, foreign, note, ...extra };
}

export function makePlan(
  p: Pick<PlanBase, "merchant" | "original_cents" | "pending_cents" | "monthly_cents" | "n_current" | "n_total"> & Partial<PlanBase> & Record<string, unknown>,
): Plan {
  const { merchant, original_cents, pending_cents, monthly_cents, n_current, n_total, rate_pct = "0.00", with_interest = false, op_date = null, kind = "purchase", holder = null, note = null, ...extra } = p;
  return { merchant, original_cents, pending_cents, monthly_cents, n_current, n_total, rate_pct, with_interest, op_date, kind, holder, note, ...extra };
}

/** unit "count" = conteos (los campos *_cents guardan el conteo). */
export function makeCheck(name: string, expected: number, actual: number, tolerance = 0, unit: "cents" | "count" = "cents"): Check {
  const c: Check = { name, expected_cents: expected, actual_cents: actual, ok: Math.abs(expected - actual) <= tolerance };
  if (unit !== "cents") c.unit = unit;
  return c;
}

export function makeDoc(document: string, cardKey: string, period: RawDoc["period"], asOf: string | null, extra: Record<string, unknown> = {}): RawDoc {
  return { document, card_key: cardKey, period, as_of: asOf, transactions: [], plans: [], checks: [], warnings: [], ...extra };
}

export const sumCents = <T extends { amount_cents: number }>(txns: T[], pred: (t: T) => boolean = () => true) =>
  txns.reduce((s, t) => s + (pred(t) ? t.amount_cents : 0), 0);
