import { parseAmountToCents } from "@/lib/money";
import { parseDateTime } from "@/lib/sources/banamex-email";
import { localDate } from "@/lib/time";

/**
 * Parser PURO del "Comprobante de transferencia" que genera la app de Banamex (PDF cuyo texto es imagen → llega por OCR).
 * El texto es entrada NO confiable y viene con ruido de OCR: solo regex acotadas sobre etiquetas conocidas; lo que no cuadra
 * se rechaza o se manda a revisión, nunca se adivina. Nada del texto se interpreta como instrucción.
 */
export type ParsedTransfer = {
  template: "banamex_app";
  amountCents: number;
  /** "Fecha y hora" del comprobante (hora de pared de Ciudad de México). */
  occurredAt: Date;
  originLabel: string;
  /** Últimos dígitos de la cuenta de origen (el comprobante solo imprime 3). */
  originTail: string;
  /** Alias con el que el usuario guardó al beneficiario. */
  destAlias: string | null;
  destTail: string | null;
  destBank: string | null;
  destName: string | null;
  concept: string | null;
  reference: string | null;
  /** Clave de rastreo SPEI; en una transferencia entre cuentas Banamex (sin rastreo) es una clave derivada, ver `derivedKey`. */
  trackingKey: string;
  authCode: string | null;
  accountType: string | null;
};

export type TransferParse =
  | { kind: "ok"; transfer: ParsedTransfer }
  /** Es un comprobante, pero la operación no se concretó (rechazada, programada…): no se registra. */
  | { kind: "rejected"; reason: string }
  /** Parece un comprobante pero faltan o no se entienden datos críticos. */
  | { kind: "unparsed"; reason: string }
  /** No es este formato. */
  | { kind: "other" };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Líneas limpias: sin NBSP ni controles, espacios colapsados, sin renglones vacíos. */
export function toLines(text: string): string[] {
  return text
    .slice(0, 40_000)
    .replace(/ /g, " ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 400);
}

/** Valor de un campo: lo que sigue a la etiqueta en la misma línea o, si no hay nada, la línea siguiente. */
function field(lines: string[], label: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(fold(lines[i]));
    if (!m) continue;
    // El índice de fold() coincide con el original porque NFD+quitar marcas conserva la longitud de las letras base.
    const rest = lines[i].slice(m.index + m[0].length).replace(/^[\s:]+/, "").trim();
    if (rest) return rest;
    const next = lines[i + 1];
    if (next) return next;
  }
  return null;
}

/** Confusiones típicas del OCR solo cuando el valor es casi todo dígitos (O→0, I/l/|→1). */
export function fixDigits(raw: string): string {
  const s = raw.replace(/[\s.-]/g, "");
  return /^[0-9OoIl|]+$/.test(s) && /\d/.test(s) ? s.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1") : s;
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})\s*(MXN|USD|EUR)?/gi;

function parseAmount(text: string): { cents: number } | { error: string } {
  const found = new Set<number>();
  let currency = "MXN";
  for (const m of text.matchAll(MONEY)) {
    try {
      found.add(parseAmountToCents(m[1]));
    } catch {
      return { error: "monto fuera de rango" };
    }
    if (m[2] && m[2].toUpperCase() !== "MXN") currency = m[2].toUpperCase();
  }
  if (currency !== "MXN") return { error: `moneda ${currency}` };
  if (found.size === 0) return { error: "no se encontró el monto" };
  // Un comprobante trae UN monto. Dos distintos = lectura ambigua: mejor revisión humana.
  if (found.size > 1) return { error: "hay más de un monto distinto" };
  return { cents: [...found][0] };
}

/** "Etiqueta **283" → { label, tail }. */
function accountLine(line: string | null): { label: string; tail: string } | null {
  if (!line) return null;
  const m = /^(.*?)\s*\*{1,4}\s*(\d{3,4})\b/.exec(line);
  if (!m) return null;
  return { label: m[1].trim(), tail: m[2] };
}

/** El avatar del beneficiario es una letra en un cuadro de color y el OCR la antepone: "E Empor Cristhian" → "Empor Cristhian". */
const stripAvatar = (s: string) => {
  const m = /^([A-Za-zÁÉÍÓÚÑ])\s+(\S.*)$/.exec(s);
  return m && fold(m[2]).startsWith(fold(m[1])) ? m[2] : s;
};

/** Conceptos que el banco pone por omisión: no dicen de qué trata la operación. */
export function isGenericConcept(concept: string | null | undefined): boolean {
  if (!concept) return true;
  const c = fold(concept).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  return !c || /^(transferencia( interbancaria| spei| a terceros| entre cuentas| propia)?|pago( de servicios)?|traspaso|spei|varios|sin concepto|n a|ninguno)$/.test(c);
}

/** Prefijo de la clave derivada de una transferencia entre cuentas Banamex, que no trae clave de rastreo sino solo número de autorización. */
export const DERIVED_KEY_PREFIX = "AUT";
export const isDerivedKey = (key: string) => key.startsWith(DERIVED_KEY_PREFIX);
/** AUT + autorización + fecha local (YYYYMMDD): identifica la operación igual que el rastreo, y cabe en las 8–30 letras/números de la columna. */
const derivedKey = (authCode: string, at: Date) => `${DERIVED_KEY_PREFIX}${authCode}${localDate(at).replace(/-/g, "")}`;

export function parseBanamexTransfer(text: string): TransferParse {
  const lines = toLines(text);
  const all = fold(lines.join("\n"));
  if (!/comprobante de transferencia/.test(all) || !/banamex/.test(all)) return { kind: "other" };

  const status = /transferencia\s+(exitosa|rechazada|fallida|programada|pendiente|cancelada)/.exec(all)?.[1];
  if (!status) return { kind: "unparsed", reason: "no se ve el estatus de la transferencia" };
  if (status !== "exitosa") return { kind: "rejected", reason: `la transferencia está ${status}` };

  const amount = parseAmount(lines.join("\n"));
  if ("error" in amount) return { kind: "unparsed", reason: `monto: ${amount.error}` };

  const iOrigin = lines.findIndex((l) => /^cuenta origen/i.test(fold(l)));
  const iDest = lines.findIndex((l) => /^cuenta destino/i.test(fold(l)));
  if (iDest < 0) return { kind: "unparsed", reason: "faltan las cuentas de origen o destino" };
  // El OCR a veces pierde la etiqueta "Cuenta origen": la cuenta de origen es entonces la línea con ** que precede a "Cuenta destino".
  // Entre la etiqueta y la cuenta puede colarse texto suelto de la miniatura de la tarjeta ("# Banamex"): se toma la primera línea con **.
  const originLine =
    iOrigin >= 0 && iOrigin < iDest
      ? lines.slice(iOrigin + 1, iDest).find((l) => accountLine(l))
      : [...lines.slice(0, iDest)].reverse().find((l) => accountLine(l));
  const origin = accountLine(originLine ?? null);
  if (!origin) return { kind: "unparsed", reason: "no se leyó la cuenta de origen" };
  // La inicial del beneficiario (avatar) puede venir antes del nombre, en la misma línea ("E Empor Cristhian") o sola en la anterior ("J").
  const iDestLine = lines[iDest + 1] && /^\S$/.test(lines[iDest + 1]) ? iDest + 2 : iDest + 1;
  const destLine = lines[iDestLine] ? stripAvatar(lines[iDestLine]) : null;
  const dest = accountLine(destLine);
  const bankName = lines[iDestLine + 1] && !/^datos de la transferencia/i.test(fold(lines[iDestLine + 1])) ? lines[iDestLine + 1] : null;
  let destBank: string | null = null;
  let destName: string | null = null;
  if (bankName) {
    const parts = bankName.split(/\s[·•.:;|\-–]\s/);
    destBank = parts.length > 1 ? parts[0].trim().slice(0, 60) : null;
    destName = (parts.length > 1 ? parts.slice(1).join(" - ") : bankName).replace(/\s*\*+\s*$/, "").trim().slice(0, 120) || null;
  }

  const authRaw = field(lines, /numero de autorizacion/);
  const auth = authRaw ? fixDigits(authRaw) : null;
  const authCode = auth && /^\d{3,12}$/.test(auth) ? auth : null;

  const whenRaw = field(lines, /fecha y hora/);
  const occurredAt = whenRaw ? parseDateTime(whenRaw) : null;
  if (!occurredAt) return { kind: "unparsed", reason: "fecha y hora ilegibles" };

  // Una transferencia SPEI trae clave de rastreo. Entre cuentas Banamex el comprobante no la imprime (solo el número de autorización):
  // si la etiqueta NO existe se identifica por autorización + fecha. Si la etiqueta existe pero no se lee, se pide revisión.
  const tracking = field(lines, /clave de rastreo/);
  let trackingKey = tracking ? fixDigits(tracking.split(/\s{2,}/)[0]).replace(/[^A-Za-z0-9]/g, "").toUpperCase() : "";
  if (tracking === null && authCode) trackingKey = derivedKey(authCode, occurredAt);
  if (!/^[A-Z0-9]{8,30}$/.test(trackingKey)) return { kind: "unparsed", reason: tracking === null ? "no se encontró la clave de rastreo ni el número de autorización" : "clave de rastreo ilegible" };

  const conceptRaw = field(lines, /^concepto/);
  const concept = conceptRaw && !/^referencia/i.test(fold(conceptRaw)) ? conceptRaw.slice(0, 120) : null;
  const refRaw = field(lines, /referencia numerica/);
  const reference = refRaw && /^[0-9OoIl|]{1,12}$/.test(refRaw.replace(/\s/g, "")) ? fixDigits(refRaw) : null;
  const accountType = field(lines, /^tipo de cuenta/)?.slice(0, 30) ?? null;

  return {
    kind: "ok",
    transfer: {
      template: "banamex_app",
      amountCents: amount.cents,
      occurredAt,
      originLabel: origin.label.slice(0, 60),
      originTail: origin.tail,
      destAlias: dest?.label ? dest.label.slice(0, 80) : null,
      destTail: dest?.tail ?? null,
      destBank,
      destName,
      concept,
      reference,
      trackingKey,
      authCode,
      accountType,
    },
  };
}

/** Campos críticos que dos lecturas del mismo PDF deben compartir. Devuelve los que NO coinciden. */
export function transferConflicts(a: ParsedTransfer, b: ParsedTransfer): string[] {
  const out: string[] = [];
  if (a.amountCents !== b.amountCents) out.push("monto");
  if (a.trackingKey !== b.trackingKey) out.push("clave de rastreo");
  if (a.authCode !== b.authCode) out.push("número de autorización");
  if (Math.floor(a.occurredAt.getTime() / 60_000) !== Math.floor(b.occurredAt.getTime() / 60_000)) out.push("fecha y hora");
  if (a.originTail !== b.originTail) out.push("cuenta de origen");
  if (a.destTail !== b.destTail) out.push("cuenta de destino");
  return out;
}

/** Comercio con que se guarda: el CONCEPTO que escribió el usuario si dice algo; si no, "Transferencia a <beneficiario>". */
export function transferMerchant(t: Pick<ParsedTransfer, "concept" | "destAlias" | "destName">): string {
  if (!isGenericConcept(t.concept)) return t.concept!.trim().slice(0, 120);
  return `Transferencia a ${t.destAlias || t.destName || "tercero"}`.slice(0, 120);
}
