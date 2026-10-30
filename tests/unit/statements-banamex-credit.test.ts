import { describe, expect, it } from "vitest";
import { banamexCreditKey, classifyBanamexCredit, extractBanamexCredit } from "@/lib/pdf/statements/banamex-credit";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import { linesPdf } from "./statements-pdf";

// Estado de tarjeta de crédito Banamex INVENTADO. Totales cuadrados a propósito: los checks deben pasar.
const head = (product = "ORO FICTICIA BANAMEX") => [
  "Estado de Cuenta Mensual",
  "Tarjeta de Crédito",
  "Periodo: 19-ago-2026 al 18-sep-2026",
  "Fecha de corte: 18-sep-2026",
  `Tarjeta de Crédito ${product} Número de días en el periodo: 31 días`,
  "Número de tarjeta 4000 1111 2222 3333",
];
const summary = (fn = "") => [
  "Adeudo del periodo anterior = $1,000.00",
  "Cargos regulares (no a meses) + $684.50",
  `Cargos compras a meses (capital)${fn}7 + $300.00`,
  `Monto de Intereses${fn}8 + $10.00`,
  "Monto de comisiones + $100.00",
  `IVA de Intereses y comisiones${fn}9 + $17.60`,
  "Pagos y abonos - $1,050.00",
  `Pago para no generar intereses:${fn}2 $1,200.00`,
];
const PLANS = [
  "COMPRAS Y CARGOS DIFERIDOS A MESES",
  "Tarjeta titular: ANA PRUEBA LOPEZ",
  "12-jul-2026 TIENDA UNO MERIDA XYZ830101AB1 $2,400.00 $1,200.00 $200.00 6 de 12 NA",
  "A PAGAR EN 6 MESES",
  "05-ago-2026 DISP. EFECTIVO CAJERO $1,000.00 $800.00 $100.00 1 de 10 36.50%",
];
const REGULAR = [
  "CARGOS, ABONOS Y COMPRAS REGULARES",
  "Tarjeta titular: ANA PRUEBA LOPEZ",
  "20-ago-2026 21-ago-2026 CAFE LUNA CENTRO XYZ 250515CC7 + $85.50",
  "22-ago-2026 23-ago-2026 TIENDA UNO MERIDA 006 de 012 + $200.00",
  "25-ago-2026 26-ago-2026 0123 SUPER EJEMPLO DISP. EFECTIVMX + $500.00",
  "01-sep-2026 02-sep-2026 SU ABONO...GRACIAS - $1,000.00",
  "03-sep-2026 04-sep-2026 TIENDA UNO SUR 123456789MX - $50.00",
  "27-ago-2026 28-ago-2026 DISP. EFECTIVO CAJERO 001 de 010 + $100.00",
  "Tarjeta digital: 4000 1111 2222 9999",
  "05-sep-2026 06-sep-2026 MERPAGO*TIENDAFAKE MAG 2105031W3MX + $99.00",
  "10-sep-2026 10-sep-2026 COMISION ANUALIDAD + $100.00",
  "10-sep-2026 10-sep-2026 IVA COMISION ANUALIDAD + $16.00",
  "11-sep-2026 11-sep-2026 INTERES GRAVABLE + $10.00",
  "11-sep-2026 11-sep-2026 IVA POR INTERESES + $1.60",
  "Total cargos + $1,112.10",
  "Total abonos - $1,050.00",
];
const stmt = (fn?: string, product?: string) => [...head(product), ...summary(fn), ...PLANS, ...REGULAR];

describe("Banamex crédito: estado inventado completo", () => {
  const doc = extractBanamexCredit(linesPdf([stmt()]));
  it("producto -> document/card_key por contenido, periodo y tarjeta", () => {
    expect(doc.document).toBe("oro_ficticia_stmt");
    expect(doc.card_key).toBe("oro_ficticia");
    expect(doc.period).toEqual({ start: "2026-08-19", end: "2026-09-18" });
    expect(doc.as_of).toBe("2026-09-18");
    expect(doc.card_last4).toBe("3333");
    expect(doc.card_bin8).toBe("40001111");
  });
  it("todos los checks cuadran", () => {
    expect(doc.checks.length).toBeGreaterThanOrEqual(7);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("movimientos: signo, tipo, titular/digital, mensualidad, RFC fuera del comercio", () => {
    const t = doc.transactions;
    expect(t).toHaveLength(11);
    expect(t[0]).toMatchObject({ date: "2026-08-20", post_date: "2026-08-21", merchant: "CAFE LUNA CENTRO", amount_cents: 8550, type: "purchase", holder: "titular", section: "regular", raw: "CAFE LUNA CENTRO XYZ 250515CC7" });
    expect(t[1]).toMatchObject({ type: "installment", installment: { n: 6, total: 12 }, merchant: "TIENDA UNO MERIDA", amount_cents: 20000 });
    expect(t[2]).toMatchObject({ type: "cash_withdrawal", merchant: "SUPER EJEMPLO", note: "disposicion de efectivo", amount_cents: 50000 });
    expect(t[3]).toMatchObject({ type: "payment", amount_cents: -100000 });
    expect(t[4]).toMatchObject({ type: "refund", amount_cents: -5000, merchant: "TIENDA UNO" });
    expect(t[5]).toMatchObject({ type: "installment", installment: { n: 1, total: 10 }, merchant: "DISP. EFECTIVO CAJERO" });
    expect(t[6]).toMatchObject({ merchant: "MERPAGO*TIENDAFAKE", holder: "digital", section: "digital" });
    expect(t.slice(7).map((x) => x.type)).toEqual(["fee", "fee", "interest", "interest"]);
  });
  it("planes: el op_date es el del ÚLTIMO cargo y el diferido trae su nota", () => {
    expect(doc.plans).toHaveLength(2);
    expect(doc.plans[0]).toMatchObject({ merchant: "TIENDA UNO MERIDA", original_cents: 240000, pending_cents: 120000, monthly_cents: 20000, n_current: 6, n_total: 12, rate_pct: "0.00", with_interest: false, op_date: "2026-07-12", kind: "purchase", holder: "titular", op_date_is_latest_installment: true, note: "A PAGAR EN 6 MESES" });
    expect(doc.plans[1]).toMatchObject({ kind: "cash_advance", with_interest: true, rate_pct: "36.50", n_current: 1, n_total: 10 });
  });
});

describe("Banamex crédito: variantes y bordes", () => {
  const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  it("nota al pie pegada o separada, ítems barajados, varias páginas", () => {
    const base = extractBanamexCredit(linesPdf([stmt("")]));
    same(extractBanamexCredit(linesPdf([stmt(" ")])), base);
    same(extractBanamexCredit(linesPdf([stmt("")], { shuffle: true })), base);
    const all = stmt("");
    const cut = all.indexOf("Tarjeta digital: 4000 1111 2222 9999");
    same(extractBanamexCredit(linesPdf([all.slice(0, cut), all.slice(cut)])), base);
    expect(base.checks.every((c) => c.ok)).toBe(true);
  });
  it("monto con espacios entre cifras (texto de pdf.js) y signo menos tipográfico", () => {
    const lines = stmt().map((l) => l.replace("+ $85.50", "+ $ 8 5 . 5 0").replace("- $1,050.00", `- $ 1 , 0 5 0 . 0 0`));
    const doc = extractBanamexCredit(linesPdf([lines]));
    expect(doc.transactions[0].amount_cents).toBe(8550);
  });
  it("estado sin movimientos: no hay transacciones ni checks fallidos", () => {
    const doc = extractBanamexCredit(linesPdf([[...head(), "CARGOS, ABONOS Y COMPRAS REGULARES", "Tarjeta titular: ANA PRUEBA LOPEZ", "Total cargos + $0.00", "Total abonos - $0.00"]]));
    expect(doc.transactions).toEqual([]);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("falta el 'Total cargos': warning (no lanza)", () => {
    const doc = extractBanamexCredit(linesPdf([stmt().filter((l) => !l.startsWith("Total cargos"))]));
    expect(doc.warnings).toContain("no se encontro 'Total cargos'");
  });
  it("un total impreso que no cuadra falla el check", () => {
    const doc = extractBanamexCredit(linesPdf([stmt().map((l) => l.replace("Total cargos + $1,112.10", "Total cargos + $1,500.00"))]));
    expect(doc.checks.find((c) => c.name === "total cargos")).toMatchObject({ ok: false, expected_cents: 150000, actual_cents: 111210 });
  });
  it("clave por producto: Explora y Costco conservan sus nombres de siempre", () => {
    expect(banamexCreditKey(head("EXPLORA BANAMEX"))).toEqual({ product: "EXPLORA BANAMEX", key: "explora" });
    expect(banamexCreditKey(head("COSTCO BANAMEX"))).toEqual({ product: "COSTCO BANAMEX", key: "costco" });
    expect(banamexCreditKey(head("Clásica Banamex")).key).toBe("clasica");
    expect(banamexCreditKey(["sin producto"])).toEqual({ product: null, key: "banamex" });
    expect(extractBanamexCredit(linesPdf([stmt("", "EXPLORA BANAMEX")])).document).toBe("explora_stmt");
    expect(extractBanamexCredit(linesPdf([stmt("", "COSTCO BANAMEX")])).card_key).toBe("costco");
  });
  it("classifyBanamexCredit", () => {
    expect(classifyBanamexCredit("SU ABONO...GRACIAS", -100)[0]).toBe("payment");
    expect(classifyBanamexCredit("COMISION ADMINISTRACION TARJETA TITULAR", 100)[0]).toBe("fee");
    expect(classifyBanamexCredit("IVA COMISION ADMINISTRACION", 16)[0]).toBe("fee");
    expect(classifyBanamexCredit("INTERES GRAVABLE", 10)[0]).toBe("interest");
    expect(classifyBanamexCredit("IVA POR INTERESES Y/O COMISIONES", 10)[0]).toBe("interest");
    expect(classifyBanamexCredit("TIENDA UNO MERIDA 012 de 024", 100)).toEqual(["installment", { n: 12, total: 24 }, "TIENDA UNO MERIDA"]);
    expect(classifyBanamexCredit("0123 SUPER EJEMPLO DISP. EFECTIVMX", 250000)[0]).toBe("cash_withdrawal");
    expect(classifyBanamexCredit("TIENDA UNO 123456789MX", -5000)[0]).toBe("refund");
    expect(classifyBanamexCredit("TIENDA UNO 123456789MX", 5000)[0]).toBe("purchase");
  });
});

describe("Banamex crédito: detección y validación por index", () => {
  it("se reconoce y sale validado", () => {
    const pdf = linesPdf([stmt("", "EXPLORA BANAMEX")]);
    expect(detectStatement(pdf)).toEqual({ kind: "banamex_credit" });
    const [doc] = extractStatement(pdf);
    expect(doc).toMatchObject({ document: "explora_stmt", card_key: "explora", statement_kind: "banamex_credit" });
    expect(doc.checks.every((c) => c.ok)).toBe(true);
  });
  it("sin periodo: se deduce de los movimientos y queda un check fallido (para revisión)", () => {
    const lines = stmt().filter((l) => !l.startsWith("Periodo:") && !l.startsWith("Fecha de corte"));
    const [doc] = extractStatement(linesPdf([lines]), "banamex_credit");
    expect(doc.period).toEqual({ start: "2026-08-20", end: "2026-09-11" });
    expect(doc.as_of).toBe("2026-09-11");
    expect(doc.checks.some((c) => !c.ok && /periodo/.test(c.name))).toBe(true);
  });
});

describe("Banamex crédito: puntos sueltos del pie de página", () => {
  it("un '..' pegado al último importe de la página no tumba la extracción", () => {
    const lines = stmt();
    const i = lines.findIndex((l) => l.startsWith("11-sep-2026 11-sep-2026 IVA POR INTERESES"));
    lines[i] = `${lines[i]} ..`;
    const doc = extractBanamexCredit(linesPdf([lines]));
    expect(doc.warnings).toEqual([]);
    expect(doc.transactions).toHaveLength(11);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
});
