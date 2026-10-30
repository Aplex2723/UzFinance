import type { PdfText } from "../text";
import {
  cleanBanamexMerchant, makeCheck, makeDoc, makePlan, makeTxn, pageLines, parseDate, parseInstallment, parseMoney, type Installment,
  type Plan, type RawDoc, type Txn, type TxnType,
} from "./common";

/**
 * Extractor de estados de cuenta de tarjeta de crédito Banamex (Explora, Costco…); port de extract_banamex_credit.py.
 * Signo: en estos estados "+ $X" es un cargo y "- $X" es un abono (pago o reembolso).
 */

const MONEY = String.raw`\$\s?[\d,]+\.\d{2}`;
// Nota al pie (superíndice) pegada a la etiqueta: pdfplumber la da pegada ("Intereses8"), pdf.js a veces con espacio ("Intereses 8").
const FN = String.raw`(?: ?\d+)?`;
const RE_PERIOD = /Periodo:\s*(\d{1,2}-\w{3}-\d{4}) al (\d{1,2}-\w{3}-\d{4})/;
const RE_CUT = /Fecha de corte:\s*(\d{1,2}-\w{3}-\d{4})/;
const RE_CARD = /N[uú]mero de tarjeta\s+(\d{4}) (\d{4}) (\d{4}) (\d{4})/;
const RE_REGULAR = /^(\d{2}-\w{3}-\d{4}) (\d{2}-\w{3}-\d{4}) (.+?) ([+-]) (\$ ?[\d ,.]+)$/;
const RE_PLAN = new RegExp(`^(\\d{2}-\\w{3}-\\d{4}) (.+?) (${MONEY}) (${MONEY}) (${MONEY}) (\\d+) de (\\d+) (\\S+)$`);
const RE_TOTAL = /^Total (cargos|abonos) ([+-]) (\$ ?[\d ,.]+)$/;
const RE_SUMMARY: Record<string, RegExp> = {
  adeudo_anterior: new RegExp(`^Adeudo del periodo anterior = (${MONEY})`),
  cargos_regulares: new RegExp(`^Cargos regulares \\(no a meses\\) \\+ (${MONEY})`),
  cargos_meses_capital: new RegExp(`^Cargos compras a meses \\(capital\\)${FN} \\+ (${MONEY})`),
  intereses: new RegExp(`^Monto de Intereses${FN} \\+ (${MONEY})`),
  comisiones: new RegExp(`^Monto de comisiones${FN} \\+ (${MONEY})`),
  iva: new RegExp(`^IVA de Intereses y comisiones${FN} \\+ (${MONEY})`),
  pagos_abonos: new RegExp(`^Pagos y abonos - (${MONEY})`),
  pago_no_intereses: new RegExp(`^Pago para no generar intereses:?${FN} (${MONEY})`),
};

/** Reglas deterministas de tipo para una línea de tarjeta de crédito Banamex. Devuelve [tipo, mensualidad, descripción sin marcador]. */
export function classifyBanamexCredit(desc: string, amount: number): [TxnType, Installment | null, string] {
  const up = desc.toUpperCase();
  const [inst, rest] = parseInstallment(desc);
  if (up.startsWith("SU ABONO")) return ["payment", null, desc];
  if (up.startsWith("COMISION") || up.startsWith("IVA COMISION")) return ["fee", null, desc];
  if (up.startsWith("INTERES") || up.startsWith("IVA POR INTERES")) return ["interest", null, desc];
  if (inst) return ["installment", inst, rest];
  if (up.includes("DISP. EFECTIV") || up.includes("DISPOSICION DE EFECTIVO") || up.includes("DISP EFECTIVO")) return ["cash_withdrawal", null, desc];
  if (amount < 0) return ["refund", null, desc];
  return ["purchase", null, desc];
}

/**
 * Nombre del producto impreso en el estado ("Tarjeta de Crédito EXPLORA BANAMEX Número de días…") y la clave que le damos:
 * EXPLORA -> "explora", COSTCO -> "costco"; cualquier otro producto -> su nombre en minúsculas sin "banamex" ni acentos.
 * (En Python la clave sale del nombre del archivo: "Estado de cuenta_explora.pdf".)
 */
export function banamexCreditKey(lines: string[]): { product: string | null; key: string } {
  for (const ln of lines.slice(0, 80)) {
    const m = /^Tarjeta de Cr[eé]dito (.+?) N[uú]mero de d[ií]as/.exec(ln);
    if (!m) continue;
    const product = m[1].trim();
    const key = product.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/\bbanamex\b/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return { product, key: key || "banamex" };
  }
  return { product: null, key: "banamex" };
}

export function extractBanamexCredit(pdf: PdfText, document?: string, cardKey?: string): RawDoc {
  // Puntos sueltos del pie de página (". .") que pdf.js a veces pega al último renglón de la página: "+ $1,259.00 ..".
  const lines = pdf.pages.flatMap((p) => pageLines(p)).map((l) => l.trim().replace(/(?:\s+\.+)+$/, "")).filter(Boolean);
  const auto = banamexCreditKey(lines);
  const key = cardKey || auto.key;
  const doc = makeDoc(document || `${key}_stmt`, key, null, null);
  if (auto.product) doc.product = auto.product;
  const summary: Record<string, number> = {};
  const printed: Record<string, number> = {};
  let mode: "plans" | "regular" | null = null;
  let holder = "titular";
  let lastPlan: Plan | null = null;

  for (const ln of lines) {
    let m = RE_PERIOD.exec(ln);
    if (m && doc.period === null) {
      const start = parseDate(m[1]);
      const end = parseDate(m[2]);
      if (start && end) doc.period = { start, end };
    }
    m = RE_CUT.exec(ln);
    if (m) doc.as_of = parseDate(m[1]);
    m = RE_CARD.exec(ln);
    if (m && !("card_last4" in doc)) {
      doc.card_last4 = m[4];
      // los 8 primeros dígitos identifican la tarjeta en los pagos "A TB NNNN NNNN" de la cuenta de débito
      doc.card_bin8 = m[1] + m[2];
    }
    for (const [k, rx] of Object.entries(RE_SUMMARY)) {
      m = rx.exec(ln);
      if (m && !(k in summary)) summary[k] = parseMoney(m[1]);
    }

    if (ln.startsWith("COMPRAS Y CARGOS DIFERIDOS A MESES")) { mode = "plans"; lastPlan = null; continue; }
    if (ln.startsWith("CARGOS, ABONOS Y COMPRAS REGULARES")) { mode = "regular"; continue; }
    m = /^Tarjeta (titular|digital):/.exec(ln);
    if (m && mode) { holder = m[1]; continue; }

    if (mode === "plans") {
      m = RE_PLAN.exec(ln);
      if (m) {
        const [, d, desc, orig, pend, req, n, tot, rate] = m;
        const withInt = rate.toUpperCase() !== "NA" && /^\d+$/.test(rate.replace("%", "").replace(".", ""));
        lastPlan = makePlan({
          merchant: cleanBanamexMerchant(desc), original_cents: parseMoney(orig), pending_cents: parseMoney(pend), monthly_cents: parseMoney(req),
          n_current: +n, n_total: +tot, rate_pct: withInt ? rate.replace("%", "") : "0.00", with_interest: withInt,
          op_date: parseDate(d), kind: desc.toUpperCase().includes("DISP") ? "cash_advance" : "purchase", holder,
          op_date_is_latest_installment: true, raw: desc,
        });
        doc.plans.push(lastPlan);
        continue;
      }
      if (lastPlan && /^A PAGAR EN /.test(ln)) { lastPlan.note = ln; continue; }
    }

    if (mode === "regular") {
      m = RE_TOTAL.exec(ln);
      if (m) { printed[m[1]] = Math.abs(parseMoney(m[3])); continue; }
      m = RE_REGULAR.exec(ln);
      if (m) {
        const [, dOp, dPost, desc, sign, amt] = m;
        const abs = parseMoney(amt);
        const cents = sign === "-" ? -abs : abs;
        const [type, inst, rest] = classifyBanamexCredit(desc, cents);
        let merchant = cleanBanamexMerchant(rest);
        let note: string | null = null;
        if (type === "cash_withdrawal") {
          note = "disposicion de efectivo";
          const base = rest.replace(/\s*DISP\. EFECTIV(MX)?\s*$/, "").trim();
          merchant = base.replace(/^\d{3,4} /, "").trim() || merchant;
        }
        doc.transactions.push(makeTxn({
          date: parseDate(dOp), post_date: parseDate(dPost), merchant, raw: desc, amount_cents: cents, type, holder,
          section: holder === "digital" ? "digital" : "regular", installment: inst, note,
        }));
      }
    }
  }

  doc.summary = { ...summary };
  const txns: Txn[] = doc.transactions;
  const sum = (pred: (t: Txn) => boolean) => txns.reduce((s, t) => s + (pred(t) ? t.amount_cents : 0), 0);
  const charges = sum((t) => t.amount_cents > 0);
  const credits = -sum((t) => t.amount_cents < 0);
  if ("cargos" in printed) doc.checks.push(makeCheck("total cargos", printed.cargos, charges));
  else doc.warnings.push("no se encontro 'Total cargos'");
  if ("abonos" in printed) doc.checks.push(makeCheck("total abonos", printed.abonos, credits));
  else doc.warnings.push("no se encontro 'Total abonos'");
  if ("pagos_abonos" in summary) doc.checks.push(makeCheck("pagos y abonos (resumen)", summary.pagos_abonos, credits));
  const planMonthly = doc.plans.reduce((s, p) => s + p.monthly_cents, 0);
  if ("cargos_meses_capital" in summary) doc.checks.push(makeCheck("plans: suma pago requerido = cargos compras a meses (capital)", summary.cargos_meses_capital, planMonthly));
  const instTotal = sum((t) => t.type === "installment");
  doc.checks.push(makeCheck("lineas de mensualidad = suma pago requerido de plans", planMonthly, instTotal));
  if ("cargos_regulares" in summary) {
    // el resumen no netea los reembolsos aquí: se suman en "pagos y abonos"
    const regular = sum((t) => t.amount_cents > 0 && !["installment", "fee", "interest"].includes(t.type));
    doc.checks.push(makeCheck("cargos regulares (resumen) = compras + disposiciones", summary.cargos_regulares, regular));
  }
  const fees = sum((t) => t.type === "fee");
  const ints = sum((t) => t.type === "interest");
  if ("comisiones" in summary && "intereses" in summary && "iva" in summary) {
    doc.checks.push(makeCheck("comisiones + intereses + IVA (resumen) = lineas fee+interest", summary.comisiones + summary.intereses + summary.iva, fees + ints));
  }
  return doc;
}
