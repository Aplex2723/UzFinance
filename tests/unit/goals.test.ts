import { describe, expect, it } from "vitest";
import { goalMessages, goalProgress, type Goal } from "@/lib/goals";

const goal = (o: Partial<Goal> = {}): Goal => ({ name: "Depa", targetCents: 1_600_000_00, targetDate: "2027-10-05", savedCents: 308_500_00, savedAsOf: "2026-10-02", ...o });

describe("goalProgress", () => {
  it("calcula avance, faltante y cuánto apartar al mes", () => {
    const p = goalProgress(goal(), "2026-10-02", 350_000_00);
    expect(p.remaining).toBe(1_291_500_00);
    expect(p.pct).toBeCloseTo(19.28, 1);
    expect(p.daysLeft).toBe(368);
    expect(p.monthsLeft).toBeCloseTo(12.09, 1);
    expect(p.perMonth / 100).toBeGreaterThan(106_000);
    expect(p.perMonth / 100).toBeLessThan(107_500);
    expect(p.perMonthPct).toBeCloseTo((p.perMonth / 350_000_00) * 100, 5);
    expect(p).toMatchObject({ done: false, overdue: false, staleDays: 0 });
  });

  it("meta lograda: no pide apartar nada", () => {
    const p = goalProgress(goal({ savedCents: 1_700_000_00 }), "2026-10-02", 350_000_00);
    expect(p).toMatchObject({ done: true, remaining: 0, perMonth: 0, pct: 100 });
  });

  it("si queda menos de un mes pide todo el faltante; si ya pasó la fecha, está vencida", () => {
    expect(goalProgress(goal({ targetDate: "2026-10-20" }), "2026-10-02", 0).perMonth).toBe(1_291_500_00);
    const late = goalProgress(goal({ targetDate: "2026-09-01" }), "2026-10-02", 350_000_00);
    expect(late).toMatchObject({ overdue: true, monthsLeft: 0, perMonth: 1_291_500_00 });
  });

  it("sin ingreso no calcula porcentaje; detecta cifra de ahorro vieja", () => {
    const p = goalProgress(goal({ savedAsOf: "2026-08-01" }), "2026-10-02", 0);
    expect(p.perMonthPct).toBeNull();
    expect(p.staleDays).toBe(62);
  });
});

describe("goalMessages", () => {
  const msgs = (g = goal(), today = "2026-10-02", income = 350_000_00, saving: number | null = null) => goalMessages(g, goalProgress(g, today, income), saving);

  it("dice cuánto falta, para cuándo y cuánto apartar", () => {
    const m = msgs();
    expect(m[0].text).toContain("Faltan");
    expect(m[0].text).toContain("5 de octubre 2027");
    expect(m[0].text).toContain("al mes");
    expect(m[0].text).toContain("% de tu ingreso");
  });

  it("compara con lo que sobraría este mes a tu ritmo de gasto", () => {
    expect(msgs(goal(), "2026-10-02", 350_000_00, 150_000_00).at(-1)).toMatchObject({ tone: "good" });
    const low = msgs(goal(), "2026-10-02", 350_000_00, 40_000_00).at(-1)!;
    expect(low.tone).toBe("warn");
    expect(low.text).toContain("faltarían");
    expect(msgs(goal(), "2026-10-02", 350_000_00, -5_000_00).at(-1)!.text).toContain("sobrarían $0");
  });

  it("avisa meta lograda, fecha vencida y ahorro sin actualizar", () => {
    expect(msgs(goal({ savedCents: 1_600_000_00 }))[0]).toMatchObject({ tone: "good" });
    expect(msgs(goal({ targetDate: "2026-09-01" }))[0].text).toContain("ya pasó");
    expect(msgs(goal({ savedAsOf: "2026-08-01" })).some((m) => m.text.includes("sin actualizarse"))).toBe(true);
  });
});
