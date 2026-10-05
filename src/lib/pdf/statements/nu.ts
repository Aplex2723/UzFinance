import type { PdfText } from "../text";
import { makeCheck, makeDoc, makePlan, makeTxn, pageLines, parseDate, parseInstallment, parseMoney, type Installment, type RawDoc, type Txn, type TxnType } from "./common";

/**
 * Extractor del estado de cuenta de la tarjeta de crédito Nu (port de extract_nu.py). Signo: "+$X" cargo, "-$X" abono.
 * Las líneas "Tarjeta virtual **** NNNN" y "Cambio (USD 1 = $16.96) USD 100.00" que siguen a un movimiento se anexan a él.
 */

const DATE = String.raw`\d{2} [A-Z]{3} \d{4}`;
const M = String.raw`\$[\d,]+\.\d{2}`;
// Nota al pie (superíndice) pegada a la etiqueta: pdfplumber la da pegada ("Intereses8"), pdf.js a veces con espacio ("Intereses 8").
const FN = String.raw`(?: ?\d+)?`;
const RE_PERIOD = new RegExp(`Periodo: (${DATE}) al (${DATE})`);
const RE_CUT = new RegExp(`Fecha de corte: (${DATE})`);
const RE_MOV = new RegExp(`^(${DATE}) (${DATE}) (.+?) \\| RFC: (\\S+) ([+-])(${M})$`);
const RE_PLAN_SIN = new RegExp(`^(${DATE}) (.+?) (${M}) (${M}) (${M}) (\\d+)/(\\d+) ([\\d.]+)%$`);
const RE_PLAN_CON = new RegExp(`^(${DATE}) (${M}) (${M}) (${M}) (${M}) (${M}) (\\d+)/(\\d+) ([\\d.]+)%$`);
const RE_VIRTUAL = /^Tarjeta virtual \*+ ?(\d{4})$/;
const RE_FX = /^Cambio \(([A-Z]{3}) 1 = \$([\d.]+)\) [A-Z]{3} ([\d,]+\.\d{2})$/;
const RE_TOTAL = new RegExp(`^Total de (cargos|abonos) ([+-])(${M})$`);
const RE_SUMMARY: Record<string, RegExp> = {
  cargos_regulares: new RegExp(`^Cargos regulares \\(no a meses\\) \\+ (${M})`),
  cargos_meses_capital: new RegExp(`^Cargos y compras a meses \\(capital\\)${FN} \\+ (${M})`),
  intereses: new RegExp(`^Monto de intereses${FN} \\+ (${M})`),
  iva: new RegExp(`^IVA de intereses y comisiones${FN} \\+ (${M})`),
  pagos_abonos: new RegExp(`^Pagos y abonos - (${M})`),
};

/** [tipo, mensualidad, descripción limpia, nota]. */
export function classifyNu(desc: string, amount: number): [TxnType, Installment | null, string, string | null] {
  const low = desc.toLowerCase();
  if (low.includes("grácias por tu pago") || low.includes("gracias por tu pago")) return ["payment", null, desc, null];
  if (low.startsWith("disposición de saldo en cuenta nu")) {
    if (low.endsWith("- intereses")) return ["interest", null, "Disposición de saldo en Cuenta Nu (intereses)", "intereses del plan de disposicion"];
    const [inst, rest] = parseInstallment(desc);
    return ["installment", inst, rest, "capital de plan de disposicion de saldo (cash_advance)"];
  }
  if (low.startsWith("iva sobre intereses")) return ["interest", null, desc, "IVA sobre intereses de plan de pagos fijos"];
  const [inst, rest] = parseInstallment(desc);
  if (inst) return ["installment", inst, rest, null];
  if (amount < 0) return ["refund", null, desc, null];
  return ["purchase", null, desc, null];
}

const iso = (s: string) => parseDate(s);

export function extractNu(pdf: PdfText, document = "nu_stmt", cardKey = "nu"): RawDoc {
  const lines = pdf.pages.flatMap((p) => pageLines(p)).map((l) => l.trim()).filter(Boolean);
  const doc = makeDoc(document, cardKey, null, null);
  const summary: Record<string, number> = {};
  const printed: Record<string, number> = {};
  let mode: "plans_sin" | "plans_con" | "regular" | null = null;
  let holderName: string | null = null;
  let current: Txn | null = null;

  for (let i = 0; i < lines.length; ) {
    const ln = lines[i++];
    let m = RE_PERIOD.exec(ln);
    if (m && doc.period === null) {
      const start = iso(m[1]);
      const end = iso(m[2]);
      if (start && end) doc.period = { start, end };
    }
    m = RE_CUT.exec(ln);
    if (m) doc.as_of = iso(m[1]);
    m = /N[uú]mero de tarjeta: X+-X+-X+-(\d{4})/.exec(ln);
    if (m && !("card_last4" in doc)) doc.card_last4 = m[1];
    for (const [key, rx] of Object.entries(RE_SUMMARY)) {
      m = rx.exec(ln);
      if (m && !(key in summary)) summary[key] = parseMoney(m[1]);
    }

    if (ln.startsWith("COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES")) { mode = "plans_sin"; continue; }
    if (ln.startsWith("COMPRAS Y CARGOS DIFERIDOS A MESES CON INTERESES")) { mode = "plans_con"; continue; }
    if (ln.startsWith("CARGOS, ABONOS Y COMPRAS REGULARES")) { mode = "regular"; current = null; continue; }
    m = /^Tarjeta titular: (.+)$/.exec(ln);
    if (m) { holderName = m[1].trim(); continue; }
    if (ln.startsWith("NOTAS ACLARATORIAS")) { mode = null; continue; }

    if (mode === "plans_sin") {
      m = RE_PLAN_SIN.exec(ln);
      if (m) {
        const [, d, desc, orig, pend, req, n, tot, rate] = m;
        const [, merchant] = parseInstallment(desc);
        doc.plans.push(makePlan({
          merchant, original_cents: parseMoney(orig), pending_cents: parseMoney(pend), monthly_cents: parseMoney(req),
          n_current: +n, n_total: +tot, rate_pct: rate, with_interest: false, op_date: iso(d), kind: "purchase", holder: holderName,
        }));
      }
    } else if (mode === "plans_con") {
      m = RE_PLAN_CON.exec(ln);
      if (m) {
        // La descripción ocupa el renglón anterior y el siguiente (la tabla la parte alrededor de los importes).
        const desc = `${lines[i - 2] ?? ""} ${lines[i] ?? ""}`.trim();
        const [, d, orig, pend, interest, iva, req, n, tot, rate] = m;
        const [, merchant] = parseInstallment(desc);
        doc.plans.push(makePlan({
          merchant, original_cents: parseMoney(orig), pending_cents: parseMoney(pend), monthly_cents: parseMoney(req),
          n_current: +n, n_total: +tot, rate_pct: rate, with_interest: true, op_date: iso(d),
          kind: desc.toLowerCase().startsWith("disposición de saldo") ? "cash_advance" : "purchase", holder: holderName,
          note: `intereses del periodo ${interest}, IVA ${iva}`, interest_cents: parseMoney(interest), iva_cents: parseMoney(iva),
        }));
      }
    } else if (mode === "regular") {
      m = RE_TOTAL.exec(ln);
      if (m) { printed[m[1]] = Math.abs(parseMoney(m[3])); current = null; continue; }
      m = RE_MOV.exec(ln);
      if (m) {
        const [, dOp, dPost, desc, rfc, sign, amt] = m;
        const abs = parseMoney(amt);
        const cents = sign === "-" ? -abs : abs;
        const [type, inst, clean, note] = classifyNu(desc, cents);
        current = makeTxn({
          date: iso(dOp), post_date: iso(dPost), merchant: clean, raw: desc, amount_cents: cents, type, holder: holderName,
          section: "regular", installment: inst, note, rfc: rfc === "S.I." ? null : rfc,
        });
        doc.transactions.push(current);
        continue;
      }
      if (current) {
        const mv = RE_VIRTUAL.exec(ln);
        const mf = RE_FX.exec(ln);
        if (mv) {
          current.holder = "virtual";
          current.section = "virtual";
          const extra = `tarjeta virtual **** ${mv[1]} (titular: ${holderName})`;
          current.note = current.note ? `${current.note}; ${extra}` : extra;
          current.raw += ` ${ln}`;
        } else if (mf) {
          const [, cur, fx, amount] = mf;
          current.raw += ` ${ln}`;
          if (cur !== "MXN") current.foreign = { currency: cur, amount: amount.replace(/,/g, ""), fx };
        } else if (ln.startsWith("Abono (")) {
          current.raw += ` ${ln}`;
          current.note = (current.note ? `${current.note}; ` : "") + ln;
        }
      }
    }
  }

  doc.summary = summary;
  const txns = doc.transactions;
  const charges = txns.reduce((s, t) => s + (t.amount_cents > 0 ? t.amount_cents : 0), 0);
  const credits = -txns.reduce((s, t) => s + (t.amount_cents < 0 ? t.amount_cents : 0), 0);
  const sum = (pred: (t: Txn) => boolean) => txns.reduce((s, t) => s + (pred(t) ? t.amount_cents : 0), 0);
  if ("cargos" in printed) {
    // El "Total de cargos" impreso NO incluye las líneas "IVA sobre intereses" aunque se listen entre los movimientos;
    // el resumen las muestra aparte.
    const ivaLines = sum((t) => t.amount_cents > 0 && t.raw.toLowerCase().startsWith("iva sobre intereses"));
    doc.checks.push(makeCheck("total cargos (impreso) + IVA sobre intereses listado aparte", printed.cargos + ivaLines, charges));
  }
  if ("abonos" in printed) doc.checks.push(makeCheck("total abonos", printed.abonos, credits));
  if ("pagos_abonos" in summary) doc.checks.push(makeCheck("pagos y abonos (resumen)", summary.pagos_abonos, credits));
  const instCap = sum((t) => t.type === "installment");
  const ints = sum((t) => t.type === "interest");
  if ("cargos_meses_capital" in summary) doc.checks.push(makeCheck("cargos a meses (capital, resumen) = lineas installment", summary.cargos_meses_capital, instCap));
  if ("intereses" in summary && "iva" in summary) doc.checks.push(makeCheck("intereses + IVA (resumen) = lineas interest", summary.intereses + summary.iva, ints));
  if ("cargos_regulares" in summary) doc.checks.push(makeCheck("cargos regulares (resumen) = compras", summary.cargos_regulares, sum((t) => t.amount_cents > 0 && t.type === "purchase")));
  const planReq = doc.plans.reduce((s, p) => s + p.monthly_cents, 0);
  doc.checks.push(makeCheck("plans: pago requerido (sin+con intereses) = lineas installment (capital)", planReq, instCap));
  return doc;
}
