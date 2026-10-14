import { describe, expect, it } from "vitest";
import { addDays, capacityFrom, endOfMonth, goalProgress, goalWhen, planGoals, planMessages, scenarios, trimIdeas, type Capacity, type Goal, type GoalRow } from "@/lib/goals";

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

const TODAY = "2026-10-13";
const row = (id: number, o: Partial<GoalRow> = {}): GoalRow => ({ id, name: `Meta ${id}`, kind: "otro", priority: 2, monthOnly: false, targetCents: 200_000_00, targetDate: "2027-04-11", savedCents: 0, savedAsOf: TODAY, ...o });
// Ingreso 100 mil, gasto estable de 60 mil → sobran 40 mil al mes.
const cap = (spend: number[] = [60_000_00, 60_000_00, 60_000_00], income = 100_000_00): Capacity => capacityFrom({ income, completeMonths: spend, currentProjected: null });

describe("capacityFrom", () => {
  it("promedia los últimos 3 meses cerrados y calcula el mes malo y el bueno", () => {
    const c = capacityFrom({ income: 200_000_00, completeMonths: [50_000_00, 120_000_00, 110_000_00, 90_000_00], currentProjected: 1 });
    expect(c).toMatchObject({ basis: "history", months: 3, avgSpend: 106_666_67, maxSpend: 120_000_00, minSpend: 90_000_00 });
    expect(c.surplus).toBe(200_000_00 - 106_666_67);
    expect(c.surplusLow).toBe(80_000_00);
    expect(c.surplusHigh).toBe(110_000_00);
  });
  it("sin meses cerrados usa la proyección del mes en curso; sin eso o sin ingreso no hay base", () => {
    expect(capacityFrom({ income: 100_000_00, completeMonths: [], currentProjected: 70_000_00 })).toMatchObject({ basis: "current", months: 0, surplus: 30_000_00 });
    expect(capacityFrom({ income: 100_000_00, completeMonths: [], currentProjected: null }).basis).toBe("none");
    expect(capacityFrom({ income: 0, completeMonths: [60_000_00], currentProjected: null }).basis).toBe("none");
    expect(capacityFrom({ income: 100_000_00, completeMonths: [0, NaN], currentProjected: 0 }).basis).toBe("none");
  });
});

describe("planGoals", () => {
  it("una meta alcanzable llega a tiempo y estima la fecha", () => {
    const s = planGoals([row(1)], cap(), TODAY);
    const p = s.plans[0];
    expect(p.status).toBe("on_track");
    expect(p.order).toBe(1);
    expect(p.projectedDate).toBe(addDays(TODAY, Math.ceil(5 * 30.4375))); // 200 mil ÷ 40 mil al mes = 5 meses
    expect(s).toMatchObject({ surplus: 40_000_00, extraNeeded: 0, cutPct: 0, counts: { on_track: 1 } });
    expect(s.lastDate).toBe(p.projectedDate);
    expect(p.gapPerMonth).toBe(0);
  });

  it("un mes de gasto alto la deja 'justa' aunque al ritmo típico llegue", () => {
    const s = planGoals([row(1, { targetCents: 150_000_00 })], cap([60_000_00, 60_000_00, 85_000_00]), TODAY); // típico 68,333 → sobran 31,667 (150 mil en 4.7 meses); en el mes malo solo 15,000
    expect(s.plans[0].status).toBe("tight");
  });

  it("reparte el excedente en cascada: la segunda meta espera a la primera y se retrasa", () => {
    const s = planGoals([row(1), row(2, { targetCents: 1_000_000_00, targetDate: "2027-10-05" })], cap(), TODAY);
    const [a, b] = s.plans;
    expect(a.status).toBe("on_track");
    expect(b.order).toBe(2);
    expect(b.status).toBe("late");
    expect(b.projectedDate).toBe(addDays(TODAY, Math.ceil(30 * 30.4375))); // (200 + 1,000 mil) ÷ 40 mil
    expect(b.monthsLate).toBe(Math.ceil(30 - b.progress.monthsLeft));
    expect(s.counts).toMatchObject({ on_track: 1, late: 1 });
    // Para todas a tiempo hay que juntar 1.2 millones en ~11.8 meses.
    expect(s.neededSurplus).toBe(Math.ceil(1_200_000_00 / b.progress.monthsLeft));
    expect(s.extraNeeded).toBe(s.neededSurplus - 40_000_00);
    expect(b.gapPerMonth).toBe(b.cumulativeNeedPerMonth - 40_000_00);
    expect(s.cutPct).toBeCloseTo((s.extraNeeded / 60_000_00) * 100, 5);
  });

  it("la prioridad alta se financia primero aunque su fecha sea más lejana", () => {
    const s = planGoals([row(1), row(2, { targetCents: 100_000_00, targetDate: "2027-10-05", priority: 1 })], cap(), TODAY);
    expect(s.plans.map((p) => p.goal.id)).toEqual([2, 1]);
    expect(s.plans[0]).toMatchObject({ order: 1, status: "on_track" });
    expect(s.plans[1].order).toBe(2);
  });

  it("sin excedente nada avanza; las metas lograda y vencida se marcan aparte", () => {
    const s = planGoals([row(1), row(2, { savedCents: 200_000_00 }), row(3, { targetDate: "2026-09-01" })], cap([100_000_00]), TODAY);
    const byId = (id: number) => s.plans.find((p) => p.goal.id === id)!;
    expect(byId(1)).toMatchObject({ status: "unreachable", projectedDate: null });
    expect(byId(2)).toMatchObject({ status: "done", order: 0 });
    expect(byId(3)).toMatchObject({ status: "overdue", projectedDate: null });
    expect(s.lastDate).toBeNull();
    expect(s.plans.at(-1)!.goal.id).toBe(2); // las logradas van al final
  });

  it("más de 10 años no cuenta como alcanzable", () => {
    const s = planGoals([row(1, { targetCents: 100_000_000_00, targetDate: "2030-01-01" })], cap(), TODAY);
    expect(s.plans[0].status).toBe("unreachable");
  });

  it("sin ingreso o sin gastos no hay predicción", () => {
    const s = planGoals([row(1)], cap([], 0), TODAY);
    expect(s.plans[0].status).toBe("no_data");
    expect(s.extraNeeded).toBe(0);
    expect(planMessages(s, cap([], 0))[0].text).toContain("ingreso");
  });

  it("una meta vencida con excedente muestra cuándo llegaría", () => {
    const s = planGoals([row(1, { targetDate: "2026-09-01" })], cap(), TODAY);
    expect(s.plans[0]).toMatchObject({ status: "overdue", projectedDate: addDays(TODAY, Math.ceil(5 * 30.4375)) });
  });

  it("con menos de un mes por delante se pide todo en un mes", () => {
    const s = planGoals([row(1, { targetDate: "2026-10-30" })], cap(), TODAY);
    expect(s.plans[0].cumulativeNeedPerMonth).toBe(200_000_00);
    expect(s.plans[0].status).toBe("late");
  });
});

describe("scenarios", () => {
  it("recortar gasto libera dinero y mejora cuántas metas llegan a tiempo", () => {
    const goals = [row(1), row(2, { targetCents: 600_000_00, targetDate: "2027-10-05" })];
    const [base, ten, twenty] = scenarios(goals, cap(), TODAY);
    expect(base).toMatchObject({ cutPct: 0, freed: 0, surplus: 40_000_00, active: 2, onTime: 1 });
    expect(ten.freed).toBe(6_000_00);
    expect(ten.surplus).toBe(46_000_00);
    expect(twenty.surplus).toBe(52_000_00);
    expect(twenty.onTime).toBeGreaterThanOrEqual(ten.onTime);
    expect(twenty.lastDate! <= base.lastDate!).toBe(true);
  });
});

describe("planMessages y textos", () => {
  it("resume la capacidad, el estado de cada meta y lo que falta liberar", () => {
    const goals = [row(1, { name: "Tesla", monthOnly: true, targetDate: "2027-04-30" }), row(2, { name: "Depa", targetCents: 1_000_000_00, targetDate: "2027-10-05" })];
    const s = planGoals(goals, cap(), TODAY);
    const texts = planMessages(s, cap(), [{ name: "Restaurantes y cafés", avg: 20_000_00 }, { name: "Servicios y telecom", avg: 15_000_00 }, { name: "Entretenimiento", avg: 10_000_00 }]).map((m) => m.text);
    expect(texts[0]).toContain("Te sobran unos $40,000");
    expect(texts.some((t) => t.includes("“Tesla”") && t.includes("abril 2027"))).toBe(true);
    expect(texts.some((t) => t.includes("“Depa”") && t.includes("después"))).toBe(true);
    expect(texts.some((t) => t.includes("Para cumplir todas a tiempo necesitas liberar"))).toBe(true);
    const idea = texts.find((t) => t.startsWith("Una idea"))!;
    expect(idea).toContain("Restaurantes y cafés");
    expect(idea).not.toContain("Servicios"); // gasto fijo: no se sugiere recortarlo
  });
  it("avisa si no te sobra nada y si el ahorro lleva tiempo sin actualizarse", () => {
    const c = cap([100_000_00]);
    expect(planMessages(planGoals([row(1)], c, TODAY), c)[0]).toMatchObject({ tone: "warn" });
    const stale = planGoals([row(1, { savedAsOf: "2026-08-01" })], cap(), TODAY);
    expect(planMessages(stale, cap()).some((m) => m.text.includes("sin actualizarse"))).toBe(true);
  });
  it("trimIdeas ignora gastos fijos y calcula el 15%", () => {
    expect(trimIdeas([{ name: "Salud", avg: 9_000_00 }])).toBeNull();
    expect(trimIdeas([{ name: "Compras y ropa", avg: 10_000_00 }, { name: "Suscripciones", avg: 2_000_00 }])).toMatchObject({ pct: 15, freed: 1_800_00 });
  });
  it("etiquetas de fecha: exacta o solo mes; fin de mes", () => {
    expect(goalWhen({ targetDate: "2027-04-11" })).toBe("11 de abril 2027");
    expect(goalWhen({ targetDate: "2027-04-30", monthOnly: true })).toBe("abril 2027");
    expect(endOfMonth("2028-02")).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
