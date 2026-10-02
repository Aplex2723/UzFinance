import { describe, expect, it } from "vitest";
import { addMonthsIso, billDate, buildMsiMessages, buildSchedule, installmentsNow, projectPlan, startedByMonth, summarize, type PlanLike } from "@/lib/msi";

const plan = (o: Partial<PlanLike> = {}): PlanLike => ({
  id: 1, cardId: 1, cardName: "Tarjeta A", merchant: "TIENDA UNO", kind: "purchase", withInterest: false,
  originalCents: 120_000_00, monthlyCents: 10_000_00, pendingCents: 20_000_00, nTotal: 12, nCurrent: 10, asOf: "2026-09-18", startedOn: "2025-12-18", ...o,
});

describe("addMonthsIso", () => {
  it("suma meses y cae al último día cuando no existe el día", () => {
    expect(addMonthsIso("2026-09-18", 1)).toBe("2026-10-18");
    expect(addMonthsIso("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonthsIso("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonthsIso("2026-01-15", -2)).toBe("2025-11-15");
  });
});

describe("installmentsNow / projectPlan", () => {
  it("la mensualidad se carga el día siguiente al corte, cada mes; nunca pasa del total", () => {
    const p = plan(); // 10 de 12 al corte del 18-sep → la 11 se cargó el 19-sep, la 12 el 19-oct
    expect(installmentsNow(p, "2026-09-18")).toBe(10);
    expect(installmentsNow(p, "2026-09-19")).toBe(11);
    expect(installmentsNow(p, "2026-10-02")).toBe(11);
    expect(installmentsNow(p, "2026-10-19")).toBe(12);
    expect(installmentsNow(p, "2030-01-01")).toBe(12);
  });

  it("billDate: la mensualidad del propio corte cae al inicio de su periodo", () => {
    const p = plan();
    expect(billDate(p, 10)).toBe("2026-08-19");
    expect(billDate(p, 11)).toBe("2026-09-19");
    expect(billDate(p, 12)).toBe("2026-10-19");
  });

  it("calcula faltantes, saldo, siguiente cobro y fecha de término", () => {
    const v = projectPlan(plan(), "2026-10-02");
    expect(v).toMatchObject({ paid: 11, remaining: 1, pendingNow: 10_000_00, nextBillOn: "2026-10-19", endOn: "2026-10-19", endMonth: "2026-10", active: true });
    const done = projectPlan(plan(), "2027-01-01");
    expect(done).toMatchObject({ remaining: 0, pendingNow: 0, nextBillOn: null, active: false });
  });
});

describe("buildSchedule", () => {
  it("reparte la mensualidad en el mes natural de cada corte, por tarjeta, y recorta la cola vacía", () => {
    const a = plan({ id: 1, cardId: 1, nCurrent: 10, nTotal: 12 }); // se carga 19-sep (11) y 19-oct (12)
    const b = plan({ id: 2, cardId: 2, monthlyCents: 5_000_00, nCurrent: 1, nTotal: 3, asOf: "2026-09-25" }); // 26-sep (2) y 26-oct (3)
    const s = buildSchedule([a, b], "2026-10-02");
    expect(s.map((r) => r.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(s[0]).toMatchObject({ past: true, total: 15_000_00 });
    expect(s[1]).toMatchObject({ past: false, total: 15_000_00, byCard: { 1: 10_000_00, 2: 5_000_00 } });
    expect(s[2].total).toBe(0);
  });

  it("sin planes devuelve una ventana corta y vacía", () => {
    const s = buildSchedule([], "2026-10-02");
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.every((r) => r.total === 0)).toBe(true);
  });
});

describe("startedByMonth", () => {
  it("cuenta compras a MSI por mes de compra y excluye las disposiciones", () => {
    const rows = startedByMonth(
      [plan({ startedOn: "2026-09-10", originalCents: 30_000_00 }), plan({ id: 2, startedOn: "2026-09-20", originalCents: 5_000_00 }), plan({ id: 3, kind: "cash_advance", startedOn: "2026-09-02", originalCents: 3_000_00 }), plan({ id: 4, startedOn: "2024-01-01" })],
      "2026-10-02",
    );
    expect(rows).toHaveLength(12);
    expect(rows.at(-1)!.month).toBe("2026-10");
    expect(rows.find((r) => r.month === "2026-09")).toEqual({ month: "2026-09", count: 2, cents: 35_000_00 });
  });
});

describe("summarize + buildMsiMessages", () => {
  const plans = [
    plan({ id: 1, cardId: 1, cardName: "Tarjeta A", merchant: "TIENDA UNO", nCurrent: 10, nTotal: 12 }), // termina oct
    plan({ id: 2, cardId: 2, cardName: "Tarjeta B", merchant: "TIENDA DOS", monthlyCents: 40_000_00, nCurrent: 2, nTotal: 6, asOf: "2026-09-25", originalCents: 240_000_00, pendingCents: 160_000_00, startedOn: "2026-08-25" }),
    plan({ id: 3, cardId: 2, cardName: "Tarjeta B", merchant: "DISPOSICION", kind: "cash_advance", withInterest: true, monthlyCents: 1_000_00, nCurrent: 1, nTotal: 3, asOf: "2026-09-25", originalCents: 3_000_00, pendingCents: 2_000_00, startedOn: "2026-09-01" }),
    plan({ id: 4, merchant: "VIEJO", nCurrent: 3, nTotal: 3, asOf: "2026-06-18", pendingCents: 0, startedOn: "2026-04-18" }), // ya terminó
  ];
  const s = summarize(plans, 350_000_00, "2026-10-02");

  it("separa vigentes de terminados y calcula la carga del mes y el saldo", () => {
    expect(s.active.map((p) => p.id)).toEqual([1, 3, 2]); // por fecha de término
    expect(s.plans.find((p) => p.id === 4)!.active).toBe(false);
    expect(s.loadNow).toBe(10_000_00 + 40_000_00 + 1_000_00);
    expect(s.loadPct).toBeCloseTo((51_000_00 / 350_000_00) * 100, 5);
    expect(s.remainingTotal).toBe(10_000_00 + 120_000_00 + 1_000_00); // saldo del corte menos lo ya cargado después // pendiente a la fecha del corte (aún no llega octubre)
    expect(s.nextEnding!.id).toBe(1);
    expect(s.freeMonth).toBe("2026-12");
  });

  it("genera frases útiles: carga, primero en terminar, baja de carga, fin total, tendencia e intereses", () => {
    const text = buildMsiMessages(s).map((m) => m.text).join("\n");
    expect(text).toContain("3 planes a meses");
    expect(text).toContain("TIENDA UNO");
    expect(text).toContain("libera");
    expect(text).toContain("Terminas de pagar todos tus MSI en Diciembre 2026");
    expect(text).toContain("CON intereses");
    expect(text).toContain("Tarjeta B concentra");
  });

  it("sin planes vigentes lo dice y no inventa nada", () => {
    const none = summarize([plans[3]], 350_000_00, "2026-10-02");
    const m = buildMsiMessages(none);
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain("No tienes planes");
    expect(none.freeMonth).toBeNull();
  });

  it("avisa (warn) cuando la carga pasa del 30% del ingreso", () => {
    const heavy = summarize([plan({ monthlyCents: 120_000_00, nCurrent: 5, nTotal: 12 })], 350_000_00, "2026-10-02");
    expect(buildMsiMessages(heavy)[0].tone).toBe("warn");
  });
});
