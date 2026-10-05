import { describe, expect, it } from "vitest";
import { reconcile } from "@/lib/recon/engine";
import type { AppRow, ReconDoc, ReconFinding, StmtLine } from "@/lib/recon/types";

// Todo inventado. Periodo de ejemplo: 2026-08-19 .. 2026-09-18 (cola = 16..18 sep; antes del inicio: desde el 15 ago).
const period = { start: "2026-08-19", end: "2026-09-18" };
const TODAY = "2026-10-04";

const line = (date: string, merchant: string, amount_cents: number, o: Partial<StmtLine> = {}): StmtLine => ({ date, merchant, amount_cents, type: "purchase", ...o });
let nextId = 1;
const row = (date: string, merchant: string, cents: number, o: Partial<AppRow> = {}): AppRow => ({ id: nextId++, date, cents, merchant, kind: "expense", source: "shortcut", ...o });
const run = (transactions: StmtLine[], appRows: AppRow[], o: { period?: ReconDoc["period"]; checks?: ReconDoc["checks"] } = {}) =>
  reconcile({ doc: { period: o.period ?? period, transactions, checks: o.checks }, appRows, today: TODAY });
const kinds = (fs: ReconFinding[]) => fs.map((f) => f.kind);
const by = (fs: ReconFinding[], kind: string) => fs.filter((f) => f.kind === kind);

describe("conciliación: lo que cuadra", () => {
  it("todo conciliado: sin hallazgos y con totales iguales", () => {
    nextId = 1;
    const r = run([line("2026-08-20", "CAFE UNO", 9_500), line("2026-09-02", "TIENDA DOS", 120_000)], [row("2026-08-20", "CAFE UNO", 9_500), row("2026-09-02", "TIENDA DOS", 120_000)]);
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ statementCount: 2, appCount: 2, matched: 2, diffCents: 0, unexplainedCents: 0, statementCents: 129_500 });
    expect(r.trusted).toBe(true);
    expect(r.matches).toHaveLength(2);
  });

  it("compras idénticas legítimas del mismo día (N en el estado, N en la app) concilian sin alarma", () => {
    nextId = 1;
    const l = [line("2026-09-01", "CAFE UNO", 5_000), line("2026-09-01", "CAFE UNO", 5_000), line("2026-09-01", "CAFE UNO", 5_000)];
    const rows = [row("2026-09-01", "Cafe Uno", 5_000), row("2026-09-01", "Cafe Uno", 5_000, { source: "email", occurredAt: "2026-09-01T18:00:30Z" }), row("2026-09-01", "Cafe Uno", 5_000, { source: "manual", occurredAt: "2026-09-01T18:03:00Z" })];
    const r = run(l, rows);
    expect(r.findings).toEqual([]);
    expect(r.summary.matched).toBe(3);
  });

  it("el comercio del Atajo y el del banco casi nunca coinciden: el monto manda", () => {
    nextId = 1;
    const r = run([line("2026-09-05", "AMZN MKTP MX*2H4K9", 45_900)], [row("2026-09-05", "Amazon", 45_900)]);
    expect(r.findings).toEqual([]);
  });

  it("estado sin movimientos y app sin filas", () => {
    nextId = 1;
    expect(run([], [])).toMatchObject({ findings: [], summary: { statementCount: 0, appCount: 0, diffCents: 0 } });
    const r = run([], [row("2026-09-05", "X", 1_000)]);
    expect(kinds(r.findings)).toEqual(["not_in_statement", "total_mismatch"]);
    const r2 = run([line("2026-09-05", "X", 1_000)], []);
    expect(kinds(r2.findings)).toEqual(["missing_in_app", "total_mismatch"]);
    expect(by(r2.findings, "total_mismatch")[0].severity).toBe("info");
  });

  it("filas de la app importadas de este mismo estado (source=statement) concilian trivialmente", () => {
    nextId = 1;
    const r = run([line("2026-08-20", "CAFE UNO", 9_500), line("2026-08-23", "REEMBOLSO", -5_000, { type: "refund" })], [
      row("2026-08-20", "CAFE UNO", 9_500, { source: "statement" }), row("2026-08-23", "REEMBOLSO", -5_000, { source: "statement" }),
    ]);
    expect(r.findings).toEqual([]);
  });

  it("reembolsos y abonos (negativos) se emparejan con filas negativas, no con cargos del mismo valor absoluto", () => {
    nextId = 1;
    const ok = run([line("2026-09-03", "TIENDA", -7_000, { type: "refund" })], [row("2026-09-03", "TIENDA", -7_000)]);
    expect(ok.findings).toEqual([]);
    const bad = run([line("2026-09-03", "TIENDA", -7_000, { type: "refund" })], [row("2026-09-03", "TIENDA", 7_000)]);
    expect(kinds(bad.findings)).toContain("missing_in_app");
    expect(kinds(bad.findings)).toContain("not_in_statement");
  });
});

describe("ventana de fechas y emparejamiento", () => {
  it("±3 días concilia (fecha de operación vs. registro del Atajo); 4 días no", () => {
    nextId = 1;
    expect(run([line("2026-09-05", "X", 3_300)], [row("2026-09-08", "X", 3_300)]).findings).toEqual([]);
    expect(run([line("2026-09-05", "X", 3_300)], [row("2026-09-02", "X", 3_300)]).findings).toEqual([]);
    const r = run([line("2026-09-05", "X", 3_300)], [row("2026-09-09", "X", 3_300)]);
    expect(kinds(r.findings)).toEqual(expect.arrayContaining(["missing_in_app", "not_in_statement"]));
  });

  it("cambio de mes y de año en la ventana", () => {
    nextId = 1;
    const p = { start: "2026-12-10", end: "2027-01-09" };
    expect(run([line("2026-12-31", "X", 2_000)], [row("2027-01-02", "X", 2_000)], { period: p }).findings).toEqual([]);
    expect(run([line("2027-01-01", "X", 2_000), line("2026-12-30", "Y", 3_000)], [row("2026-12-29", "X", 2_000), row("2027-01-02", "Y", 3_000)], { period: p }).findings.filter((f) => f.kind !== "total_mismatch")).toEqual([]);
  });

  it("asignación óptima: una línea no se queda sin pareja porque otra le robó la fila", () => {
    nextId = 1;
    // L1 (10) y L2 (11); filas A (11) y B (14). Un voraz por fecha empareja L2-A y deja L1 y B sin pareja.
    const r = run([line("2026-09-10", "X", 4_000), line("2026-09-11", "X", 4_000)], [row("2026-09-11", "X", 4_000), row("2026-09-14", "X", 4_000)]);
    expect(r.findings).toEqual([]);
    expect(r.matches).toHaveLength(2);
  });

  it("nunca consume una fila de la app dos veces", () => {
    nextId = 1;
    const r = run([line("2026-09-10", "X", 4_000), line("2026-09-10", "X", 4_000)], [row("2026-09-10", "X", 4_000)]);
    expect(r.matches).toHaveLength(1);
    expect(by(r.findings, "missing_in_app")).toHaveLength(1);
  });

  it("empates de monto: primero fecha exacta; el comercio solo desempata", () => {
    nextId = 1;
    const a = row("2026-09-10", "TIENDA B", 5_000);
    const b = row("2026-09-10", "CAFE A", 5_000);
    const r = run([line("2026-09-10", "CAFE A", 5_000), line("2026-09-10", "TIENDA B", 5_000)], [a, b]);
    expect(r.matches).toEqual([{ lineIndex: 0, rowId: b.id }, { lineIndex: 1, rowId: a.id }]);
    // La fecha manda sobre el comercio: la fila del mismo día gana aunque el nombre no se parezca.
    const near = row("2026-09-11", "CAFE A", 5_000);
    const exact = row("2026-09-10", "OTRO", 5_000);
    const r2 = run([line("2026-09-10", "CAFE A", 5_000)], [near, exact]);
    expect(r2.matches).toEqual([{ lineIndex: 0, rowId: exact.id }]);
  });

  it("una línea del estado fechada antes del inicio del periodo (fecha de operación) concilia igual", () => {
    nextId = 1;
    const r = run([line("2026-08-17", "TIENDA", 8_800)], [row("2026-08-18", "TIENDA", 8_800)]);
    expect(r.findings.filter((f) => f.kind !== "total_mismatch")).toEqual([]);
  });
});

describe("missing_in_app", () => {
  it("warn con datos importables; high si el monto es grande o es una compra reciente-grande", () => {
    nextId = 1;
    const r = run([line("2026-09-02", "TIENDA", 30_000), line("2026-09-03", "JOYERIA", 500_000), line("2026-09-04", "ELECTRO", 250_000)], []);
    const m = by(r.findings, "missing_in_app");
    expect(m.find((f) => f.stmtMerchant === "TIENDA")).toMatchObject({ severity: "warn", stmtDate: "2026-09-02", stmtAmountCents: 30_000, stmtType: "purchase", detail: { importable: true, lineIndex: 0 } });
    expect(m.find((f) => f.stmtMerchant === "JOYERIA")!.severity).toBe("high");
    expect(m.find((f) => f.stmtMerchant === "ELECTRO")!.severity).toBe("warn"); // grande pero no reciente (hoy 4-oct, 30 días)
    const recent = reconcile({ doc: { period, transactions: [line("2026-09-30", "ELECTRO", 250_000)] }, appRows: [], today: "2026-10-04" });
    expect(recent.findings[0].severity).toBe("high");
    expect(m.find((f) => f.stmtMerchant === "TIENDA")!.message).toContain("$300.00");
  });

  it("comisiones, intereses e impuestos del banco: info (no pasan por el Atajo), importables", () => {
    nextId = 1;
    const r = run([line("2026-09-01", "INTERESES", 12_345, { type: "interest" }), line("2026-09-01", "IVA", 1_975, { type: "tax" }), line("2026-09-02", "COMISION", 59_900, { type: "fee" })], []);
    for (const f of by(r.findings, "missing_in_app")) expect(f).toMatchObject({ severity: "info", detail: { importable: true } });
  });

  it("compras idénticas: la que falta es la de mayor ocurrencia y su fingerprint es estable", () => {
    nextId = 1;
    const l = [line("2026-09-01", "CAFE", 5_000), line("2026-09-01", "CAFE", 5_000)];
    const one = by(run(l, [row("2026-09-01", "CAFE", 5_000)]).findings, "missing_in_app");
    const none = by(run(l, []).findings, "missing_in_app");
    expect(one).toHaveLength(1);
    expect(none).toHaveLength(2);
    expect(one[0].fingerprint).toBe(none.find((f) => f.fingerprint === one[0].fingerprint)!.fingerprint);
    expect(new Set(none.map((f) => f.fingerprint)).size).toBe(2);
  });

  it("el fingerprint no depende de ids de la app cuando el hallazgo no nace de una fila", () => {
    nextId = 1;
    const a = run([line("2026-09-01", "CAFE", 5_000)], [row("2026-09-20", "OTRA COSA", 111)]);
    nextId = 500;
    const b = run([line("2026-09-01", "CAFE", 5_000)], [row("2026-09-20", "OTRA COSA", 111)]);
    expect(by(a.findings, "missing_in_app")[0].fingerprint).toBe(by(b.findings, "missing_in_app")[0].fingerprint);
  });

  it("pagos: se comparan contra card_payment (±5 días, valor absoluto) y su falta es solo info, no importable", () => {
    nextId = 1;
    const ok = run([line("2026-09-10", "SU PAGO GRACIAS", -100_000, { type: "payment" })], [row("2026-09-15", "PAGO", 100_000, { kind: "card_payment" })]);
    expect(ok.findings).toEqual([]);
    expect(ok.summary).toMatchObject({ paymentsCount: 1, paymentsMatched: 1 });
    const far = run([line("2026-09-10", "SU PAGO GRACIAS", -100_000, { type: "payment" })], [row("2026-09-16", "PAGO", 100_000, { kind: "card_payment" })]);
    expect(far.findings).toHaveLength(1);
    expect(far.findings[0]).toMatchObject({ kind: "missing_in_app", severity: "info", detail: { importable: false, payment: true } });
    // Una fila card_payment de la app que el estado no trae NO es hallazgo.
    expect(run([], [row("2026-09-10", "PAGO", 5_000, { kind: "card_payment" })]).findings).toEqual([]);
  });
});

describe("not_in_statement", () => {
  it("fila del periodo sin pareja: warn; en la cola, antes del periodo previo o después del corte: nada; justo antes del inicio: info", () => {
    nextId = 1;
    const inside = row("2026-09-05", "FANTASMA", 7_700);
    const tail = row("2026-09-16", "RECIENTE", 1_100);
    const old = row("2026-08-10", "VIEJA", 2_200);
    const after = row("2026-09-25", "FUTURA", 3_300);
    const boundary = row("2026-08-17", "LIMITE", 4_400);
    const r = run([], [inside, tail, old, after, boundary]);
    const n = by(r.findings, "not_in_statement");
    expect(n.map((f) => [f.txId, f.severity])).toEqual([[inside.id, "warn"], [boundary.id, "info"]]);
    expect(r.summary.tailCents).toBe(1_100);
    expect(r.summary.unexplainedCents).toBe(0);
  });

  it("fila grande sin pareja: high", () => {
    nextId = 1;
    expect(run([], [row("2026-09-05", "CARO", 900_000)]).findings[0].severity).toBe("high");
  });

  it("periodo de un solo día: no hay cola (todo el día cuenta)", () => {
    nextId = 1;
    const p = { start: "2026-09-10", end: "2026-09-10" };
    const r = run([], [row("2026-09-10", "X", 1_000)], { period: p });
    expect(kinds(r.findings)).toContain("not_in_statement");
    expect(run([line("2026-09-10", "X", 1_000)], [row("2026-09-10", "X", 1_000)], { period: p }).findings).toEqual([]);
  });

  it("compra a MSI: la app tiene el monto completo y el estado solo la mensualidad 1 → conciliada, sin hallazgo", () => {
    nextId = 1;
    const r = run([line("2026-09-02", "VIAJE HOTEL", 336_521, { type: "installment", installment: { n: 1, total: 3 } })], [row("2026-09-02", "Viaje Hotel", 1_009_563, { planId: 7 })]);
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ msiMatched: 1, matched: 1, installmentCount: 1, installmentCents: 336_521, unexplainedCents: 0 });
  });

  it("compra a MSI sin ninguna línea en el estado: esperable, no es hallazgo ni 'no está en el estado'", () => {
    nextId = 1;
    const r = run([], [row("2026-09-02", "LAPTOP", 1_800_000, { planId: 3 })]);
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({ msiUnmatched: 1, msiCents: 1_800_000, unexplainedCents: 0 });
  });

  it("mensualidades (installment n>1, installment_credit) se ignoran pero se cuentan; transfer_own, income y monto cero también se ignoran", () => {
    nextId = 1;
    const r = run([
      line("2026-09-01", "MENSUALIDAD", 148_742, { type: "installment", installment: { n: 12, total: 24 } }),
      line("2026-09-01", "ABONO CONVERSION", -408_300, { type: "installment_credit" }),
      line("2026-09-02", "TRASPASO", -50_000, { type: "transfer_own" }),
      line("2026-09-02", "NOMINA", -900_000, { type: "income" }),
      line("2026-09-03", "COMISION CERO", 0, { type: "fee" }),
      line("2026-09-04", "DOMI", 10_000, { type: "domiciliation_other" }),
    ], []);
    expect(r.findings).toEqual([]);
    expect(r.summary.ignored).toMatchObject({ installment: 1, installment_credit: 1, transfer_own: 1, income: 1, monto_cero: 1, domiciliation_other: 1 });
    expect(r.summary).toMatchObject({ installmentCount: 1, installmentCents: 148_742, statementCount: 0 });
  });
});

describe("duplicate_suspect", () => {
  it("más filas idénticas en la app que líneas en el estado: high, con los ids", () => {
    nextId = 1;
    const rows = [row("2026-09-05", "TIENDA", 9_900), row("2026-09-05", "Tienda wallet", 9_900, { source: "email" }), row("2026-09-06", "TIENDA", 9_900, { source: "manual" })];
    const r = run([line("2026-09-05", "TIENDA", 9_900), line("2026-09-06", "TIENDA", 9_900)], rows);
    const d = by(r.findings, "duplicate_suspect");
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("high");
    expect(d[0].detail).toMatchObject({ appIds: rows.map((x) => x.id), statementCount: 2, appCount: 3 });
    expect((d[0].detail.extraIds as number[]).length).toBe(1);
    expect(kinds(r.findings)).not.toContain("not_in_statement");
    expect(by(r.findings, "total_mismatch")[0].severity).toBe("info"); // explicada por el duplicado
    expect(r.summary.diffCents).toBe(-9_900);
  });

  it("compra repetida legítima en días distintos (>1 día) no es duplicado", () => {
    nextId = 1;
    const r = run([line("2026-09-05", "CAFE", 4_500), line("2026-09-09", "CAFE", 4_500)], [row("2026-09-05", "CAFE", 4_500), row("2026-09-09", "CAFE", 4_500)]);
    expect(r.findings).toEqual([]);
  });

  it("una fila extra en la cola del periodo no se acusa de duplicado (aún pudo no postearse)", () => {
    nextId = 1;
    const r = run([line("2026-09-15", "CAFE", 4_500)], [row("2026-09-15", "CAFE", 4_500), row("2026-09-16", "CAFE", 4_500)]);
    expect(by(r.findings, "duplicate_suspect")).toEqual([]);
  });

  it("aun sin estado: dos filas misma tarjeta+monto+comercio, fuentes distintas, ≤10 min, sin fusionar", () => {
    nextId = 1;
    const a = row("2026-09-30", "Starbucks", 8_800, { source: "shortcut", occurredAt: "2026-09-30T20:00:00Z" });
    const b = row("2026-09-30", "STARBUCKS", 8_800, { source: "email", occurredAt: "2026-09-30T20:07:00Z" });
    const r = run([], [a, b]); // posterior al corte: el estado no la cubre
    const d = by(r.findings, "duplicate_suspect");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ severity: "high", txId: a.id, otherTxId: b.id });
    // Más de 10 minutos, misma fuente o comercio distinto: no.
    const far = row("2026-09-30", "STARBUCKS", 8_800, { source: "email", occurredAt: "2026-09-30T20:30:00Z" });
    expect(run([], [a, far]).findings).toEqual([]);
    const same = row("2026-09-30", "STARBUCKS", 8_800, { source: "shortcut", occurredAt: "2026-09-30T20:03:00Z" });
    expect(run([], [a, same]).findings).toEqual([]);
    const other = row("2026-09-30", "OXXO", 8_800, { source: "email", occurredAt: "2026-09-30T20:03:00Z" });
    expect(run([], [a, other]).findings).toEqual([]);
  });

  it("dos filas cercanas de fuentes distintas pero AMBAS conciliadas (el estado trae dos cargos): compras legítimas", () => {
    nextId = 1;
    const a = row("2026-09-05", "Cafe", 4_500, { source: "shortcut", occurredAt: "2026-09-05T20:00:00Z" });
    const b = row("2026-09-05", "Cafe", 4_500, { source: "email", occurredAt: "2026-09-05T20:05:00Z" });
    expect(run([line("2026-09-05", "CAFE", 4_500), line("2026-09-05", "CAFE", 4_500)], [a, b]).findings).toEqual([]);
  });
});

describe("amount_mismatch", () => {
  it("propina: línea y fila sin pareja, comercio parecido, ≤3 días → un solo hallazgo con ambos montos y la diferencia", () => {
    nextId = 1;
    const a = row("2026-09-07", "Restaurante Luna", 100_000);
    const r = run([line("2026-09-08", "RESTAURANTE LUNA 123", 115_000)], [a]);
    expect(kinds(r.findings)).toEqual(["amount_mismatch", "total_mismatch"]);
    const f = r.findings[0];
    expect(f).toMatchObject({ severity: "warn", txId: a.id, stmtAmountCents: 115_000, detail: { statementCents: 115_000, appCents: 100_000, diffCents: 15_000, cause: "tip", lineIndex: 0 } });
    expect(f.message).toContain("$1,150.00");
    expect(f.message).toContain("$1,000.00");
    expect(by(r.findings, "total_mismatch")[0].severity).toBe("info");
  });

  it("tipo de cambio: diferencia chica en una línea foreign; redondeo de $1", () => {
    nextId = 1;
    const fx = run([line("2026-09-08", "HOTEL PARIS", 205_000, { foreign: { currency: "EUR" } })], [row("2026-09-08", "Hotel Paris", 200_000)]);
    expect(fx.findings[0]).toMatchObject({ kind: "amount_mismatch", severity: "warn", detail: { cause: "fx" } });
    const round = run([line("2026-09-08", "TIENDA UNO", 10_001)], [row("2026-09-08", "Tienda Uno", 10_000)]);
    expect(round.findings[0].detail.cause).toBe("rounding");
  });

  it("diferencia absoluta grande: high", () => {
    nextId = 1;
    const r = run([line("2026-09-08", "MUEBLERIA SOL", 1_200_000)], [row("2026-09-08", "Muebleria Sol", 1_000_000)]);
    expect(r.findings[0]).toMatchObject({ kind: "amount_mismatch", severity: "high" });
  });

  it("comercio distinto o diferencia enorme: no se empareja (dos hallazgos independientes)", () => {
    nextId = 1;
    expect(kinds(run([line("2026-09-08", "FARMACIA", 10_500)], [row("2026-09-08", "GASOLINERA", 10_000)]).findings)).toEqual(expect.arrayContaining(["missing_in_app", "not_in_statement"]));
    expect(kinds(run([line("2026-09-08", "FARMACIA", 50_000)], [row("2026-09-08", "FARMACIA", 10_000)]).findings)).toEqual(expect.arrayContaining(["missing_in_app", "not_in_statement"]));
  });

  it("si la fila además tiene una idéntica ya conciliada (posible duplicado), el hallazgo es high y lo dice", () => {
    nextId = 1;
    const ok = row("2026-09-08", "Cafe Sol", 10_000);
    const dup = row("2026-09-08", "Cafe Sol", 10_000, { source: "email" });
    const r = run([line("2026-09-08", "CAFE SOL", 10_000), line("2026-09-09", "CAFE SOL", 10_500)], [ok, dup]);
    const m = by(r.findings, "amount_mismatch")[0];
    expect(m.severity).toBe("high");
    expect(m.detail.siblingIds).toEqual([ok.id]);
    expect(m.message).toContain("idéntica");
  });
});

describe("total_mismatch y extracción", () => {
  it("la suma coincide con los hallazgos: nada queda sin explicar", () => {
    nextId = 1;
    const r = run(
      [line("2026-09-02", "A", 10_000), line("2026-09-03", "B", 20_000), line("2026-09-04", "C", 30_000)],
      [row("2026-09-02", "A", 10_000), row("2026-09-20", "ZZ", 1), row("2026-09-06", "FANTASMA", 5_500)],
    );
    const t = by(r.findings, "total_mismatch")[0];
    expect(t).toMatchObject({ severity: "info" });
    expect(t.detail).toMatchObject({ statementCents: 60_000, diffCents: 60_000 - 15_500, unexplainedCents: 0 });
    expect(r.summary.explainedByFindingsCents).toBe(50_000 - 5_500);
  });

  it("check fallido: high, no importable y se avisa", () => {
    nextId = 1;
    const r = run([line("2026-09-02", "A", 10_000)], [], { checks: [{ name: "suma_cargos", ok: false }, { name: "otro", ok: true }] });
    expect(r.trusted).toBe(false);
    const e = by(r.findings, "extraction_check_failed");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ severity: "high" });
    expect(e[0].message).toContain("suma_cargos");
    expect(by(r.findings, "missing_in_app")[0].detail.importable).toBe(false);
    expect(run([], [], { checks: [{ name: "x", ok: true }] }).trusted).toBe(true);
  });
});

describe("robustez", () => {
  it("montos enormes (sin pérdida de precisión) y negativos enormes", () => {
    nextId = 1;
    const big = 9_000_000_000_000; // 90 mil millones de pesos
    const r = run([line("2026-09-02", "BANCO", big), line("2026-09-03", "BANCO", -big, { type: "refund" })], [row("2026-09-02", "BANCO", big), row("2026-09-03", "BANCO", -big)]);
    expect(r.findings).toEqual([]);
    expect(r.summary.statementCents).toBe(0);
  });

  it("texto hostil: se trunca a las columnas, sin saltos de línea ni control en el mensaje, emoji intacto", () => {
    nextId = 1;
    const evil = `${"A".repeat(300)}\n<script>alert(1)</script>‮\u0000 '); DROP TABLE x;-- 🔥`;
    const r = run([line("2026-09-02", evil, 10_000), line("2026-09-03", "🔥".repeat(150), 20_000)], [row("2026-09-06", evil, 31_000)]);
    for (const f of r.findings) {
      expect(f.message.length).toBeLessThanOrEqual(500);
      expect(f.message).not.toMatch(/[\n\r\u0000‮]/);
      if (f.stmtMerchant) expect(f.stmtMerchant.length).toBeLessThanOrEqual(200);
      expect(f.stmtMerchant === null || !/[\uD800-\uDBFF]$/.test(f.stmtMerchant)).toBe(true);
      JSON.stringify(f.detail);
    }
    expect(by(r.findings, "missing_in_app")).toHaveLength(2);
  });

  it("es determinista e idempotente: dos corridas dan exactamente lo mismo, sin importar el orden de las filas", () => {
    nextId = 1;
    const l = [line("2026-09-02", "A", 10_000), line("2026-09-02", "A", 10_000), line("2026-09-03", "B", 20_000), line("2026-09-04", "C", 5_000)];
    const rows = [row("2026-09-02", "A", 10_000), row("2026-09-03", "B", 21_000), row("2026-09-09", "FANTASMA", 9_000), row("2026-09-02", "A", 10_000, { source: "email" }), row("2026-09-02", "A", 10_000, { source: "manual" })];
    const a = run(l, rows);
    expect(run(l, rows)).toEqual(a);
    expect(run(l, [...rows].reverse())).toEqual(a);
  });

  it("propiedad: en entradas aleatorias nunca hay filas/líneas repetidas, fingerprints únicos y la diferencia siempre queda explicada", () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
    for (let iter = 0; iter < 300; iter++) {
      nextId = 1;
      const merchants = ["CAFE", "TIENDA", "GAS", "SUPER", "X"];
      const amounts = [1_000, 1_000, 2_500, 2_500, 9_999, -1_500];
      const day = () => `2026-${pick(["08", "09"])}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`;
      const lines = Array.from({ length: Math.floor(rnd() * 12) }, () => line(day(), pick(merchants), pick(amounts), { type: pick(["purchase", "purchase", "fee", "refund", "installment", "payment"]) }));
      const rows = Array.from({ length: Math.floor(rnd() * 12) }, () => row(day(), pick(merchants), pick(amounts), { source: pick(["shortcut", "email", "manual"]), planId: rnd() < 0.1 ? 1 : null, kind: rnd() < 0.1 ? "card_payment" : "expense", occurredAt: `2026-09-01T10:0${Math.floor(rnd() * 9)}:00Z` }));
      const r = run(lines, rows);
      expect(r.summary.unexplainedCents).toBe(0);
      expect(new Set(r.matches.map((m) => m.rowId)).size).toBe(r.matches.length);
      expect(new Set(r.matches.map((m) => m.lineIndex)).size).toBe(r.matches.length);
      expect(new Set(r.findings.map((f) => f.fingerprint)).size).toBe(r.findings.length);
      expect(by(r.findings, "total_mismatch").every((f) => f.severity !== "high")).toBe(true);
    }
  });
});
