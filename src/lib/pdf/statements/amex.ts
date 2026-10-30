import type { PdfText, PdfWord } from "../text";
import {
  joinWords, makeCheck, makeDoc, makePlan, makeTxn, monthNumber, mkDate, pageLines, pageWords, parseDate, parseMoney, splitAmexCity, wordLines,
  type Installment, type Plan, type PlanRef, type RawDoc, type Txn, type TxnType,
} from "./common";

/**
 * Extractor del estado de cuenta American Express (Platinum) con posiciones de palabras; port de extract_amex.py.
 * Peculiaridades que resuelve:
 *  - la fecha se parte en dos renglones ("28 de" / "Agosto", o pegada "deAgosto") y puede quedar en la página siguiente
 *    a la del importe;
 *  - los movimientos pertenecen al bloque del tarjetahabiente que CIERRA con el renglón
 *    "Total de las transacciones en $ de <NOMBRE> <monto>" (el total va DESPUÉS de sus líneas);
 *  - sección en moneda extranjera cerrada con "Total de Transacciones en Moneda Extranjera de";
 *  - "CR" al final = crédito (pago, reembolso o "MONTO A DIFERIR ...").
 * Las mensualidades que Amex carga cada mes ("MESES EN AUTOMATICO ...", "Total de Meses sin Intereses") se devuelven en
 * `installment_postings` (NO en transactions) y el consolidado ("Resumen de Meses sin Intereses") en `plans`.
 * Ojo con pdf.js: la fecha llega como "28 de Agosto" (con espacio) y pdfplumber la daba como "28 deAgosto": aquí se lee
 * pegando las palabras después del día, así que sirve con cualquiera de las dos formas.
 */

const AMT = /^\d{1,3}(?:,\d{3})*\.\d{2}$/;
const MONTH_NAMES = new Set(["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]);

const wordsText = (ws: PdfWord[]) => joinWords(ws);

const merchantKey = (s: string) => {
  const skip = new Set(["MEXICO", "CITY", "MERCADOPAGO"]);
  return new Set((s.toUpperCase().replace(/\*/g, " ").match(/[A-Z0-9]{4,}/g) ?? []).filter((t) => !skip.has(t)));
};

/** Plan cuya mensualidad coincide (≤5 centavos) y comparte alguna palabra con el comercio. */
export function linkPlan(plans: Pick<Plan, "merchant" | "original_cents" | "monthly_cents" | "n_current">[], merchant: string, amount: number, n: number | null = null): PlanRef {
  let best: { score: [number, number]; plan: (typeof plans)[number] } | null = null;
  for (const p of plans) {
    if (Math.abs(p.monthly_cents - amount) > 5) continue;
    if (n !== null && p.n_current !== n) continue;
    const mk = merchantKey(p.merchant);
    const overlap = [...merchantKey(merchant)].filter((x) => mk.has(x)).length;
    if (overlap || (merchant.toUpperCase().includes("AUTOM") && p.merchant.toUpperCase().includes("AUTOM"))) {
      const score: [number, number] = [overlap, -Math.abs(p.monthly_cents - amount)];
      if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { score, plan: p };
    }
  }
  return best ? { merchant: best.plan.merchant, original_cents: best.plan.original_cents } : null;
}

type Pending = { _fin?: boolean; _day: number | null; _month: string | null; _desc: string[]; _amt: number; _cr: boolean; _extra: string[]; date?: string | null; holder?: string | null; section?: string };

/** "28 de Agosto", "28 deAgosto" o solo "28 de": día y nombre del mes (o null si todavía no llega). */
function dayMonth(ws: PdfWord[]): { day: number | null; month: string | null } {
  const t = ws.map((w) => w.str);
  if (!t.length || !/^\d+$/.test(t[0])) return { day: null, month: null };
  const mm = /^de(\p{L}+)$/u.exec(t.slice(1).join(""));
  return { day: +t[0], month: mm && monthNumber(mm[1]) ? mm[1] : null };
}

export function extractAmex(pdf: PdfText, document = "amex_stmt", cardKey = "amex"): RawDoc {
  const doc = makeDoc(document, cardKey, null, null);
  const text1 = (pdf.pages[0] ? pageLines(pdf.pages[0]) : []).join("\n");
  const m = /Per[ií]odo de Facturaci[oó]n Del (\d{1,2}) de ?(\p{L}+) al ?(\d{1,2}) de ?(\p{L}+) de ?(\d{4})/u.exec(text1);
  let end: string | null = null;
  if (m) {
    const em = monthNumber(m[4]);
    const sm = monthNumber(m[2]);
    if (em && sm) {
      end = mkDate(+m[5], em, +m[3]);
      const start = mkDate(sm <= em ? +m[5] : +m[5] - 1, sm, +m[1]);
      if (start && end) {
        doc.period = { start, end };
        doc.as_of = end;
      }
    }
  }
  const year = end ? +end.slice(0, 4) : new Date().getUTCFullYear();
  const mc = /(\d{4})-(\d{6})-(\d{5})/.exec(text1);
  if (mc) doc.card_last5 = mc[3];
  const summ = /([\d,]+\.\d{2}) - ([\d,]+\.\d{2}) \+ ([\d,]+\.\d{2}) = ([\d,]+\.\d{2}) ([\d,]+\.\d{2})/.exec(text1);
  const summary: Record<string, number> = {};
  if (summ) {
    const keys = ["saldo_anterior", "creditos", "nuevos_cargos", "pago_no_intereses", "pago_minimo"];
    keys.forEach((k, i) => { summary[k] = parseMoney(summ[i + 1]); });
  }
  const nt = /Nuevas transacciones: ([\d,]+\.\d{2})/.exec(text1);
  if (nt) summary.nuevas_transacciones = parseMoney(nt[1]);
  doc.summary = summary;

  let mode: "txn" | "msi_monthly" | "plans" | "fin" | null = null;
  const block: Pending[] = []; // transacciones pendientes de asignar a un titular
  const closed: Pending[] = [];
  let cur: Pending | null = null;
  const totals: ["holder" | "foreign", string, number][] = [];
  const printed: Record<string, number> = {};
  const postings: Pending[] = [];
  type PlanRow = { desc: string; op: string | null; orig: number; rate: string; saldo: number; n: number; tot: number; monthly: number };
  const plansRows: PlanRow[] = [];
  let curPlan: PlanRow | null = null;

  const finishDate = (t: Pending) => {
    if (t._day && t._month) t.date = parseDate(`${t._day} de ${t._month}`, year, end);
  };
  const flush = (name: string, foreign: boolean) => {
    for (const t of block) {
      t.holder = name;
      if (foreign) t.section = "foreign";
    }
    closed.push(...block);
    block.length = 0;
    cur = null;
  };

  for (const page of pdf.pages) {
    for (const ln of wordLines(pageWords(page), 3)) {
      const top = ln[0].top;
      const txt = wordsText(ln);
      if (txt.startsWith("Fecha y Detalle de las operaciones")) { if (mode !== "msi_monthly") mode = "txn"; continue; }
      if (txt.startsWith("Transacciones de Meses sin Intereses")) { mode = "msi_monthly"; cur = null; continue; }
      // Comisiones y reversos que Amex lista aparte, fuera de los bloques por titular (p. ej. un reembolso "VIVAAEROBUS ONLINE ... CR").
      if (txt.startsWith("Transacciones financieras aplicables")) { mode = "fin"; cur = null; continue; }
      if (txt.startsWith("Consolidado de compras en Meses sin")) { mode = "plans"; curPlan = null; continue; }
      if (txt.startsWith("Paga desde los canales")) { mode = null; continue; }
      if (top < 135 || top > 742) continue;
      if (mode === "txn" || mode === "msi_monthly" || mode === "fin") {
        const amtWords = ln.filter((w) => w.x0 >= 480 && AMT.test(w.str));
        const dateWords = ln.filter((w) => w.x0 < 80);
        const descWords = ln.filter((w) => w.x0 >= 80 && w.x0 < 480);
        const rest = () => wordsText(ln.filter((w) => !amtWords.includes(w)));
        // --- totales
        if (txt.startsWith("Total de las transacciones en $ de")) {
          if (!amtWords.length) { doc.warnings.push("renglon de total sin importe"); continue; }
          const name = rest().replace("Total de las transacciones en $ de", "").trim();
          totals.push(["holder", name, parseMoney(amtWords.at(-1)!.str)]);
          flush(name, false);
          continue;
        }
        if (txt.startsWith("Total de Transacciones en Moneda Extranjera")) {
          if (!amtWords.length) { doc.warnings.push("renglon de total sin importe"); continue; }
          const name = rest().replace(/^Total de Transacciones en Moneda Extranjera de ?/, "").trim();
          totals.push(["foreign", name, parseMoney(amtWords.at(-1)!.str)]);
          flush(name, true);
          continue;
        }
        if (mode === "fin" && txt.startsWith("Total de las transacciones y comisiones")) {
          if (!amtWords.length) { doc.warnings.push("renglon de total sin importe"); continue; }
          // el signo ("CR") llega en el renglón siguiente: se deduce de los propios movimientos al comparar
          printed.fin_total = parseMoney(amtWords.at(-1)!.str);
          flush(totals[0]?.[1] ?? "", false);
          mode = null;
          continue;
        }
        if (txt.startsWith("Total de Meses sin Intereses")) {
          if (amtWords.length) printed.msi_monthly = parseMoney(amtWords.at(-1)!.str);
          mode = null;
          cur = null;
          continue;
        }
        // --- nuevo movimiento (tiene importe a la derecha)
        if (amtWords.length && descWords.length) {
          const { day, month } = dayMonth(dateWords);
          cur = { _day: day, _month: month, _desc: [wordsText(descWords)], _amt: parseMoney(amtWords.at(-1)!.str), _cr: false, _extra: [], ...(mode === "fin" ? { _fin: true } : {}) };
          (mode === "msi_monthly" ? postings : block).push(cur);
          continue;
        }
        if (cur === null) continue;
        // --- continuaciones del movimiento anterior
        const first = ln[0];
        const crWord = ln.some((w) => w.str === "CR" && w.x0 > 530);
        if (first.x0 < 20 && MONTH_NAMES.has(first.str.toLowerCase()) && cur._month === null) {
          cur._month = first.str;
          for (const w of ln.slice(1)) if (w.x0 >= 80) cur._extra.push(w.str);
          if (crWord) cur._cr = true;
          continue;
        }
        if (first.x0 < 20 && /^\d+$/.test(first.str) && cur._day === null) {
          // fecha en la página siguiente al importe (renglón "2 de RFC.. /REF.." o "20 de Dolar ...")
          cur._day = +first.str;
          for (const w of ln) if (w.x0 >= 80) cur._extra.push(w.str);
          continue;
        }
        if (first.x0 >= 80 || first.str === "CR") {
          if (crWord) cur._cr = true;
          for (const w of ln) if (!(w.str === "CR" && w.x0 > 530)) cur._extra.push(w.str);
          continue;
        }
        if (first.x0 < 20 && MONTH_NAMES.has(first.str.toLowerCase())) {
          for (const w of ln.slice(1)) if (w.x0 >= 80) cur._extra.push(w.str);
          if (crWord) cur._cr = true;
        }
      } else if (mode === "plans") {
        const pct = ln.filter((w) => w.str.endsWith("%"));
        if (pct.length) {
          const desc = wordsText(ln.filter((w) => w.x0 < 215));
          const nums = ln.filter((w) => w.x0 >= 295 && AMT.test(w.str));
          const orig = nums.find((w) => w.x0 < 355);
          const saldo = nums.find((w) => w.x0 > 355 && w.x0 < 450);
          const monthly = nums.find((w) => w.x0 >= 500);
          const nm = /(\d+)\s+de ?(\d+)/.exec(ln.filter((w) => w.x0 >= 460 && w.x0 < 510).map((w) => w.str).join(" "));
          if (!orig || !saldo || !monthly || !nm) { doc.warnings.push(`renglon de plan MSI no reconocido: ${txt.slice(0, 60)}`); continue; }
          const { day, month } = dayMonth(ln.filter((w) => w.x0 >= 215 && w.x0 < 280));
          curPlan = {
            desc, op: day && month ? parseDate(`${day} de ${month}`, year, end) : null, orig: parseMoney(orig.str),
            rate: pct[0].str.replace(/%+$/, ""), saldo: parseMoney(saldo.str), n: +nm[1], tot: +nm[2], monthly: parseMoney(monthly.str),
          };
          plansRows.push(curPlan);
          continue;
        }
        if (txt.startsWith("Total de Plan de Meses sin Intereses")) {
          const nums = ln.filter((w) => AMT.test(w.str));
          if (nums.length >= 2) { printed.plan_saldo = parseMoney(nums[0].str); printed.plan_monthly = parseMoney(nums[1].str); }
          mode = null;
          curPlan = null;
          continue;
        }
        if (curPlan !== null && !txt.startsWith("Mensualidad") && !txt.includes("=")) {
          if (ln.every((w) => w.x0 < 215)) curPlan.desc += ` ${txt}`;
          else curPlan = null;
        } else if (txt.includes("=")) curPlan = null;
      }
    }
  }

  // ---- finalizar transacciones
  if (block.length) {
    doc.warnings.push(`${block.length} movimientos sin cerrar por un 'Total ... de <titular>'`);
    doc.checks.push(makeCheck("movimientos asignados a un titular (sin cerrar = 0)", 0, block.length, 0, "count"));
    closed.push(...block);
  }
  for (const r of plansRows) {
    const [merchant, city] = r.desc.startsWith("MESES EN") ? [r.desc, null] : splitAmexCity(r.desc);
    doc.plans.push(makePlan({
      merchant, original_cents: r.orig, pending_cents: r.saldo, monthly_cents: r.monthly, n_current: r.n, n_total: r.tot, rate_pct: r.rate,
      with_interest: false, op_date: r.op, kind: r.desc.startsWith("MESES EN AUTOM") ? "auto_msi" : "purchase", holder: null,
      note: city ? `ciudad: ${city}` : null, raw: r.desc,
    }));
  }

  const build = (t: Pending): Txn => {
    finishDate(t);
    const desc = t._desc.join(" ").replace(/\s+/g, " ").trim();
    const extra = t._extra.join(" ");
    const fm = /D[oó]lar U\.S\.A\. ([\d.]+) TC:([\d.]+)/.exec(extra);
    const foreign = fm ? { currency: "USD", amount: fm[1], fx: fm[2] } : null;
    const rfc = /RFC([A-Z0-9&]+)/.exec(extra);
    const im = /CARGO (\d+) DE ?(\d+)/.exec(extra);
    const inst: Installment | null = im ? { n: +im[1], total: +im[2] } : null;
    const up = desc.toUpperCase();
    let cents = t._amt;
    let note: string | null = null;
    let type: TxnType;
    let merchant: string;
    let city: string | null = null;
    if (t._cr) {
      cents = -cents;
      if (up.startsWith("GRACIAS POR SU PAGO")) type = "payment";
      else if (up.startsWith("MONTO A DIFERIR")) {
        type = "installment_credit";
        note = "neutraliza una compra convertida automaticamente a meses sin intereses";
      } else type = "refund";
      [merchant, city] = type === "refund" ? splitAmexCity(desc) : [desc, null];
    } else {
      type = t._fin ? "fee" : inst ? "installment" : "purchase";
      [merchant, city] = splitAmexCity(desc);
    }
    if (city) note = `ciudad: ${city}`;
    const raw = [desc, ...t._extra, ...(t._cr ? ["CR"] : [])].join(" ");
    const d = makeTxn({
      date: t.date ?? null, merchant, raw, amount_cents: cents, type, holder: t.holder ?? null, section: t.section ?? "regular",
      installment: inst, foreign, note, rfc: rfc ? rfc[1] : null, ...(t._fin ? { statement_section: "financial" } : {}),
    });
    if (inst) d.plan_ref = linkPlan(doc.plans, merchant, Math.abs(cents), inst.n);
    return d;
  };
  doc.transactions = closed.map(build);

  const postingRows: Record<string, unknown>[] = [];
  for (const p of postings) {
    finishDate(p);
    const desc = p._desc.join(" ");
    const im = /CARGO (\d+) DE ?(\d+)/.exec(p._extra.join(" "));
    const inst = im ? { n: +im[1], total: +im[2] } : null;
    postingRows.push({
      date: p.date ?? null, merchant: desc, raw: [desc, ...p._extra].join(" "), amount_cents: p._amt, type: "installment", installment: inst,
      kind: desc.includes("EXTRANJERO") ? "auto_msi_extranjero" : "auto_msi_nacional",
      plan_ref: linkPlan(doc.plans, desc, p._amt, inst ? inst.n : null),
      note: "mensualidad cargada este periodo (Total de Meses sin Intereses); NO es compra nueva",
    });
  }
  if (postingRows.length) doc.installment_postings = postingRows;

  // ---- checks
  const all = doc.transactions;
  totals.forEach(([k, n, c], idx) => {
    const mine = all.filter((t) => t.holder === n && (t.section === "foreign") === (k === "foreign") && t.statement_section !== "financial");
    // el total del bloque = cargos - créditos del propio bloque (reembolsos y "MONTO A DIFERIR"), sin contar los pagos a la tarjeta
    const net = mine.reduce((s, t) => s + (t.type !== "payment" ? t.amount_cents : 0), 0);
    doc.checks.push(makeCheck(`total bloque #${idx + 1} (${k === "foreign" ? "extranjero" : "titular/adicional"}; cargos - creditos, sin pagos)`, c, net));
  });
  const fin = all.filter((t) => t.statement_section === "financial");
  if ("fin_total" in printed) doc.checks.push(makeCheck("total de transacciones y comisiones (sección financiera)", printed.fin_total, Math.abs(fin.reduce((s, t) => s + t.amount_cents, 0))));
  const cred = -all.reduce((s, t) => s + (t.amount_cents < 0 ? t.amount_cents : 0), 0);
  if ("creditos" in summary) doc.checks.push(makeCheck("total creditos (resumen) = pagos + MONTO A DIFERIR + reembolsos", summary.creditos, cred));
  const posted = postings.reduce((s, p) => s + p._amt, 0);
  if ("msi_monthly" in printed) doc.checks.push(makeCheck("Total de Meses sin Intereses (tabla mensual)", printed.msi_monthly, posted));
  const pos = all.reduce((s, t) => s + (t.amount_cents > 0 ? t.amount_cents : 0), 0);
  if ("nuevas_transacciones" in summary) doc.checks.push(makeCheck("Nuevas transacciones = cargos positivos (todos los bloques + extranjero, sin la sección financiera)", summary.nuevas_transacciones, pos - fin.reduce((a, t) => a + Math.max(t.amount_cents, 0), 0)));
  if ("nuevos_cargos" in summary) doc.checks.push(makeCheck("Total Nuevos Cargos = cargos positivos + mensualidades MSI", summary.nuevos_cargos, pos + posted));
  if ("plan_saldo" in printed) {
    doc.checks.push(makeCheck("Total Plan MSI: saldo pendiente (union de paginas)", printed.plan_saldo, doc.plans.reduce((s, p) => s + p.pending_cents, 0)));
    doc.checks.push(makeCheck("Total Plan MSI: monto total a pagar (union de paginas)", printed.plan_monthly, doc.plans.reduce((s, p) => s + p.monthly_cents, 0)));
  }
  return doc;
}
