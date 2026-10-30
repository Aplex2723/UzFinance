import type { PdfText } from "../text";
import {
  inferYear, joinWords, makeCheck, makeDoc, makeTxn, mkDate, monthNumber, pageLines, pageWords, parseMoney, wordLines,
  type Foreign, type RawDoc, type TxnType,
} from "./common";

/**
 * Extractor del estado de cuenta de la cuenta de débito Banamex (MiCuenta); port de extract_banamex_debit.py.
 * Lee el "Detalle de Operaciones" con posiciones de palabras: la fecha va en la columna izquierda, el CONCEPTO ocupa varias
 * líneas y los importes (RETIROS / DEPOSITOS / SALDO) están al final de la ÚLTIMA línea del renglón. La cadena de saldos decide
 * si un importe es retiro o depósito y es la verificación principal.
 * Convención de signo del JSON: retiro (dinero que sale) = positivo; depósito (dinero que entra) = negativo (igual que
 * "abono/crédito" en las tarjetas). El tipo dice la naturaleza.
 */

const AMT = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
// palabras que delatan una razón social (si no aparece ninguna, se asume persona física)
const COMPANY = /\b(S\.?A\.?|SA|SAPI|CV|S DE RL|SC|AC|SOFOM|INC|LLC|LTD|BANCO|SERVICIOS|DESARROLLOS|GRUPO|COMPANY|CORP|SRL|SPA|GMBH)\b/;
const CARD_RE = /\b\d{16}\b/; // número de la tarjeta de débito (16 dígitos) dentro del concepto

export function initials(name: string): string {
  const parts = name.trim().split(/[\s,/]+/).filter(Boolean);
  return parts.length ? `${parts.map((p) => [...p][0].toUpperCase()).join(".")}.` : "";
}

export const isCompany = (name: string) => COMPANY.test(name.toUpperCase());

/** Python `str.title()`: mayúscula inicial en cada tramo de letras y minúsculas en el resto. */
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

/** Quita cuentas/CLABE/rastreos/ids largos y reemplaza nombres de terceros por iniciales. */
export function scrubRaw(text: string, ownName = ""): string {
  let t = text.replace(/\s+/g, " ").trim();
  const personToInitials = (m: string, a: string, name0: string, c: string) => {
    const name = name0.trim();
    if (isCompany(name) || (ownName && name.toUpperCase().startsWith(ownName.toUpperCase().slice(0, 15)))) return m;
    return `${a}${initials(name)}${c}`;
  };
  t = t.replace(/(AL BENEF\. )(.+?)( \(DATO NO)/g, personToInitials);
  t = t.replace(/(POR ORDEN DE )(.+?)( CTA\.ORDENANTE| REF\.|$)/g, personToInitials);
  const toks: string[] = [];
  for (const tok of t.split(" ")) {
    if (/\d{10,}/.test(tok)) continue;
    if (tok.length >= 9 && /^[A-Za-z0-9]+$/.test(tok) && [...tok].filter((c) => c >= "0" && c <= "9").length >= 6) continue;
    toks.push(tok);
  }
  t = toks.join(" ");
  t = t.replace(/RASTREO:?( \S+)?(?= REF| CTA| MISMO|$)/g, "RASTREO:");
  return t.replace(/\s+/g, " ").trim();
}

type RowInfo = { type: TxnType | null; merchant: string; note: string | null; foreign: Foreign | null; post_date: string | null };

/** Tipo, comercio y nota de un renglón del detalle (sus líneas de CONCEPTO ya separadas). */
export function classifyDebitRow(conceptLines: string[], ownName: string, withdrawal: boolean, amountCents: number): RowInfo {
  const text = conceptLines.join(" ").replace(/\s+/g, " ").trim();
  const up = text.toUpperCase();
  const out: RowInfo = { type: null, merchant: text, note: null, foreign: null, post_date: null };
  const set = (type: TxnType, merchant: string, note: string | null = null) => { out.type = type; out.merchant = merchant; out.note = note; };

  if (up.startsWith("EXENCION COBRO COMISION")) {
    const ex = /IMPORTE A EX ?ENTAR \$([\d,.]+)/.exec(up);
    set("fee", "Exencion cobro comision", amountCents === 0
      ? `exencion informativa de comision (importe a exentar $${ex?.[1]} en el concepto); no mueve el saldo`
      : "exencion de comision");
  } else if (up.startsWith("IVA COMISION") || up.startsWith("COMISION")) {
    const low = text.toLowerCase();
    set("fee", up.startsWith("IVA") ? `IVA${low.slice(3)}` : low.charAt(0).toUpperCase() + low.slice(1));
  } else if (up.includes("PAGO DE IMPUESTOS")) {
    set("tax", "Pago de impuestos");
  } else if (up.startsWith("DOMI ")) {
    const name = up.slice(5).split(/\sAUT\.? DOMI/)[0].trim().replace(/\s+/g, " ");
    if (name.startsWith("AMERICAN EXPRESS")) set("domiciliation_card_payment", "American Express");
    else set("domiciliation_other", name);
  } else if (up.startsWith("PAGO INTERBANCARIO A")) {
    const m = /^PAGO INTERBANCARIO A (.+?) AL BENEF\. (.+?) \(DATO NO VERIFICADO/i.exec(text);
    const bank = m ? m[1].trim() : "banco";
    const benef = m ? m[2].trim() : "";
    const cm = /REF\. ?\S+ (.*?)(?: MISMO DIA)?$/.exec(text);
    let concept = cm ? cm[1].trim() : "";
    if (concept.toLowerCase() === "transferencia interbancaria") concept = "";
    const notes: string[] = [];
    if (concept) notes.push(concept);
    if (benef && isCompany(benef)) notes.push(`benef. ${benef}`);
    set("transfer_out", `Transferencia SPEI a ${bank}`, notes.join(" | ") || null);
  } else if (up.startsWith("PAGO RECIBIDO DE")) {
    const m = /^PAGO RECIBIDO DE (.+?)(?: POR ORDEN DE (.+?))?(?: CTA\.ORDENANTE| REF[.:]|$)/.exec(text);
    const sender = (m?.[1] ?? "").trim();
    const orden = (m?.[2] ?? "").trim();
    const fm = /DIVISA:([A-Z]{3}) IMPORTE: \$([\d,.]+)\/TC \$([\d.]+)/.exec(text);
    if (fm) out.foreign = { currency: fm[1], amount: fm[2].replace(/,/g, ""), fx: fm[3] };
    if (orden && ownName && orden.toUpperCase().startsWith(ownName.toUpperCase())) {
      set("transfer_own", `Transferencia SPEI recibida de ${titleCase(sender)} (cuenta propia)`);
    } else if (orden) {
      if (isCompany(orden)) set("income", orden);
      else set("income", `Transferencia SPEI recibida de ${sender}`, `ordenante ${initials(orden)}`);
    } else {
      set("income", sender.replace(/^\d+\//, "").replace(/\s+\.\s+/g, " "));
    }
  } else if (up.startsWith("DEPOSITO INVERSION")) {
    set("transfer_own", `Inversion ${titleCase(text.split(" ").slice(2).join(" "))}`, withdrawal ? "deposito a inversion propia" : "retiro de inversion propia");
  } else if (up.startsWith("DEPOSITO POR RETIRO DE AHORRO")) {
    set("transfer_own", "Retiro de ahorro a la vista", "de Ahorro Facil (cuenta propia)");
  } else if (up.startsWith("TRASPASO")) {
    set("transfer_own", "Traspaso", `traspaso banca electronica ${withdrawal ? "(sale)" : "(entra)"}`);
  } else if (/^PAGO DE SERVICIO \d+ A TB\b/.test(up) && /\b\d{12}(\d{4})\b/.test(text) && withdrawal) {
    // Pago a una tarjeta de crédito Banamex ("A TB" + número de tarjeta de 16 dígitos): es un pago de tarjeta, no un gasto. El mismo pago
    // sale como "SU ABONO" en el estado de la tarjeta y la importación lo guarda una sola vez.
    set("domiciliation_card_payment", `Pago a tarjeta Banamex ···${/\b\d{12}(\d{4})\b/.exec(text)![1]}`);
  } else if (CARD_RE.test(text)) {
    // compra con tarjeta de débito: comercio, ciudad y fechas/ids
    const merch: string[] = [];
    for (const ln of conceptLines) {
      if (/^\d{8} /.test(ln)) break;
      merch.push(ln);
    }
    const pm = /\b(20\d{2})(\d{2})(\d{2}) /.exec(text);
    if (pm) out.post_date = `${pm[1]}-${pm[2]}-${pm[3]}`;
    set(withdrawal ? "purchase" : "refund", merch.length ? merch[0].trim() : text, merch.length > 1 ? `ciudad: ${merch.slice(1).join(" ")}` : null);
  }
  return out;
}

type Row = { day: number; mon: number; lines: string[]; w: number | null; d: number | null; bal: number | null };

/** Nombre del titular: la primera línea toda en mayúsculas que sigue al rótulo "MiCuenta" en el encabezado. */
function ownNameOf(firstPageLines: string[]): string {
  const head = firstPageLines.slice(0, 14);
  const i = head.findIndex((l) => /MiCuenta$/.test(l));
  if (i < 0) return "";
  for (const l of head.slice(i + 1, i + 4)) {
    const m = /^([A-Z ]{8,60})$/.exec(l.trim());
    if (m) return m[1].trim();
  }
  return "";
}

export function extractBanamexDebit(pdf: PdfText, document = "debito_stmt", cardKey = "debito"): RawDoc {
  const pageTexts = pdf.pages.map((p) => pageLines(p));
  const texts = pageTexts.map((l) => l.join("\n"));
  const ownName = ownNameOf(pageTexts[0] ?? []);
  const full = `${texts.slice(0, 3).join("\n")}\n${texts.slice(3, 5).join("\n")}`;

  let start: string | null = null;
  let end: string | null = null;
  const pm = /Per[ií]odo del (\d{1,2}) de (\w+) al (\d{1,2}) de (\w+) del (\d{4})/.exec(texts[0] ?? "");
  if (pm) {
    const y = +pm[5];
    const em = monthNumber(pm[4]);
    const sm = monthNumber(pm[2]);
    if (em && sm) {
      end = mkDate(y, em, +pm[3]);
      start = mkDate(sm <= em ? y : y - 1, sm, +pm[1]);
    }
  }
  const doc = makeDoc(document, cardKey, start && end ? { start, end } : null, end);
  const mc = /N[uú]mero de Tarjeta de D[eé]bito (\d{12})(\d{4})/.exec(texts[0] ?? "");
  if (mc) doc.card_last4 = mc[2];

  // Notas al pie y palabras pegadas: las etiquetas toleran espacios de más o de menos.
  const sumd: Record<string, string[]> = {};
  const RX: Record<string, RegExp> = {
    saldo_anterior: /Saldo anterior\s*En pesos M\.N\.\s*([\d,]+\.\d{2})/,
    depositos: /\(\+\)\s*(\d+)\s*Dep[oó]sitos\s*([\d,]+\.\d{2})/,
    retiros: /\(-\)\s*(\d+)\s*Retiros\/Otros cargos\s*([\d,]+\.\d{2})/,
    saldo_corte: /Saldo al Corte\s*([\d,]+\.\d{2})/,
    comisiones: /COMISIONES COBRADAS EN EL PERIODO:\s*([\d,]+\.\d{2})/,
  };
  for (const [k, rx] of Object.entries(RX)) {
    const m = rx.exec(full);
    if (m) sumd[k] = m.slice(1);
  }

  // ---- detalle de operaciones (páginas con la tabla)
  const rows: Row[] = [];
  let cur: Row | null = null;
  let prevBalance: number | null = null;
  let stop = false;
  for (const page of pdf.pages) {
    if (stop) break;
    let inTable = false;
    for (const ln of wordLines(pageWords(page), 3)) {
      const txt = joinWords(ln);
      const top = ln[0].top;
      if (txt.includes("FECHA") && txt.includes("CONCEPTO") && txt.includes("SALDO")) { inTable = true; continue; }
      if (!inTable || top > 740) continue;
      if (txt.startsWith("Domiciliaci") || txt.startsWith("AHORRO") || txt.includes("Cargo Autom") || txt.startsWith("Resumen Operaciones")) { stop = true; break; }
      if (txt.startsWith("SALDO ANTERIOR")) {
        const last = ln.at(-1)!.str;
        if (AMT.test(last)) prevBalance = parseMoney(last);
        continue;
      }
      const dateWords = ln.filter((w) => w.x1 <= 72);
      const conceptWords = ln.filter((w) => w.x0 >= 75 && w.x0 < 345);
      const amtWords = ln.filter((w) => w.x0 >= 345 && AMT.test(w.str));
      // inicio de renglón
      if (dateWords.length >= 2 && /^\d+$/.test(dateWords[0].str) && monthNumber(dateWords[1].str)) {
        cur = { day: +dateWords[0].str, mon: monthNumber(dateWords[1].str)!, lines: [], w: null, d: null, bal: null };
        rows.push(cur);
      }
      if (!cur) continue;
      const ctext = joinWords(conceptWords);
      if (ctext) cur.lines.push(ctext);
      for (const w of amtWords) {
        const cents = parseMoney(w.str);
        if (w.x1 < 430) cur.w = cents;
        else if (w.x1 < 500) cur.d = cents;
        else cur.bal = cents;
      }
    }
  }

  // ---- cadena de saldos y construcción de transacciones
  let bal: number | null = sumd.saldo_anterior ? parseMoney(sumd.saldo_anterior[0]) : prevBalance;
  if (bal === null) {
    doc.warnings.push("no se encontro el saldo anterior: la cadena de saldos arranca en 0");
    bal = 0;
  }
  let chainOk = true;
  let depCount = 0, wdCount = 0, depTotal = 0, wdTotal = 0;
  for (const r of rows) {
    const label = r.lines.join(" ");
    if (r.bal === null) {
      doc.warnings.push(`renglon sin saldo: ${label.slice(0, 40)}`);
      chainOk = false;
      continue;
    }
    const delta = r.bal - bal;
    const colAmt = r.w ?? r.d;
    const withdrawal = delta < 0;
    const amount = Math.abs(delta);
    if ((colAmt ?? 0) !== amount) {
      chainOk = false;
      doc.warnings.push(`cadena de saldo: importe de columna ${colAmt} != delta ${amount} en ${label.slice(0, 40)}`);
    }
    if (r.w !== null && !withdrawal && amount) { chainOk = false; doc.warnings.push("retiro en columna pero el saldo sube"); }
    if (r.d !== null && withdrawal) { chainOk = false; doc.warnings.push("deposito en columna pero el saldo baja"); }
    bal = r.bal;
    const year = start && end ? inferYear(r.day, r.mon, start, end) : +(end ?? "2000").slice(0, 4);
    const opDate = mkDate(year, r.mon, r.day);
    if (amount) {
      if (withdrawal) { wdCount++; wdTotal += amount; } else { depCount++; depTotal += amount; }
    }
    const info = classifyDebitRow(r.lines, ownName, withdrawal, amount);
    if (info.type === null) {
      doc.warnings.push(`concepto sin clasificar (${label.slice(0, 50)})`);
      info.type = withdrawal ? "purchase" : "income";
    }
    let signed = withdrawal ? amount : -amount;
    if (info.type === "fee" && amount === 0) signed = 0;
    doc.transactions.push(makeTxn({
      date: opDate, post_date: info.post_date, merchant: info.merchant, raw: scrubRaw(label, ownName), amount_cents: signed,
      type: info.type, holder: null, section: "regular", foreign: info.foreign, note: info.note, balance_cents: r.bal,
    }));
  }

  doc.checks.push(makeCheck("cadena de saldos (renglones inconsistentes = 0)", 0, chainOk ? 0 : 1, 0, "count"));
  if (sumd.saldo_corte) doc.checks.push(makeCheck("saldo final = saldo al corte", parseMoney(sumd.saldo_corte[0]), bal));
  if (sumd.depositos) {
    doc.checks.push(makeCheck("total depositos", parseMoney(sumd.depositos[1]), depTotal));
    doc.checks.push(makeCheck("numero de depositos", +sumd.depositos[0], depCount, 0, "count"));
  }
  if (sumd.retiros) {
    doc.checks.push(makeCheck("total retiros/otros cargos", parseMoney(sumd.retiros[1]), wdTotal));
    doc.checks.push(makeCheck("numero de retiros/otros cargos", +sumd.retiros[0], wdCount, 0, "count"));
  }
  if (sumd.comisiones) {
    const com = doc.transactions.reduce((a, t) => a + (t.type === "fee" && t.raw.toUpperCase().startsWith("COMISION") ? t.amount_cents : 0), 0);
    doc.checks.push(makeCheck("comisiones cobradas (sin IVA)", parseMoney(sumd.comisiones[0]), com));
  }
  doc.summary = { ...sumd };
  return doc;
}
