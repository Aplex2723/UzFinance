import { MSI_MAX, MSI_MIN } from "@/lib/msi";
import { addDays, daysBetween, isRealDate, ymd } from "./when";
import { endsWithLast4, fold, matchCards, namesCardBefore, type CardLite } from "./cards";

/**
 * Parser DETERMINISTA y puro de un gasto escrito en español ("350 starbucks amex", "ayer 450 oxxo débito", "pagué 2 mil de renta con débito").
 * No consulta nada ni usa un LLM: recibe el texto, la fecha de hoy (CDMX) y las tarjetas elegibles, y devuelve lo que entendió, lo que
 * falta preguntar o por qué se rechaza. Cualquier texto (hostil, larguísimo, con emoji) termina en un resultado, nunca en una excepción.
 */
export const MAX_TEXT = 500;
export const MAX_CENTS = 1_000_000_00;
/** Montos desde aquí piden un "sí" antes de guardarse. */
export const CONFIRM_CENTS = 20_000_00;
export const MAX_DAYS_BACK = 60;
export const MAX_MERCHANT = 120;

export type DateSel = { kind: "today" } | { kind: "date"; ymd: string };

export type Parsed =
  | { kind: "none" }
  | { kind: "reject"; reason: string }
  | {
      kind: "expense";
      /** null si falta o es ambiguo (varios números sin "$", "mil 500", "3 meses", terminación de tarjeta, solo una hora…). */
      amountCents: number | null;
      amountAmbiguous: boolean;
      /** Por qué no se tomó un monto (para preguntar con las palabras correctas); null si el monto quedó claro o simplemente falta. */
      amountNote: AmountNote | null;
      /** El monto leído venía marcado explícitamente ($, pesos, mxn…). */
      amountMarked: boolean;
      merchant: string | null;
      /** Tarjetas candidatas: 1 = inequívoca, varias = preguntar, 0 = ninguna. */
      cardIds: number[];
      unmatchedHint: string | null;
      date: DateSel;
      /** Compra a meses sin intereses ("a 3 msi", "6 meses sin intereses"): número de mensualidades; null si no es a MSI. El monto es el TOTAL. */
      installments: number | null;
    };

/** Motivo por el que un número no se tomó como monto sin preguntar. */
export type AmountNote =
  | { kind: "many" }
  | { kind: "installments" }
  | { kind: "mil"; raw: string }
  | { kind: "last4"; digits: string }
  /** Dos cifras y una podría ser la terminación de una tarjeta: ¿`cents` es el monto, o `ending` es la tarjeta y el monto es `cents`? Se pregunta. */
  | { kind: "either"; ending: string; cents: number }
  /** La única cifra del mensaje era una hora ("oxxo 5pm"): falta el monto. */
  | { kind: "time"; raw: string };

const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Quita caracteres de control/formato (incluye cero-ancho), normaliza y colapsa espacios. */
export function sanitizeInput(raw: string): string {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Span = [number, number];
const claim = (mask: boolean[], [a, b]: Span) => {
  for (let i = a; i < b && i < mask.length; i++) mask[i] = true;
};
const isFree = (mask: boolean[], a: number, b: number) => {
  for (let i = a; i < b; i++) if (mask[i]) return false;
  return true;
};

// ---- Monto ---------------------------------------------------------------------------------------------------------------------------

type NumError = "ambiguous" | "zero" | "negative" | "big" | "mil";
/** `kind`: "installments" = cifra de meses sin intereses (no es monto); "qty" = cantidad o duración ("20 minutos", "3 personas"): no es monto;
 *  "mil" = "mil 500" (¿1,000, 1,500, 500?): se pregunta. */
type Tok = { span: Span; raw: string; cents: number | null; error: NumError | null; marked: boolean; plainInt: string | null; kind?: "installments" | "mil" | "qty"; /** Solo en "installments" que SÍ piden plan a meses: la cifra leída. */ months?: number };

const WORD_NUM: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100 };
const UNIT_GLUED = /^(k|mil|millones|millon|mxn|mn|m\.n\.?|pesos|peso)(?![\p{L}\p{N}])/u;
const UNIT_SPACED = /^\s+(mil|k|millones|millon|mxn|mn|m\.n\.?|pesos|peso|varos|lanas)(?![\p{L}\p{N}])(?!-\p{L})/u;
/** "20 minutos", "3 personas", "2 boletos", "40 litros": una cantidad o una duración, nunca el monto (salvo que lleve "$"). */
const QTY = /^\s*(?:minutos?|mins?|horas?|dias?|semanas?|personas?|piezas?|pzas?|boletos?|litros?|lts?|kilos?|kg|km|veces|articulos?)(?![\p{L}\p{N}])/u;
/** "3 meses (sin intereses)", "6 msi", "12 mensualidades": la cifra son los meses, no el monto. */
const INSTALLMENTS = /^\s*(?:meses|mes|msi|mensualidades|mensualidad)(?:\s+sin\s+intereses)?(?![\p{L}\p{N}])/u;
const MULT: Record<string, number> = { k: 1000, mil: 1000, millon: 1_000_000, millones: 1_000_000 };
const MARKER_UNITS = new Set(["mxn", "mn", "m.n", "m.n.", "pesos", "peso", "varos", "lanas"]);

/** "1,234.50" / "350.5" → centavos × multiplicador. Cualquier otra forma ("1.234,50", "12,50", "1.234") es ambigua: NO se adivina. */
function valueOf(num: string, mult: number): { cents: number } | { error: NumError } {
  const thousands = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(num);
  const plain = /^\d+(\.\d{1,2})?$/.test(num);
  if (!(mult === 1 ? thousands || plain : plain)) return { error: "ambiguous" };
  const [int, frac = ""] = num.replace(/,/g, "").split(".");
  if (int.replace(/^0+/, "").length > 10) return { error: "big" };
  const cents = (Number(int) * 100 + Number(frac.padEnd(2, "0"))) * mult;
  if (cents === 0) return { error: "zero" };
  return cents > MAX_CENTS ? { error: "big" } : { cents };
}

const NUM_RE = /(?<![\p{L}\p{N}_.,])(-?)((?:mx\$|\$)\s*)?(\d[\d.,]*\d|\d)(?![\p{N}])/gu;
const MORE_WORDS = /^\s+(?:y\s+)?(?:un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\w+cientos|quinientos|mil)(?![\p{L}\p{N}])/u;
const WORD_NUM_RE = new RegExp(`(?<![\\p{L}\\p{N}])(${Object.keys(WORD_NUM).join("|")})\\s+mil(?![\\p{L}\\p{N}])`, "gu");

const MIL_RE = new RegExp(`(?<![\\p{L}\\p{N}])mil\\s+(?:y\\s+)?(?:\\d[\\d.,]*|un|uno|ciento|quinientos|\\w+cientos|trece|catorce|${Object.keys(WORD_NUM).join("|")})(?![\\p{L}\\p{N}])`, "gu");

function findNumbers(f: string, original: string, mask: boolean[]): Tok[] {
  const toks: Tok[] = [];
  for (const m of f.matchAll(NUM_RE)) {
    const start = m.index!;
    let end = start + m[0].length;
    if (!isFree(mask, start, end)) continue;
    const negative = m[1] === "-";
    const hasDollar = !!m[2];
    const num = m[3];
    const rest = f.slice(end);
    let mult = 1;
    let marked = hasDollar;
    const inst = INSTALLMENTS.exec(rest);
    if (inst) {
      end += inst[0].length;
      // "msi", "mensualidades" y "meses sin intereses" piden un plan. Un "N meses" a secas solo si lo introduce "a/en/por" ("a 6 meses"):
      // "hace 2 meses" o "dura 3 meses" no son una compra a meses. Sin eso la cifra solo se descarta como monto, como siempre.
      const word = /^\s*(\p{L}+)/u.exec(inst[0])![1];
      const strong = word === "msi" || word.startsWith("mensualidad") || /sin\s+intereses/u.test(inst[0]);
      const intro = /(?:^|\s)(?:a|en|por|a\s+los)\s+(?:los\s+)?$/u.test(f.slice(Math.max(0, start - 10), start)) && !/hace\s+$/u.test(f.slice(Math.max(0, start - 10), start));
      const months = (strong || intro) && /^\d{1,3}$/.test(num) && !hasDollar ? Number(num) : undefined;
      toks.push({ span: [start, end], raw: original.slice(start, end).trim(), cents: null, error: null, marked: false, plainInt: null, kind: "installments", months });
      continue;
    }
    if (!hasDollar && QTY.test(rest)) {
      toks.push({ span: [start, end], raw: original.slice(start, end).trim(), cents: null, error: null, marked: false, plainInt: null, kind: "qty" });
      continue;
    }
    const glued = UNIT_GLUED.exec(rest);
    const spaced = glued ? null : UNIT_SPACED.exec(rest);
    const unit = glued ?? spaced;
    if (unit) {
      const u = unit[1];
      mult = MULT[u] ?? 1;
      if (MARKER_UNITS.has(u)) marked = true;
      end += unit[0].length;
    } else if (/^[\p{L}]/u.test(rest)) {
      continue; // cifra pegada a letras ("7eleven", "3m", "2x1"): no es un monto
    }
    // "2 mil pesos": la unidad de moneda que sigue a "mil"/"k" también cuenta
    if (mult > 1) {
      const cur = /^\s*(mxn|mn|m\.n\.?|pesos|peso)(?![\p{L}\p{N}])/u.exec(f.slice(end));
      if (cur) {
        marked = true;
        end += cur[0].length;
      }
    }
    const v = valueOf(num, mult);
    const error: NumError | null = negative ? "negative" : "error" in v ? v.error : null;
    toks.push({ span: [start, end], raw: original.slice(start, end).trim(), cents: "cents" in v ? v.cents : null, error, marked, plainInt: /^\d+$/.test(num) && !unit && !hasDollar ? num : null });
  }
  for (const m of f.matchAll(WORD_NUM_RE)) {
    const start = m.index!;
    let end = start + m[0].length;
    if (!isFree(mask, start, end) || toks.some((t) => t.span[0] < end && start < t.span[1])) continue;
    const cur = /^\s*(mxn|mn|m\.n\.?|pesos|peso)(?![\p{L}\p{N}])/u.exec(f.slice(end));
    if (cur) end += cur[0].length;
    // "dos mil quinientos…": solo se entienden los miles redondos; lo demás se pregunta, nunca se adivina.
    const more = MORE_WORDS.test(f.slice(end));
    const cents = WORD_NUM[m[1]] * 1000 * 100;
    toks.push({ span: [start, end], raw: original.slice(start, end), cents: more ? null : cents, error: more ? "ambiguous" : null, marked: !!cur, plainInt: null });
  }
  // "mil 500" / "mil quinientos": un "mil" suelto seguido de otra cifra puede ser 1,500 o un error; no se adivina, se pregunta.
  for (const m of f.matchAll(MIL_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!isFree(mask, start, end) || toks.some((t) => t.span[0] <= start && start < t.span[1])) continue; // "2 mil 500": el "mil" ya es unidad
    for (let i = toks.length - 1; i >= 0; i--) if (toks[i].span[0] < end && start < toks[i].span[1]) toks.splice(i, 1);
    toks.push({ span: [start, end], raw: original.slice(start, end), cents: null, error: "mil", marked: false, plainInt: null, kind: "mil" });
  }
  return toks.sort((a, b) => a.span[0] - b.span[0]);
}

export type AmountRead =
  | { kind: "none" }
  | { kind: "ok"; tok: Tok; others: Tok[] }
  | { kind: "ambiguous"; toks: Tok[]; note: AmountNote }
  | { kind: "reject"; reason: string };

const rejectReason = (t: Tok): string => {
  switch (t.error) {
    case "zero":
      return "El monto no puede ser cero.";
    case "negative":
      return "El monto no puede ser negativo. Las devoluciones se registran desde la app.";
    case "big":
      return `Ese monto rebasa el máximo que registro por aquí (${money(MAX_CENTS)}). Si es correcto, regístralo desde la app.`;
    default:
      return `No estoy seguro de cuánto es «${t.raw.slice(0, 30)}» y prefiero no adivinar. Escríbelo así: $1,234.50`;
  }
};

const isLast4Digits = (t: Tok, cards: CardLite[]) =>
  !!t.plainInt && t.plainInt.length >= 3 && t.plainInt.length <= 4 && !t.marked && cards.some((c) => endsWithLast4(c.last4, t.plainInt!));

/**
 * Elige el monto entre los números del texto: el de "$" (o con "pesos/mxn"); si no, el único; si hay varios y ambiguo, null.
 * Una cifra de meses ("3 meses sin intereses") o de cantidad ("20 minutos") nunca es el monto; "mil 500" y una cifra que es la
 * terminación de una tarjeta activa ("oxxo 1234" con una tarjeta ···1234) tampoco se adivinan: se pregunta.
 *
 * Con dos o más cifras, una de 3-4 dígitos que coincide con la terminación de una tarjeta activa se toma como la TARJETA solo si lleva
 * marca (la nombra una tarjeta justo antes: "amex 1005"; las marcas "tarjeta/terminación/···" ya se leyeron antes) o si OTRA cifra va
 * marcada como monto ("$350 oxxo 296"). En cualquier otro caso ("350 oxxo 296", "7 eleven 296", "2 cafes 1234") no se elige: se pregunta,
 * porque equivocarse aquí guarda un monto 40× o 600× distinto sin avisar.
 */
function pickAmount(allToks: Tok[], cards: CardLite[], hints: string[], f = ""): { read: AmountRead; hintTok: Tok | null } {
  if (!allToks.length) return { read: { kind: "none" }, hintTok: null };
  const installments = allToks.filter((t) => t.kind === "installments");
  const toks = allToks.filter((t) => t.kind !== "installments" && t.kind !== "qty");
  if (!toks.length) {
    if (!installments.length) return { read: { kind: "none" }, hintTok: null };
    return { read: { kind: "ambiguous", toks: installments, note: { kind: "installments" } }, hintTok: null };
  }
  let pool = toks;
  let hintTok: Tok | null = null;
  if (pool.length >= 2) {
    const cand = pool.filter((t) => isLast4Digits(t, cards));
    const named = cand.filter((t) => namesCardBefore(f, t.span[0], t.plainInt!, cards));
    const anyMarked = pool.some((t) => t.marked);
    const asEnding = named.length === 1 ? named[0] : cand.length === 1 && pool.some((t) => t !== cand[0] && t.marked) ? cand[0] : null;
    if (asEnding) {
      hintTok = asEnding;
      pool = pool.filter((t) => t !== asEnding);
      hints.push(asEnding.plainInt!);
    } else if (cand.length && !anyMarked) {
      const other = pool.length === 2 ? pool.find((t) => t !== cand[0]) : undefined;
      const note: AmountNote = cand.length === 1 && other && other.cents !== null && !other.error ? { kind: "either", ending: cand[0].plainInt!, cents: other.cents } : { kind: "many" };
      return { read: { kind: "ambiguous", toks: pool, note }, hintTok: null };
    }
  }
  const marked = pool.filter((t) => t.marked);
  const chosen = marked.length === 1 ? marked[0] : marked.length === 0 && pool.length === 1 ? pool[0] : null;
  if (!chosen) return { read: { kind: "ambiguous", toks: pool, note: { kind: "many" } }, hintTok };
  if (chosen.kind === "mil") return { read: { kind: "ambiguous", toks: [chosen], note: { kind: "mil", raw: chosen.raw.slice(0, 30) } }, hintTok };
  if (pool.length === 1 && !hintTok && isLast4Digits(chosen, cards)) return { read: { kind: "ambiguous", toks: [chosen], note: { kind: "last4", digits: chosen.plainInt! } }, hintTok };
  if (chosen.error) return { read: { kind: "reject", reason: rejectReason(chosen) }, hintTok };
  return { read: { kind: "ok", tok: chosen, others: pool.filter((t) => t !== chosen) }, hintTok };
}

// ---- Fecha ---------------------------------------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12, ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sept: 9, sep: 9, oct: 10, nov: 11, dic: 12 };
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const B = "(?<![\\p{L}\\p{N}.,/])";
const A = "(?![\\p{L}\\p{N}/])";
const DATE_RES: { re: RegExp; read: (m: RegExpExecArray) => { d: number; m: number; y: number | null } }[] = [
  { re: new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${A}`, "gu"), read: (m) => ({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }) },
  { re: new RegExp(`${B}(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}|\\d{2})${A}`, "gu"), read: (m) => ({ d: Number(m[1]), m: Number(m[2]), y: m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]) }) },
  { re: new RegExp(`${B}(\\d{1,2})-(\\d{1,2})-(\\d{4}|\\d{2})${A}`, "gu"), read: (m) => ({ d: Number(m[1]), m: Number(m[2]), y: m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]) }) },
  { re: new RegExp(`${B}(\\d{1,2})\\/(\\d{1,2})${A}`, "gu"), read: (m) => ({ d: Number(m[1]), m: Number(m[2]), y: null }) },
  { re: new RegExp(`${B}(\\d{1,2})\\s+de\\s+(${MONTH_NAMES})\\.?(?:\\s+(?:de\\s+)?(20\\d{2}))?(?![\\p{L}\\p{N}])`, "gu"), read: (m) => ({ d: Number(m[1]), m: MONTHS[m[2]], y: m[3] ? Number(m[3]) : null }) },
];
const DATE_WORDS = /(?<![\p{L}\p{N}])(anteayer|antier|antes de ayer|ayer|hoy)(?![\p{L}\p{N}])/gu;
/** Día de la semana (domingo = 0), con el "el/este/pasado" que lo acompaña ("el viernes", "el pasado viernes", "viernes pasado"). No cuenta tras "de"/"santo" ("Casa de Domingo", "Santo Domingo"). */
const WEEKDAYS: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const WEEKDAY_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:el|este)\\s+)?(?:pasado\\s+)?(${Object.keys(WEEKDAYS).join("|")})(?:\\s+pasado)?(?![\\p{L}\\p{N}])`, "gu");

/** La ocurrencia más reciente de ese día de la semana ESTRICTAMENTE antes de hoy (hoy no cuenta): entre 1 y 7 días atrás. */
export function lastWeekday(today: string, weekday: number): string {
  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, -(((todayDow - weekday + 7) % 7) || 7));
}

type DateRead = { kind: "none" } | { kind: "ok"; date: DateSel } | { kind: "reject"; reason: string };

function readDate(f: string, mask: boolean[], today: string): DateRead {
  let found: { d: number; m: number; y: number | null } | null = null;
  let firstAt = Infinity;
  for (const { re, read } of DATE_RES) {
    for (const m of f.matchAll(re)) {
      const a = m.index!;
      const b = a + m[0].length;
      if (!isFree(mask, a, b)) continue;
      claim(mask, [a, b]);
      if (a < firstAt) {
        firstAt = a;
        found = read(m as RegExpExecArray);
      }
    }
  }
  // Palabras de fecha ("ayer", "hoy", "el viernes"): se queda la que aparece primero; todas se quitan del comercio.
  const words: { at: number; sel: DateSel }[] = [];
  for (const m of f.matchAll(DATE_WORDS)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (!isFree(mask, a, b)) continue;
    claim(mask, [a, b]);
    words.push({ at: a, sel: m[1] === "hoy" ? { kind: "today" } : { kind: "date", ymd: addDays(today, m[1] === "ayer" ? -1 : -2) } });
  }
  for (const m of f.matchAll(WEEKDAY_RE)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (!isFree(mask, a, b) || /(?:^|\s)(?:de|del|santo|san)\s+$/u.test(f.slice(Math.max(0, a - 8), a))) continue;
    claim(mask, [a, b]);
    words.push({ at: a, sel: { kind: "date", ymd: lastWeekday(today, WEEKDAYS[m[1]]) } });
  }
  const word = words.sort((x, y) => x.at - y.at)[0]?.sel ?? null;
  if (!found) return word ? { kind: "ok", date: word } : { kind: "none" };

  const bad = { kind: "reject", reason: "No entendí la fecha. Usa día/mes (por ejemplo 3/10) o escribe *ayer*." } as const;
  const [ty] = today.split("-").map(Number);
  const y = found.y;
  let date: string | null = null;
  if (y !== null) {
    if (!isRealDate(y, found.m, found.d)) return bad;
    date = ymd(y, found.m, found.d);
  } else {
    // Sin año: este año; si cae en el futuro y el año pasado queda a ≤60 días, es de diciembre/enero (cambio de año).
    const thisYear = isRealDate(ty, found.m, found.d) ? ymd(ty, found.m, found.d) : null;
    const lastYear = isRealDate(ty - 1, found.m, found.d) ? ymd(ty - 1, found.m, found.d) : null;
    if (thisYear && thisYear <= today) date = thisYear;
    else if (lastYear && daysBetween(lastYear, today) <= MAX_DAYS_BACK) date = lastYear;
    else if (thisYear) date = thisYear; // futuro
    else if (lastYear) date = lastYear;
    else return bad;
  }
  if (date > today) return { kind: "reject", reason: "Esa fecha todavía no llega: solo registro gastos de hoy o de días pasados." };
  if (daysBetween(date, today) > MAX_DAYS_BACK) return { kind: "reject", reason: `Ese gasto es de hace más de ${MAX_DAYS_BACK} días: regístralo desde la app.` };
  return { kind: "ok", date: date === today ? { kind: "today" } : { kind: "date", ymd: date } };
}

// ---- Horas ---------------------------------------------------------------------------------------------------------------------------

/** "5pm", "5 pm", "5:30", "17:30", "17 h", "17 hrs", "a las 5", "a las 5 de la tarde": una hora, no un monto ni parte del comercio. */
const TIME_RES = [
  /(?<![\p{L}\p{N}.,:])a\s+las?\s+\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.|hrs?|h))?(?![\p{L}\p{N}:])(?:\s+de\s+la\s+(?:manana|tarde|noche|madrugada))?/gu,
  /(?<![\p{L}\p{N}.,:])\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:am|pm|a\.m\.|p\.m\.|hrs?|h))?(?![\p{L}\p{N}:])/gu,
  /(?<![\p{L}\p{N}.,:])\d{1,2}\s*(?:am|pm|a\.m\.|p\.m\.)(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}.,:$])\d{1,2}\s*(?:hrs?|h)(?![\p{L}\p{N}])/gu,
];
/** Marca las horas del texto como usadas y devuelve la primera tal como se escribió. */
function readTimes(f: string, original: string, mask: boolean[]): string[] {
  const found: { at: number; raw: string }[] = [];
  for (const re of TIME_RES) {
    for (const m of f.matchAll(re)) {
      const a = m.index!;
      const b = a + m[0].length;
      if (!isFree(mask, a, b)) continue;
      claim(mask, [a, b]);
      found.push({ at: a, raw: original.slice(a, b).trim() });
    }
  }
  return found.sort((x, y) => x.at - y.at).map((x) => x.raw);
}

// ---- Terminaciones de tarjeta, moneda y devoluciones ---------------------------------------------------------------------------------

const ENDING_RES = [
  new RegExp(`(?<![\\p{L}\\p{N}])(?:terminacion|terminada|terminado|termina|term|tarjeta|tarj|tdc|tdd|card|ultimos|ult|digitos|final|finaliza)(?:\\s+(?:en|con|de|los|las|digitos|numeros?))*\\s*[*·•∙⋅.#x-]*\\s*(\\d{3,4})(?![\\p{L}\\p{N}])`, "gu"),
  /(?<![\p{N}])[*·•∙⋅]+\s*(\d{3,4})(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])(?:x{2,}|\.{2,})\s*(\d{3,4})(?![\p{L}\p{N}])/gu,
];
function readEndings(f: string, mask: boolean[]): string[] {
  const hints: string[] = [];
  for (const re of ENDING_RES) {
    for (const m of f.matchAll(re)) {
      const a = m.index!;
      const b = a + m[0].length;
      if (!isFree(mask, a, b)) continue;
      claim(mask, [a, b]);
      hints.push(m[1]);
    }
  }
  return hints;
}

/**
 * Otra moneda: cifra pegada a la moneda ("99 usd", "$99 us", "€50"), moneda antes de la cifra ("usd 50"), o palabras que SOLO son moneda aunque
 * no haya cifra al lado ("99 pesos de netflix en dólares", "usd"). "euro" o "dollar" sueltos pueden ser un comercio ("Euro Taco", "Dollar City").
 */
const FOREIGN = new RegExp(
  [
    String.raw`\d\s*(?:usd|dolar(?:es)?|dlls?|dls|euros?|eur|gbp|us)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?:usd|us\$|eur|gbp|dolares?|dlls?|euros?)\s*\$?\s*\d`,
    String.raw`(?<![\p{L}\p{N}])(?:usd|us\$|dolares|dollars|dlls|dls)(?![\p{L}\p{N}])`,
    String.raw`(?<![\p{L}\p{N}])(?:en|de|a)\s+(?:euros?|eur|gbp|libras(?:\s+esterlinas)?)(?![\p{L}\p{N}])`,
    String.raw`[€£]\s*\d`,
    String.raw`\d\s*[€£]`,
  ].join("|"),
  "u",
);
const REFUND = /(?<![\p{L}\p{N}])(?:devoluc\w*|devolv\w*|reembols\w*|rembols\w*|reintegr\w*|bonificac\w*|contracargo\w*|me regresaron|me devolvieron)/u;

// ---- Comercio ------------------------------------------------------------------------------------------------------------------------

const LEAD_FILLERS = new Set(["gaste", "gastamos", "gasto", "gastos", "pague", "pagamos", "pago", "pagos", "compre", "compramos", "compra", "compras", "cargo", "cargaron", "cobraron", "cobro", "registra", "registrar", "anota", "anotar", "apunta", "agrega", "agregar", "en", "con", "de", "del", "por", "para", "a", "al", "fue", "fueron", "que", "y", "e", "me", "se", "le", "lo", "usando", "uso", "tarjeta", "tdc", "tdd", "pesos", "peso", "mxn", "mn", "varos", "lanas", "mil", "hoy", "ayer", "unos", "unas", "un", "una", "uno", "total", "monto", "importe", "gaste en", "pague en"]);
const ARTICLES = new Set(["la", "el", "los", "las", "mi", "mis", "un", "una", "unos", "unas", "su", "tu"]);
const CONNECTORS = new Set(["de", "del", "la", "el", "los", "las", "y", "en", "con", "a", "al", "e"]);

/** Solo texto plano: letras, números y puntuación común. Todo lo demás (comillas raras, <>, *, _, `, |, \, ;) se vuelve espacio. */
const PLAIN = /[^\p{L}\p{N}\s&'.,\-+#@/:()!%$¿?¡]/gu;

function cleanMerchant(text: string, mask: boolean[]): string | null {
  let buf = ""; // por unidades UTF-16, igual que la máscara
  for (let i = 0; i < text.length; i++) buf += mask[i] ? " " : text[i];
  let words = buf.split(/\s+/).map((w) => w.replace(/^[\s.,;:!¡¿?"'()\-–—_*~`|/\\]+|[\s,;:!¡?"()\-–—_*~`|/\\]+$/gu, "")).filter(Boolean);
  const fw = (w: string) => fold(w).replace(/[^\p{L}\p{N}]/gu, "");
  // Muletillas solo en los extremos ("Casa de Toño" conserva su "de"); un artículo solo se quita en minúscula y detrás de otra muletilla ("en la gasolinera"; "El Globo" se queda).
  let i = 0;
  let sawLead = false;
  while (i < words.length) {
    const w = fw(words[i]);
    if (LEAD_FILLERS.has(w)) sawLead = true;
    else if (ARTICLES.has(w) && sawLead && words[i] === words[i].toLowerCase()) {
      /* artículo tras muletilla */
    } else break;
    i++;
  }
  words = words.slice(i);
  let j = words.length;
  while (j > 0) {
    const w = fw(words[j - 1]);
    if (LEAD_FILLERS.has(w) || ARTICLES.has(w)) j--;
    else break;
  }
  words = words.slice(0, j);
  let out = words.join(" ").replace(PLAIN, " ").replace(/\s+/g, " ").trim();
  out = out.replace(/^[\s.,;:!¡¿?\-+#@/:()%$]+|[\s,;:!¡¿?\-+#@/:(%$]+$/gu, "").trim();
  if (out.length > MAX_MERCHANT) out = out.slice(0, MAX_MERCHANT).replace(/\s+\S*$/, "").trim() || out.slice(0, MAX_MERCHANT);
  if (!/[\p{L}\p{N}]/u.test(out)) return null;
  return titleCase(out);
}

/** Mayúscula inicial a las palabras escritas todo en minúscula; conserva siglas y mezclas ("OXXO", "iPhone"). */
function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w, i) => {
      if (!w || w !== w.toLowerCase()) return w;
      if (i > 0 && CONNECTORS.has(fold(w))) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

// ---- Punto de entrada ----------------------------------------------------------------------------------------------------------------

export type ParseCtx = { todayYmd: string; cards: CardLite[] };

/** Verbos de gasto: con uno de estos el mensaje es un gasto aunque sea largo. */
const SPEND_VERB = /(?<![\p{L}\p{N}])(?:gaste|gastamos|gasto|pague|pagamos|pago|compre|compramos|cobraron|cobro|cargaron|cargo|registra|anota|apunta)(?![\p{L}\p{N}])/u;
/** Frases de conversación (citas, avisos, préstamos entre personas): una cifra suelta ahí NO es un gasto ("nos vemos a las 8", "te mando 200"). */
const CHAT_PHRASE = /(?<![\p{L}\p{N}])(?:quedamos|quedo en|nos vemos|te veo|nos juntamos|hablamos|te llamo|llego|llegamos|llegare|salgo|salimos|te mando|te paso|te debo|me debes|te presto|te pago|te transfiero|te deposito|te envio)(?![\p{L}\p{N}])/u;
/** Más de estas palabras sin "$" ni verbo de gasto ni tarjeta, parece una conversación y no se adivina un gasto. */
const MAX_PLAIN_WORDS = 8;

export function parseExpense(raw: string, ctx: ParseCtx): Parsed {
  const text = sanitizeInput(raw);
  if (!text) return { kind: "none" };
  if (text.length > MAX_TEXT) return { kind: "reject", reason: `Tu mensaje es muy largo (máximo ${MAX_TEXT} letras). Mándame algo corto, por ejemplo: 350 starbucks amex` };
  const f = fold(text);
  const mask: boolean[] = new Array(text.length).fill(false);

  if (REFUND.test(f)) return { kind: "reject", reason: "Las devoluciones y reembolsos no los registro por aquí: usa la app." };
  if (FOREIGN.test(f)) return { kind: "reject", reason: "Por ahora solo registro gastos en pesos mexicanos (MXN). Si fue en otra moneda, regístralo desde la app." };

  const hints = readEndings(f, mask);
  const date = readDate(f, mask, ctx.todayYmd);
  if (date.kind === "reject") return date;
  const times = readTimes(f, text, mask);

  const toks = findNumbers(f, text, mask);
  const { read, hintTok } = pickAmount(toks, ctx.cards, hints, f);
  if (read.kind === "reject") return read;
  if (read.kind === "none" && !times.length) return { kind: "none" };

  const planned = toks.filter((t) => t.kind === "installments" && t.months !== undefined);
  let installments: number | null = null;
  if (planned.length) {
    if (new Set(planned.map((t) => t.months)).size > 1) return { kind: "reject", reason: "Veo más de una cifra de meses. Escribe una sola, por ejemplo: 3820 amex beatriz a 3 msi" };
    installments = planned[0].months!;
    if (installments < MSI_MIN || installments > MSI_MAX) return { kind: "reject", reason: `Las compras a meses sin intereses son de ${MSI_MIN} a ${MSI_MAX} mensualidades. Si no es a MSI, quita esa parte del mensaje.` };
  }

  const marked = toks.some((t) => t.marked);

  if (hintTok) claim(mask, hintTok.span);
  for (const t of toks) if (t.kind === "installments") claim(mask, t.span);
  let amountCents: number | null = null;
  let note: AmountNote | null = null;
  if (read.kind === "ok") {
    amountCents = read.tok.cents;
    claim(mask, read.tok.span);
  } else if (read.kind === "ambiguous") {
    note = read.note;
    for (const t of read.toks) claim(mask, t.span);
  } else {
    // La única cifra era una hora ("oxxo 5pm"): no es el monto; si no es plática, se pregunta cuánto fue.
    note = { kind: "time", raw: times[0].slice(0, 30) };
  }

  const match = matchCards(f, mask, ctx.cards, hints);
  // ¿Parece conversación? Sin monto marcado ($, pesos, mxn): una frase de plática, o un texto largo sin verbo de gasto ni tarjeta, no se toma como gasto.
  const longTalk = text.split(/\s+/).length > MAX_PLAIN_WORDS && !SPEND_VERB.test(f) && !match.ids.length && !hints.length;
  if (!marked && (CHAT_PHRASE.test(f) || longTalk)) return { kind: "none" };
  for (const s of match.spans) claim(mask, s);
  const merchant = cleanMerchant(text, mask);
  if (read.kind === "none" && !merchant) return { kind: "none" }; // solo una hora y nada más ("5pm", "a las 8"): no hay gasto que preguntar

  return {
    kind: "expense",
    amountCents,
    amountAmbiguous: note !== null,
    amountNote: note,
    amountMarked: read.kind === "ok" && read.tok.marked,
    merchant,
    cardIds: match.ids,
    unmatchedHint: match.unmatchedHint,
    date: date.kind === "ok" ? date.date : { kind: "today" },
    installments,
  };
}

// ---- Respuestas a una pregunta pendiente ---------------------------------------------------------------------------------------------

/** Respuesta a "¿Cuánto fue?": exactamente un monto válido. */
export function parseAmountAnswer(raw: string): { cents: number } | { error: string } {
  const text = sanitizeInput(raw);
  if (!text || text.length > 60) return { error: "Escribe solo el monto, por ejemplo $350.50" };
  const f = fold(text);
  if (FOREIGN.test(f)) return { error: "Por ahora solo registro pesos mexicanos (MXN)." };
  const mask: boolean[] = new Array(text.length).fill(false);
  readTimes(f, text, mask);
  const { read } = pickAmount(findNumbers(f, text, mask), [], []);
  if (read.kind === "ok") return { cents: read.tok.cents! };
  if (read.kind === "reject") return { error: read.reason };
  return { error: "No encontré un monto claro. Escribe solo el monto, por ejemplo $350.50" };
}

/** Respuesta a "¿En qué comercio?". */
export function parseMerchantAnswer(raw: string): string | null {
  const text = sanitizeInput(raw);
  if (!text || text.length > MAX_TEXT) return null;
  return cleanMerchant(text, new Array(text.length).fill(false));
}

const norm = (raw: string) => fold(sanitizeInput(raw)).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const YES = new Set(["si", "sip", "sii", "siii", "ok", "okay", "okey", "oka", "correcto", "dale", "va", "vale", "confirmo", "confirmado", "claro", "simon", "afirmativo", "yes", "exacto", "adelante"]);
const YES_TAIL = new Set(["es", "otro", "otra", "correcto", "confirmo", "gracias", "por", "favor", "guardalo", "guarda", "registralo", "registra", "claro", "de", "una", "vez", "fue"]);
const NO = new Set(["no", "nel", "nop", "nope", "negativo", "cancelar", "cancela", "cancelalo"]);
// Ojo: "es" y "otro" NO van aquí: "no es otro" y "no, es otro" se resuelven aparte (ver parseYesNo), no como un "no" cualquiera.
const NO_TAIL = new Set(["gracias", "no", "por", "favor", "lo", "la", "guardes", "registres", "cancelar", "cancela", "mismo", "igual", "ya", "estaba"]);
/** Frases completas que, a la pregunta "¿es otro?", significan que NO es otro. */
const NO_PHRASES = new Set(["es el mismo", "el mismo", "mismo", "es igual", "igual", "ya estaba", "ya esta"]);
const ANOTHER = new Set(["otro", "otra"]);
/** Lo que puede acompañar a un "no," seguido de coma para decir "no (no es duplicado), es otro". */
const COMMA_TAIL = new Set(["es", "fue", "otro", "otra", "gracias", "por", "favor", "de", "una", "vez"]);

/**
 * "sí"/"ok"/"correcto"… → yes; "no"/"nel"/"cancelar" → no; cualquier otra cosa → null (se repregunta).
 * A la pregunta "¿es otro?" se contesta con criterio explícito, sin adivinar:
 *   "es otro" / "sí es otro"            → yes
 *   "no, es otro" (con coma)            → yes  (el "no" niega que sea duplicado)
 *   "no es otro" (sin coma)             → no
 *   "es el mismo" / "ya estaba"         → no
 *   "no es el mismo", "no es", "no otro" → null: contradictorio o incompleto, se repregunta.
 */
export function parseYesNo(raw: string): "yes" | "no" | null {
  const t = sanitizeInput(raw);
  if (/^(👍|👌|✅)[\p{Emoji_Modifier}️]*$/u.test(t)) return "yes";
  if (/^(👎|❌|🚫)[\p{Emoji_Modifier}️]*$/u.test(t)) return "no";
  const w = norm(raw).split(" ").filter(Boolean);
  if (!w.length || w.length > 4) return null;
  if (NO_PHRASES.has(w.join(" "))) return "no";
  // "no, es otro": la coma justo después del "no" lo separa de "no es otro".
  if (w[0] === "no" && /^[¡¿\s]*no\s*[,;:–—-]/iu.test(fold(t)) && w.slice(1).every((x) => COMMA_TAIL.has(x)) && w.slice(1).some((x) => ANOTHER.has(x))) return "yes";
  if (ANOTHER.has(w[w.length - 1]) && (w.length === 1 || (w.length === 2 && (w[0] === "es" || w[0] === "fue")))) return "yes";
  if (w[0] === "no" && w.length === 3 && w[1] === "es" && ANOTHER.has(w[2])) return "no";
  if (YES.has(w[0]) && w.slice(1).every((x) => YES_TAIL.has(x))) return "yes";
  if (NO.has(w[0]) && w.slice(1).every((x) => NO_TAIL.has(x))) return "no";
  return null;
}

/** Terminación de tarjeta escrita como tal ("terminación 1234", "···296", "tarjeta 046"); null si el texto no es una terminación. */
export function parseEndingAnswer(raw: string): string | null {
  const text = sanitizeInput(raw);
  if (!text || text.length > 80) return null;
  return readEndings(fold(text), new Array(text.length).fill(false))[0] ?? null;
}

export type Command = "help" | "cards" | "undo" | "cancel" | "summary" | "today";
const COMMANDS: Record<string, Command> = {
  ayuda: "help", help: "help", hola: "help", holi: "help", buenas: "help", "buenos dias": "help", "buenas tardes": "help", "buenas noches": "help", menu: "help", inicio: "help", comandos: "help", start: "help",
  tarjetas: "cards", "mis tarjetas": "cards",
  deshacer: "undo", deshaz: "undo", undo: "undo", "deshacer ultimo": "undo", "deshacer el ultimo": "undo",
  cancelar: "cancel", cancela: "cancel",
  resumen: "summary", "mi resumen": "summary", "resumen del mes": "summary",
  hoy: "today", "gastos de hoy": "today", "gastos hoy": "today",
};
export const commandOf = (raw: string): Command | null => COMMANDS[norm(raw)] ?? (sanitizeInput(raw) === "?" ? "help" : null);

/** Número de la lista (1-based) si el texto es solo un entero ("2", "2.", "#2"); NaN si no lo es. */
export function parseChoice(raw: string): number {
  const m = /^#?\s*(\d{1,3})\s*[.)]?$/.exec(sanitizeInput(raw));
  return m ? Number(m[1]) : NaN;
}
