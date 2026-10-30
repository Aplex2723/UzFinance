import { describe, expect, it } from "vitest";
import { extractAmex, linkPlan } from "@/lib/pdf/statements/amex";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import type { PdfWord } from "@/lib/pdf/text";
import { item, pdfOf, row, type Cell } from "./statements-pdf";

// Estado de cuenta American Express INVENTADO (nombres, comercios y montos ficticios). Los totales cuadran a propósito.
// Geometría como la del estado real: fecha en x≈14, descripción en x≈86, importe en x≈524, "CR" en x≈540.
const D = 14.4, DESC = 86.4, AMTX = 523.8, CRX = 539.9;
const tx = (y: number, date: string, desc: string, amt: string): PdfWord[] => row(y, [D, date, { w: 60 }], [DESC, desc, { w: 250 }], [AMTX, amt, { w: 30 }]);
const cont = (y: number, ...cells: Cell[]) => row(y, ...cells);
const cr = (y: number) => row(y, [CRX, "CR", { w: 14.5 }]);
const total = (y: number, label: string, amt: string) => row(y, [DESC, label, { w: 300 }], [AMTX, amt, { w: 30 }]);

const PAGE1 = (summaryLine = "500.00 - 520.00 + 552.50 = 532.50 50.00") => [
  "Estado de Cuenta Página 1",
  "Período de Facturación Del 26 de Agosto al 25 de Septiembre de 2026 Días del periodo: 31 días",
  "Número de Cuenta 3401-123456-12345 ANA PRUEBA LOPEZ",
  summaryLine,
  "Nuevas transacciones: 452.50",
].map((l, i) => item(40, 40 + i * 12, l));

const PAGE2 = (): PdfWord[] => [
  ...row(150, [D, "Fecha y Detalle de las operaciones"]),
  ...tx(162, "28 de Agosto", "GRACIAS POR SU PAGO EN LINEA", "500.00"), ...cr(174),
  ...tx(186, "30 de Agosto", "TIENDA FICTICIA MEXICO CITY", "150.00"), ...cont(198, [DESC, "RFCABC010101AB1 /REF123", { w: 120 }]),
  ...tx(210, "31 de Agosto", "TIENDA PLAN MSI MEXICO CITY", "100.00"), ...cont(222, [DESC, "CARGO 01 DE 03", { w: 70 }]),
  // la fecha se parte en dos renglones: "1 de" arriba y "Septiembre" abajo
  ...tx(234, "1 de", "OTRA TIENDA WEB MERIDA YUC", "80.00"), ...cont(246, [D, "Septiembre", { w: 50 }], [DESC, "RFCDEF020202CD2 /REFxyz", { w: 120 }]),
  // este movimiento llega sin fecha: la fecha cae en la página siguiente
  ...row(258, [DESC, "CAFE SIN FECHA", { w: 100 }], [AMTX, "45.00", { w: 30 }]),
];
const PAGE3 = (): PdfWord[] => [
  ...cont(150, [D, "2 de", { w: 15 }], [DESC, "RFCGHI030303EF3 /REF111", { w: 120 }]), ...cont(162, [D, "Septiembre", { w: 50 }]),
  ...tx(174, "3 de Septiembre", "DEVOLUCION TIENDA FICTICIA", "20.00"), ...cr(186),
  ...total(198, "Total de las transacciones en $ de ANA PRUEBA LOPEZ", "355.00"),
  ...tx(210, "5 de Septiembre", "COMPRA ADICIONAL SA DE CV", "60.00"),
  ...total(222, "Total de las transacciones en $ de LUIS ADICIONAL", "60.00"),
  ...tx(234, "6 de Septiembre", "APP EXTRANJERA AMSTERDAM", "17.50"), ...cont(246, [DESC, "Dólar U.S.A. 1.00 TC:17.50", { w: 120 }]),
  ...total(258, "Total de Transacciones en Moneda Extranjera de LUIS ADICIONAL", "17.50"),
  ...row(280, [D, "Transacciones de Meses sin Intereses"]),
  ...tx(292, "26 de Agosto", "MESES EN AUTOMATICO NACIONAL", "100.00"), ...cont(304, [DESC, "CARGO 01 DE03", { w: 70 }]),
  ...total(316, "Total de Meses sin Intereses", "100.00"),
  ...row(340, [D, "Consolidado de compras en Meses sin Intereses"]),
  ...row(352, [D, "MESES EN AUTOMATICO NACIONAL", { w: 180 }], [230, "26 de Agosto", { w: 50 }], [300, "300.00", { w: 35 }], [380, "200.00", { w: 35 }], [430, "0.00%", { w: 30 }], [470, "1 de 3", { w: 30 }], [520, "100.00", { w: 35 }]),
  ...row(364, [D, "TIENDA PLAN MSI MEXICO CITY", { w: 180 }], [230, "31 de Agosto", { w: 50 }], [300, "300.00", { w: 35 }], [380, "200.00", { w: 35 }], [430, "0.00%", { w: 30 }], [470, "1 de 3", { w: 30 }], [520, "100.00", { w: 35 }]),
  ...row(376, [D, "Total de Plan de Meses sin Intereses"], [380, "400.00", { w: 35 }], [520, "200.00", { w: 35 }]),
  ...row(400, [D, "Paga desde los canales digitales"]),
];
const build = (opts: { shuffle?: boolean; summary?: string } = {}) => pdfOf([PAGE1(opts.summary), PAGE2(), PAGE3()], opts);

describe("Amex: estado inventado completo", () => {
  const doc = extractAmex(build());
  it("periodo, cuenta y resumen", () => {
    expect(doc.document).toBe("amex_stmt");
    expect(doc.card_key).toBe("amex");
    expect(doc.period).toEqual({ start: "2026-08-26", end: "2026-09-25" });
    expect(doc.as_of).toBe("2026-09-25");
    expect(doc.card_last5).toBe("12345");
    expect(doc.summary).toEqual({ saldo_anterior: 50000, creditos: 52000, nuevos_cargos: 55250, pago_no_intereses: 53250, pago_minimo: 5000, nuevas_transacciones: 45250 });
  });
  it("todos los checks cuadran", () => {
    expect(doc.checks.length).toBeGreaterThanOrEqual(8);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
    expect(doc.warnings).toEqual([]);
  });
  it("movimientos: la fecha partida en dos renglones/páginas, CR, ciudad, RFC, titular y moneda extranjera", () => {
    const t = doc.transactions;
    expect(t.map((x) => [x.date, x.merchant, x.amount_cents, x.type, x.holder, x.section])).toEqual([
      ["2026-08-28", "GRACIAS POR SU PAGO EN LINEA", -50000, "payment", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-08-30", "TIENDA FICTICIA", 15000, "purchase", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-08-31", "TIENDA PLAN MSI", 10000, "installment", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-09-01", "OTRA TIENDA WEB", 8000, "purchase", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-09-02", "CAFE SIN FECHA", 4500, "purchase", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-09-03", "DEVOLUCION TIENDA FICTICIA", -2000, "refund", "ANA PRUEBA LOPEZ", "regular"],
      ["2026-09-05", "COMPRA ADICIONAL SA DE CV", 6000, "purchase", "LUIS ADICIONAL", "regular"],
      ["2026-09-06", "APP EXTRANJERA AMSTERDAM", 1750, "purchase", "LUIS ADICIONAL", "foreign"],
    ]);
    expect(t[1]).toMatchObject({ note: "ciudad: MEXICO CITY", rfc: "ABC010101AB1" });
    expect(t[1].raw).toBe("TIENDA FICTICIA MEXICO CITY RFCABC010101AB1 /REF123");
    expect(t[2]).toMatchObject({ installment: { n: 1, total: 3 }, plan_ref: { merchant: "TIENDA PLAN MSI", original_cents: 30000 } });
    expect(t[3]).toMatchObject({ note: "ciudad: MERIDA YUC", rfc: "DEF020202CD2" });
    expect(t[7]).toMatchObject({ foreign: { currency: "USD", amount: "1.00", fx: "17.50" } });
  });
  it("planes y mensualidades del periodo (no son compras nuevas)", () => {
    expect(doc.plans).toHaveLength(2);
    expect(doc.plans[0]).toMatchObject({ merchant: "MESES EN AUTOMATICO NACIONAL", kind: "auto_msi", original_cents: 30000, pending_cents: 20000, monthly_cents: 10000, n_current: 1, n_total: 3, rate_pct: "0.00", op_date: "2026-08-26", with_interest: false });
    expect(doc.plans[1]).toMatchObject({ merchant: "TIENDA PLAN MSI", kind: "purchase", note: "ciudad: MEXICO CITY", op_date: "2026-08-31" });
    const postings = doc.installment_postings as Record<string, unknown>[];
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ date: "2026-08-26", amount_cents: 10000, installment: { n: 1, total: 3 }, kind: "auto_msi_nacional", plan_ref: { merchant: "MESES EN AUTOMATICO NACIONAL", original_cents: 30000 } });
    expect(doc.transactions.some((x) => x.merchant.startsWith("MESES EN AUTOMATICO"))).toBe(false);
  });
});

describe("Amex: variantes y bordes", () => {
  const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  it("el orden de los ítems no importa", () => {
    same(extractAmex(build({ shuffle: true })), extractAmex(build()));
  });
  it("la fecha pegada ('deAgosto') o con espacio ('de Agosto') da lo mismo", () => {
    const glued = (pdf: ReturnType<typeof build>) => ({ ...pdf, pages: pdf.pages.map((p) => ({ ...p, words: p.words.map((w) => ({ ...w, str: /^\d+ de [A-Z]/.test(w.str) ? w.str.replace(" de ", " de") : w.str })) })) });
    same(extractAmex(glued(build())).transactions, extractAmex(build()).transactions);
  });
  it("un total de bloque que no cuadra falla el check de ese bloque", () => {
    const pdf = build();
    pdf.pages[2].words = pdf.pages[2].words.map((w) => (w.str === "355.00" ? { ...w, str: "999.00" } : w));
    const doc = extractAmex(pdf);
    expect(doc.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["total bloque #1 (titular/adicional; cargos - creditos, sin pagos)"]);
  });
  it("movimientos sin 'Total ... de <titular>' que los cierre: warning y check fallido (no lanza)", () => {
    const pdf = build();
    pdf.pages[2].words = pdf.pages[2].words.filter((w) => !w.str.startsWith("Total de Transacciones en Moneda Extranjera"));
    const doc = extractAmex(pdf);
    expect(doc.warnings.some((w) => /sin cerrar/.test(w))).toBe(true);
    expect(doc.checks.some((c) => !c.ok)).toBe(true);
    expect(doc.transactions).toHaveLength(8);
  });
  it("estado sin movimientos", () => {
    const empty = pdfOf([PAGE1("500.00 - 500.00 + 0.00 = 0.00 0.00"), [...row(150, [D, "Fecha y Detalle de las operaciones"]), ...row(162, [DESC, "Total de las transacciones en $ de ANA PRUEBA LOPEZ", { w: 300 }], [AMTX, "0.00", { w: 30 }])]]);
    const doc = extractAmex(empty);
    expect(doc.transactions).toEqual([]);
    expect(doc.plans).toEqual([]);
    expect(doc.installment_postings).toBeUndefined();
  });
  it("linkPlan: mensualidad ±5 centavos y palabra en común", () => {
    const plans = [
      { merchant: "TIENDA UNO MX MSI", original_cents: 47310, monthly_cents: 15770, n_current: 2 },
      { merchant: "OTRA TIENDA WEB", original_cents: 344644, monthly_cents: 114882, n_current: 1 },
    ];
    expect(linkPlan(plans, "TIENDA UNO MX MSI (MKT)", 15770)?.original_cents).toBe(47310);
    expect(linkPlan(plans, "OTRA TIENDA WEB", 114879)?.original_cents).toBe(344644); // tolerancia de 5 centavos
    expect(linkPlan(plans, "OTRA TIENDA WEB", 114900)).toBeNull();
    expect(linkPlan(plans, "OTRA TIENDA WEB", 114882, 2)).toBeNull();
  });
});

describe("Amex: detección y validación por index", () => {
  it("se reconoce y sale validado con docSchema", () => {
    const pdf = pdfOf([[...PAGE1(), item(40, 120, "American Express Company (México)")], PAGE2(), PAGE3()]);
    expect(detectStatement(pdf)).toEqual({ kind: "amex" });
    const [doc] = extractStatement(pdf);
    expect(doc).toMatchObject({ document: "amex_stmt", card_key: "amex", statement_kind: "amex" });
    expect(doc.checks.every((c) => c.ok)).toBe(true);
    expect(doc.installment_postings).toHaveLength(1);
  });
});

describe("Amex: sección 'Transacciones financieras' fuera de los bloques por titular", () => {
  // Reembolso de 8.00 (CR), comisión de 0.01 y su reverso (CR): neto 8.00 a favor, como "Total de las transacciones y comisiones 8.00 CR".
  const FIN = (): PdfWord[] => [
    ...row(430, [D, "Transacciones financieras aplicables a la Cuenta Básica"]),
    ...tx(442, "8 de Septiembre", "AEROLINEA FICTICIA ONLINE", "8.00"), ...cr(454),
    ...tx(466, "9 de Septiembre", "SERVICIO DE FACTURACION POR REDENCION", "0.01"),
    ...tx(478, "9 de Septiembre", "REVERSION CARGO SERVICIO DE FACTURACION", "0.01"), ...cr(490),
    ...total(502, "Total de las transacciones y comisiones", "8.00"), ...cr(514),
    ...total(526, "Total de IVA sobre transacciones y comisiones", "0.00"),
  ];
  const page1 = () => PAGE1("500.00 - 528.01 + 552.51 = 524.50 50.00");
  const doc = extractAmex(pdfOf([page1(), PAGE2(), [...PAGE3(), ...FIN()]]));
  it("se leen como comisión y reembolsos del titular y todos los checks cuadran", () => {
    expect(doc.warnings).toEqual([]);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
    const fin = doc.transactions.filter((t) => t.statement_section === "financial");
    expect(fin.map((t) => [t.type, t.amount_cents])).toEqual([["refund", -800], ["fee", 1], ["refund", -1]]);
    expect(fin.every((t) => t.holder === "ANA PRUEBA LOPEZ")).toBe(true);
  });
});
