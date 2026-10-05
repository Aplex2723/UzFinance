import { describe, expect, it } from "vitest";
import { classifyNu, extractNu } from "@/lib/pdf/statements/nu";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import { MINUS, linesPdf } from "./statements-pdf";

// Estado de cuenta Nu INVENTADO (nombres, montos y fechas ficticios). Los totales cuadran a propósito: los checks deben pasar.
const HEAD = [
  "Periodo: 16 AGO 2026 al 15 SEP 2026",
  "Fecha de corte: 15 SEP 2026",
  "Producto: Tarjeta de Crédito Nu, Oro",
  "Número de tarjeta: XXXX-XXXX-XXXX-1234",
];
const summary = (fn = " ") => [
  "Cargos regulares (no a meses) + $475.00",
  `Cargos y compras a meses (capital)${fn}7 + $100.00`,
  `Monto de intereses${fn}8 + $20.00`,
  `IVA de intereses y comisiones${fn}9 + $3.20`,
  "Pagos y abonos - $550.00",
];
const PLANS = [
  "COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES",
  "Tarjeta titular: ANA PRUEBA LOPEZ",
  "Fecha de la Descripción Monto Saldo Pago Núm. de Tasa de",
  "01 AGO 2026 Tienda Falsa A Meses - 1/3 $300.00 $200.00 $100.00 1/3 0.00%",
];
const MOVS = [
  "CARGOS, ABONOS Y COMPRAS REGULARES",
  "Tarjeta titular: ANA PRUEBA LOPEZ",
  "17 AGO 2026 17 AGO 2026 Cafe Inventado | RFC: S.I. +$120.00",
  "18 AGO 2026 19 AGO 2026 Tienda Online | RFC: XYZ010101AB1 +$180.00",
  "Tarjeta virtual **** 9876",
  "20 AGO 2026 21 AGO 2026 App Extranjera | RFC: S.I. +$175.00",
  "Cambio (USD 1 = $17.50) USD 10.00",
  "22 AGO 2026 22 AGO 2026 Tienda Falsa A Meses - 1/3 | RFC: S.I. +$100.00",
  "23 AGO 2026 23 AGO 2026 Disposición de saldo en Cuenta Nu - intereses | RFC: S.I. +$20.00",
  "23 AGO 2026 23 AGO 2026 IVA sobre intereses de plan de pagos fijos | RFC: S.I. +$3.20",
  "24 AGO 2026 24 AGO 2026 ¡Grácias por tu pago! | RFC: S.I. -$500.00",
  "25 AGO 2026 25 AGO 2026 Devolución Tienda | RFC: S.I. -$50.00",
  "Abono (compra cancelada)",
  "Total de cargos +$595.00", // el impreso NO incluye el IVA sobre intereses ($3.20)
  "Total de abonos -$550.00",
  "NOTAS ACLARATORIAS",
];
const stmt = (fn?: string) => [...HEAD, ...summary(fn), ...PLANS, ...MOVS];

describe("Nu: estado inventado completo", () => {
  const doc = extractNu(linesPdf([stmt()]));
  it("periodo, corte, tarjeta y nombres de documento", () => {
    expect(doc.document).toBe("nu_stmt");
    expect(doc.card_key).toBe("nu");
    expect(doc.period).toEqual({ start: "2026-08-16", end: "2026-09-15" });
    expect(doc.as_of).toBe("2026-09-15");
    expect(doc.card_last4).toBe("1234");
  });
  it("todos los checks cuadran (incluido el IVA que el total impreso deja fuera)", () => {
    expect(doc.checks.length).toBeGreaterThanOrEqual(7);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("movimientos: tipo, signo, titular, tarjeta virtual y moneda extranjera", () => {
    const t = doc.transactions;
    expect(t).toHaveLength(8);
    expect(t[0]).toMatchObject({ date: "2026-08-17", post_date: "2026-08-17", merchant: "Cafe Inventado", amount_cents: 12000, type: "purchase", holder: "ANA PRUEBA LOPEZ", rfc: null });
    expect(t[1]).toMatchObject({ amount_cents: 18000, holder: "virtual", section: "virtual", rfc: "XYZ010101AB1" });
    expect(t[1].note).toContain("tarjeta virtual **** 9876");
    expect(t[2]).toMatchObject({ amount_cents: 17500, foreign: { currency: "USD", amount: "10.00", fx: "17.50" } });
    expect(t[3]).toMatchObject({ type: "installment", installment: { n: 1, total: 3 }, merchant: "Tienda Falsa A Meses", amount_cents: 10000 });
    expect(t[4]).toMatchObject({ type: "interest", amount_cents: 2000 });
    expect(t[5]).toMatchObject({ type: "interest", amount_cents: 320, note: "IVA sobre intereses de plan de pagos fijos" });
    expect(t[6]).toMatchObject({ type: "payment", amount_cents: -50000 });
    expect(t[7]).toMatchObject({ type: "refund", amount_cents: -5000 });
    expect(t[7].raw).toContain("Abono (compra cancelada)");
  });
  it("plan sin intereses", () => {
    expect(doc.plans).toHaveLength(1);
    expect(doc.plans[0]).toMatchObject({ merchant: "Tienda Falsa A Meses", original_cents: 30000, pending_cents: 20000, monthly_cents: 10000, n_current: 1, n_total: 3, rate_pct: "0.00", with_interest: false, op_date: "2026-08-01", kind: "purchase", holder: "ANA PRUEBA LOPEZ" });
  });
});

describe("Nu: variantes de texto de pdf.js", () => {
  const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  it("la nota al pie pegada a la etiqueta o separada da lo mismo", () => {
    same(extractNu(linesPdf([stmt("")])), extractNu(linesPdf([stmt(" ")])));
    expect(extractNu(linesPdf([stmt("")])).checks.every((c) => c.ok)).toBe(true);
  });
  it("el orden de los ítems no importa", () => {
    same(extractNu(linesPdf([stmt()], { shuffle: true })), extractNu(linesPdf([stmt()])));
  });
  it("varias páginas (los movimientos continúan en la siguiente)", () => {
    const all = stmt();
    const cut = all.indexOf("20 AGO 2026 21 AGO 2026 App Extranjera | RFC: S.I. +$175.00");
    same(extractNu(linesPdf([all.slice(0, cut), all.slice(cut)])), extractNu(linesPdf([all])));
  });
  it("signo menos tipográfico en los abonos", () => {
    const lines = stmt().map((l) => l.replace("-$500.00", `${MINUS}$500.00`));
    expect(extractNu(linesPdf([lines])).transactions.find((t) => t.type === "payment")?.amount_cents).toBe(-50000);
  });
});

describe("Nu: casos de borde", () => {
  it("estado sin movimientos: sin transacciones y sin checks fallidos", () => {
    const doc = extractNu(linesPdf([[...HEAD, "CARGOS, ABONOS Y COMPRAS REGULARES", "Tarjeta titular: ANA PRUEBA LOPEZ", "Total de cargos +$0.00", "Total de abonos -$0.00", "NOTAS ACLARATORIAS"]]));
    expect(doc.transactions).toEqual([]);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("monto 0 se conserva (el importador lo omite)", () => {
    const lines = stmt().flatMap((l) => (l.startsWith("17 AGO") ? [l, "19 AGO 2026 19 AGO 2026 Prueba Cero | RFC: S.I. +$0.00"] : [l]));
    const t = extractNu(linesPdf([lines])).transactions;
    expect(t.find((x) => x.merchant === "Prueba Cero")).toMatchObject({ amount_cents: 0, type: "purchase" });
  });
  it("un total que no cuadra se reporta como check fallido (no lanza)", () => {
    const lines = stmt().map((l) => l.replace("Total de abonos -$550.00", "Total de abonos -$999.00"));
    const doc = extractNu(linesPdf([lines]));
    expect(doc.checks.filter((c) => !c.ok).map((c) => c.name)).toContain("total abonos");
  });
  it("plan con intereses: la descripción ocupa el renglón anterior y el siguiente", () => {
    const lines = [
      ...HEAD,
      "COMPRAS Y CARGOS DIFERIDOS A MESES CON INTERESES",
      "Tarjeta titular: ANA PRUEBA LOPEZ",
      "Disposición de saldo en Cuenta Nu",
      "02 AGO 2026 $1,000.00 $600.00 $20.00 $3.20 $200.00 2/5 28.00%",
      "- 2/5",
    ];
    const p = extractNu(linesPdf([lines])).plans[0];
    expect(p).toMatchObject({ merchant: "Disposición de saldo en Cuenta Nu", kind: "cash_advance", with_interest: true, rate_pct: "28.00", original_cents: 100000, pending_cents: 60000, monthly_cents: 20000, n_current: 2, n_total: 5, interest_cents: 2000, iva_cents: 320 });
  });
  it("classifyNu cubre los tipos", () => {
    expect(classifyNu("¡Grácias por tu pago!", -100)[0]).toBe("payment");
    expect(classifyNu("Tienda Falsa A Meses - 1/3", 31634).slice(0, 3)).toEqual(["installment", { n: 1, total: 3 }, "Tienda Falsa A Meses"]);
    expect(classifyNu("Disposición de saldo en Cuenta Nu - intereses", 100)[0]).toBe("interest");
    expect(classifyNu("Disposición de saldo en Cuenta Nu - 3/3", 100)[0]).toBe("installment");
    expect(classifyNu("IVA sobre intereses de plan de pagos fijos", 100)[0]).toBe("interest");
    expect(classifyNu("Cafe Inventado", 100)[0]).toBe("purchase");
    expect(classifyNu("Cafe Inventado", -100)[0]).toBe("refund");
  });
});

describe("Nu: detección y validación por index", () => {
  it("se reconoce y sale validado con docSchema", () => {
    const pdf = linesPdf([stmt()]);
    expect(detectStatement(pdf)).toEqual({ kind: "nu" });
    const docs = extractStatement(pdf);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ document: "nu_stmt", card_key: "nu", statement_kind: "nu" });
    expect(docs[0].transactions[0].date).toBe("2026-08-17");
  });
});
