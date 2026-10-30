import { describe, expect, it } from "vitest";
import { classifyDebitRow, extractBanamexDebit, initials, isCompany, scrubRaw } from "@/lib/pdf/statements/banamex-debit";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import type { PdfWord } from "@/lib/pdf/text";
import { item, pdfOf, row } from "./statements-pdf";

// Estado de la cuenta de débito Banamex INVENTADO: nombres, cuentas y montos ficticios. Saldo inicial 1,000.00.
type R = { date: string; lines: string[]; w?: string; d?: string; bal: string };
const ROWS: R[] = [
  { date: "20 AGO", lines: ["PAGO INTERBANCARIO A BANCO UNO AL BENEF. JUAN,PEREZ/LOPEZ (DATO NO VERIFICADO POR ESTA", "INSTITUCION) CTA.BENEFICIARIO 012345678901234567 CLAVE", "RASTREO 085901234567890123 REF. 0010926 renta MISMO DIA"], w: "300.00", bal: "700.00" },
  { date: "21 AGO", lines: ["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE LUIS EJEMPLO GOMEZ", "CTA.ORDENANTE 0123 REF.1 Transferencia"], d: "150.00", bal: "850.00" },
  { date: "22 AGO", lines: ["DOMI AMERICAN EXPRESS CO", "AUT DOMI 123"], w: "200.00", bal: "650.00" },
  { date: "23 AGO", lines: ["Tienda Online Falsa", "Ciudad Ejemplo", "20260824 1111222233334444 9001/0011"], w: "50.50", bal: "599.50" },
  { date: "24 AGO", lines: ["COMISION MANEJO DE CUENTA"], w: "10.00", bal: "589.50" },
  { date: "24 AGO", lines: ["IVA COMISION MANEJO DE CUENTA"], w: "1.60", bal: "587.90" },
  { date: "25 AGO", lines: ["EXENCION COBRO COMISION IMPORTE A EXENTAR $10.00"], bal: "587.90" },
  { date: "26 AGO", lines: ["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE ANA PRUEBA LOPEZ", "CTA.ORDENANTE 0123 REF.2 Transferencia"], d: "100.00", bal: "687.90" },
  { date: "27 AGO", lines: ["DEPOSITO INVERSION FONDO UNO"], w: "87.90", bal: "600.00" },
];
const page1 = (over: Record<string, string> = {}) => [
  "Estado de Cuenta", "MiCuenta", "ANA PRUEBA LOPEZ",
  "Período del 19 de agosto al 18 de septiembre del 2026",
  "Número de Tarjeta de Débito 1234567812345678",
  over.saldo_anterior ?? "Saldo anterior En pesos M.N. 1,000.00",
  over.dep ?? "(+) 2 Depósitos 250.00",
  over.ret ?? "(-) 6 Retiros/Otros cargos 650.00",
  over.corte ?? "Saldo al Corte 600.00",
  over.com ?? "COMISIONES COBRADAS EN EL PERIODO: 10.00",
].map((l, i) => item(40, 40 + i * 12, l));

const tableRow = (y0: number, r: R): { words: PdfWord[]; next: number } => {
  const words: PdfWord[] = [];
  r.lines.forEach((l, i) => {
    const y = y0 + i * 12;
    words.push(...row(y, ...(i === 0 ? [[30, r.date, { w: 30 }] as [number, string, { w: number }]] : []), [80, l, { w: 250 }]));
    if (i === r.lines.length - 1) {
      if (r.w) words.push(item(350, y, r.w, { w: 50 }));
      if (r.d) words.push(item(440, y, r.d, { w: 50 }));
      words.push(item(520, y, r.bal, { w: 50 }));
    }
  });
  return { words, next: y0 + r.lines.length * 12 };
};
const table = (rows: R[] = ROWS, opts: { tail?: boolean } = {}): PdfWord[] => {
  const words: PdfWord[] = [...row(100, [30, "FECHA"], [100, "CONCEPTO"], [360, "RETIROS"], [440, "DEPOSITOS"], [530, "SALDO"]), ...row(112, [100, "SALDO ANTERIOR"], [520, "1,000.00", { w: 50 }])];
  let y = 124;
  for (const r of rows) { const t = tableRow(y, r); words.push(...t.words); y = t.next; }
  if (opts.tail !== false) words.push(...row(y + 12, [30, "Domiciliaciones y cargos automáticos"], [350, "9,999.99", { w: 50 }])); // no es del detalle
  return words;
};
const build = (rows?: R[], p1?: Record<string, string>, opts?: { shuffle?: boolean }) => pdfOf([page1(p1), table(rows)], opts);

describe("Banamex débito: estado inventado completo", () => {
  const doc = extractBanamexDebit(build());
  it("periodo, tarjeta, nombres y todos los checks", () => {
    expect(doc.document).toBe("debito_stmt");
    expect(doc.card_key).toBe("debito");
    expect(doc.period).toEqual({ start: "2026-08-19", end: "2026-09-18" });
    expect(doc.as_of).toBe("2026-09-18");
    expect(doc.card_last4).toBe("5678");
    expect(doc.checks.map((c) => c.name)).toContain("cadena de saldos (renglones inconsistentes = 0)");
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
    expect(doc.warnings).toEqual([]);
  });
  it("la cadena de saldos decide retiro (+) vs depósito (-) y el tipo sale del concepto", () => {
    const t = doc.transactions;
    expect(t.map((x) => [x.date, x.amount_cents, x.type])).toEqual([
      ["2026-08-20", 30000, "transfer_out"],
      ["2026-08-21", -15000, "income"],
      ["2026-08-22", 20000, "domiciliation_card_payment"],
      ["2026-08-23", 5050, "purchase"],
      ["2026-08-24", 1000, "fee"],
      ["2026-08-24", 160, "fee"],
      ["2026-08-25", 0, "fee"],
      ["2026-08-26", -10000, "transfer_own"],
      ["2026-08-27", 8790, "transfer_own"],
    ]);
    expect(t[0]).toMatchObject({ merchant: "Transferencia SPEI a BANCO UNO", note: "renta", balance_cents: 70000 });
    expect(t[1]).toMatchObject({ note: "ordenante L.E.G." });
    expect(t[2]).toMatchObject({ merchant: "American Express" });
    expect(t[3]).toMatchObject({ merchant: "Tienda Online Falsa", note: "ciudad: Ciudad Ejemplo", post_date: "2026-08-24" });
    expect(t[4]).toMatchObject({ merchant: "Comision manejo de cuenta" });
    expect(t[5]).toMatchObject({ merchant: "IVA comision manejo de cuenta" });
    expect(t[6]).toMatchObject({ merchant: "Exencion cobro comision", amount_cents: 0 });
    expect(t[7].merchant).toBe("Transferencia SPEI recibida de Banco Dos (cuenta propia)"); // el titular se reconoce por el encabezado
    expect(t[8]).toMatchObject({ merchant: "Inversion Fondo Uno", note: "deposito a inversion propia" });
  });
  it("privacidad: cuentas, CLABE y rastreos fuera de raw; personas ajenas con iniciales", () => {
    const raw = doc.transactions[0].raw;
    expect(raw).toContain("J.P.L.");
    expect(raw).not.toMatch(/JUAN|PEREZ|012345678901234567|085901234567890123/);
    expect(doc.transactions[3].raw).not.toContain("1111222233334444");
  });
});

describe("Banamex débito: variantes y bordes", () => {
  it("el orden de los ítems no importa", () => {
    expect(JSON.stringify(extractBanamexDebit(build(undefined, undefined, { shuffle: true })))).toBe(JSON.stringify(extractBanamexDebit(build())));
  });
  it("varias páginas: el detalle continúa en la siguiente (con su encabezado) y 'Domiciliaciones' lo corta", () => {
    const header = (y: number) => row(y, [30, "FECHA"], [100, "CONCEPTO"], [360, "RETIROS"], [530, "SALDO"]);
    const place = (rows: R[], y0: number) => {
      const words: PdfWord[] = [];
      let y = y0;
      for (const r of rows) { const t = tableRow(y, r); words.push(...t.words); y = t.next; }
      return { words, y };
    };
    const first = place(ROWS.slice(0, 5), 124);
    const second = place(ROWS.slice(5), 112);
    const pages = [
      page1(),
      [...header(100), ...row(112, [100, "SALDO ANTERIOR"], [520, "1,000.00", { w: 50 }]), ...first.words],
      [...header(100), ...second.words, ...row(second.y + 12, [30, "Domiciliaciones y cargos automáticos"], [350, "9,999.99", { w: 50 }])],
    ];
    const doc = extractBanamexDebit(pdfOf(pages));
    expect(doc.transactions).toHaveLength(9);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("el importe de la columna no coincide con el cambio de saldo: check fallido y warning", () => {
    const bad = ROWS.map((r, i) => (i === 3 ? { ...r, w: "50.00" } : r)); // la columna dice 50.00 pero el saldo bajó 50.50
    const doc = extractBanamexDebit(build(bad));
    expect(doc.checks.find((c) => c.name.startsWith("cadena de saldos"))).toMatchObject({ ok: false });
    expect(doc.warnings.some((w) => w.startsWith("cadena de saldo"))).toBe(true);
    expect(doc.transactions[3].amount_cents).toBe(5050); // manda el saldo
  });
  it("un depósito que el resumen no cuenta falla los totales", () => {
    const doc = extractBanamexDebit(build(undefined, { dep: "(+) 3 Depósitos 250.00" }));
    expect(doc.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["numero de depositos"]);
  });
  it("estado sin movimientos", () => {
    const doc = extractBanamexDebit(pdfOf([page1({ dep: "(+) 0 Depósitos 0.00", ret: "(-) 0 Retiros/Otros cargos 0.00", corte: "Saldo al Corte 1,000.00", com: "COMISIONES COBRADAS EN EL PERIODO: 0.00" }), table([])]));
    expect(doc.transactions).toEqual([]);
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
  });
  it("renglón sin saldo: warning y la cadena queda marcada", () => {
    const noBal = [...ROWS.slice(0, 2), { date: "22 AGO", lines: ["TRASPASO ENTRE CUENTAS"], w: "10.00", bal: "" }];
    const words = table(noBal as R[]).filter((w) => w.str !== "");
    const doc = extractBanamexDebit(pdfOf([page1(), words]));
    expect(doc.warnings.some((w) => w.startsWith("renglon sin saldo"))).toBe(true);
    expect(doc.checks.find((c) => c.name.startsWith("cadena de saldos"))).toMatchObject({ ok: false });
  });
  it("Python tomaba 'MiCuenta' del texto; aquí el nombre del titular sale del encabezado aunque venga en el mismo renglón que un sello", () => {
    const p1 = page1();
    p1[1] = item(40, 52, "0002696 MiCuenta");
    expect(extractBanamexDebit(pdfOf([p1, table()])).transactions[7].type).toBe("transfer_own");
  });
});

describe("Banamex débito: helpers", () => {
  it("iniciales, razón social y limpieza", () => {
    expect(initials("MARIA,LOPEZ/RUIZ")).toBe("M.L.R.");
    expect(initials("")).toBe("");
    expect(isCompany("DESARROLLOS EJEMPLO SAPI DE CV")).toBe(true);
    expect(isCompany("MARIA,LOPEZ/RUIZ")).toBe(false);
    const s = scrubRaw("PAGO INTERBANCARIO A BANCO UNO AL BENEF. JUAN,PEREZ/LOPEZ (DATO NO VERIFICADO POR ESTA INSTITUCION) CTA.BENEFICIARIO 012345678901234567 CLAVE RASTREO 085901234567890123 REF. 0010926 renta MISMO DIA");
    expect(s).toContain("J.P.L.");
    expect(s).not.toMatch(/012345678901234567|085901234567890123|JUAN/);
    expect(s).toContain("RASTREO:");
  });
  it("classifyDebitRow", () => {
    const own = classifyDebitRow(["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE ANA PRUEBA", "CTA.ORDENANTE 0123 REF.1 Transferencia"], "ANA PRUEBA", false, 1000);
    expect(own.type).toBe("transfer_own");
    const third = classifyDebitRow(["PAGO RECIBIDO DE BANCO DOS POR ORDEN DE LUIS EJEMPLO GOMEZ", "CTA.ORDENANTE 0123 REF.1"], "ANA PRUEBA", false, 1000);
    expect(third.type).toBe("income");
    expect(third.note).toBe("ordenante L.E.G.");
    const fx = classifyDebitRow(["PAGO RECIBIDO DE EMPRESA UNO SA DE CV DIVISA:USD IMPORTE: $1,000.00/TC $17.10 REF.1"], "ANA PRUEBA", false, 1000);
    expect(fx.foreign).toEqual({ currency: "USD", amount: "1000.00", fx: "17.10" });
    expect(classifyDebitRow(["DOMI GIMNASIO FICTICIO", "AUT DOMI 123"], "X", true, 1)).toMatchObject({ type: "domiciliation_other", merchant: "GIMNASIO FICTICIO" });
    expect(classifyDebitRow(["PAGO DE IMPUESTOS FEDERALES"], "X", true, 1).type).toBe("tax");
    expect(classifyDebitRow(["CONCEPTO DESCONOCIDO"], "X", true, 1).type).toBeNull(); // el extractor avisa y asume compra/ingreso
    expect(classifyDebitRow(["Tienda Online Falsa", "20260824 1111222233334444 9001/0011"], "X", false, 900).type).toBe("refund");
  });
});

describe("Banamex débito: detección y validación por index", () => {
  it("se reconoce, no lanza con datos raros y sale validado", () => {
    const pdf = build();
    expect(detectStatement(pdf)).toEqual({ kind: "banamex_debit" });
    const [doc] = extractStatement(pdf);
    expect(doc).toMatchObject({ document: "debito_stmt", card_key: "debito", statement_kind: "banamex_debit" });
    expect(doc.transactions).toHaveLength(9);
  });
  it("concepto sin clasificar: warning y tipo de respaldo", () => {
    const doc = extractBanamexDebit(build([{ date: "20 AGO", lines: ["CONCEPTO RARO"], w: "400.00", bal: "600.00" }], { dep: "(+) 0 Depósitos 0.00", ret: "(-) 1 Retiros/Otros cargos 400.00", com: "COMISIONES COBRADAS EN EL PERIODO: 0.00" }));
    expect(doc.transactions[0].type).toBe("purchase");
    expect(doc.warnings.some((w) => w.startsWith("concepto sin clasificar"))).toBe(true);
  });
});

describe("Banamex débito: resumen de operaciones con tarjeta tras el último renglón", () => {
  it("no toma los importes del resumen como saldo del último movimiento", () => {
    const words = table(ROWS, { tail: false });
    const y = Math.max(...words.map((w) => w.top)) + 24;
    words.push(...row(y, [30, "Resumen Operaciones Tarjeta"]), ...row(y + 12, [80, "TOTAL GENERAL 2"], [520, "168.00", { w: 50 }]));
    const doc = extractBanamexDebit(pdfOf([page1(), words]));
    expect(doc.checks.filter((c) => !c.ok)).toEqual([]);
    expect(doc.transactions.at(-1)).toMatchObject({ amount_cents: 8790 });
  });
});

describe("Banamex débito: pago a una tarjeta de crédito Banamex ('A TB')", () => {
  it("es un pago de tarjeta (no un gasto) y lleva los últimos 4 de la tarjeta", () => {
    const r = classifyDebitRow(["PAGO DE SERVICIO 123456 A TB", "4000111122223333"], "ANA PRUEBA LOPEZ", true, 150_000);
    expect(r).toMatchObject({ type: "domiciliation_card_payment", merchant: "Pago a tarjeta Banamex ···3333" });
  });
  it("el pago de impuestos y las compras con tarjeta de débito siguen igual", () => {
    expect(classifyDebitRow(["PAGO DE SERVICIO 897379 PAGO", "DE IMPUESTOS REFERENCIADO", "S.A.T."], "ANA", true, 1).type).toBe("tax");
    expect(classifyDebitRow(["Tienda Online Falsa", "Ciudad Ejemplo", "20260824 1111222233334444 9001/0011"], "ANA", true, 5050).type).toBe("purchase");
  });
});
