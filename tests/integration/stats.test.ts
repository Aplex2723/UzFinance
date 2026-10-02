import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@/lib/db/pool";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { getCardSummaries, getCategoryBreakdown, getCumulative, getHeatmap, getOverview, getRecurring, getSankey, getWeekdayTotals } from "@/lib/repo/stats";
import { createManual } from "@/lib/repo/transactions";
import { resetDb } from "../helpers";

const NOW = new Date("2026-09-15T18:00:00Z"); // 12:00 CDMX, martes
let amex: number, bnx: number, nu: number, cat: number;

const tx = (date: string, cents: number, card: number, merchant = "X", category: number | null = null) =>
  createManual({ occurredAt: new Date(`${date}T18:00:00Z`), amountCents: cents, merchant, cardId: card, categoryId: category, notes: null });

beforeAll(async () => {
  await resetDb();
  amex = (await createCard({ name: "Amex", issuer: "amex", last4: null, aliases: null, color: "#aaa" })).id;
  bnx = (await createCard({ name: "Banamex", issuer: "banamex", last4: null, aliases: null, color: "#f00" })).id;
  nu = (await createCard({ name: "Nu", issuer: "nu", last4: null, aliases: null, color: "#8a05be" })).id;
  cat = (await createCategory({ name: "Comida", color: "#f50" })).id;
  // Agosto (mes previo)
  await tx("2026-08-02", 10000, amex);
  await tx("2026-08-10", 20000, bnx);
  await tx("2026-08-20", 90000, bnx); // después del día 15: no entra en el comparativo
  // Septiembre (mes actual, día 15)
  await tx("2026-09-01", 15000, amex, "A", cat);
  await tx("2026-09-14", 5000, bnx, "B", cat); // lunes
  await tx("2026-09-15", -2000, bnx, "Reembolso"); // martes, reembolso
  await tx("2026-09-30", 7777, bnx); // futuro respecto a NOW: no entra al overview parcial
  await tx("2026-09-12", 4000, nu); // Nu: entra al total y al desglose por emisor
});
afterAll(closePool);

describe("estadísticas del dashboard", () => {
  it("overview: total del periodo, por emisor y delta contra el mismo periodo previo", async () => {
    const o = await getOverview("2026-09", NOW);
    expect(o.total).toBe(15000 + 5000 - 2000 + 4000);
    expect(o.prevTotal).toBe(30000);
    expect(o.deltaPct).toBeCloseTo(((22000 - 30000) / 30000) * 100, 5);
    expect(o.byIssuer.find((i) => i.issuer === "nu")).toMatchObject({ cents: 4000, prevCents: 0 });
    expect(o.byIssuer.find((i) => i.issuer === "amex")).toMatchObject({ cents: 15000, prevCents: 10000 });
    expect(o.byIssuer.find((i) => i.issuer === "banamex")).toMatchObject({ cents: 3000, prevCents: 20000 });
  });
  it("mes cerrado compara el mes completo", async () => {
    const o = await getOverview("2026-08", NOW);
    expect(o.total).toBe(120000);
    expect(o.deltaPct).toBeNull(); // julio sin datos
  });
  it("tarjetas: gasto, delta y sparkline", async () => {
    const cs = await getCardSummaries("2026-09", NOW);
    const b = cs.find((c) => c.name === "Banamex")!;
    expect(b.cents).toBe(3000);
    expect(b.spark).toHaveLength(15);
    expect(b.spark[13]).toBe(5000);
    expect(b.spark[14]).toBe(-2000);
  });
  it("acumulado: termina en el total del periodo y respeta el corte", async () => {
    const c = await getCumulative("2026-09", NOW);
    expect(c.cutoff).toBe(15);
    expect(c.points[14].current).toBe(22000);
    expect(c.points[15].current).toBeNull();
    expect(c.points[30 - 1].previous).toBe(120000); // agosto completo (día 30 de 31)
  });
  it("día de la semana: lunes=0 y la suma cuadra con el total del mes", async () => {
    const w = await getWeekdayTotals("2026-09");
    expect(w).toHaveLength(7);
    expect(w[0]).toBe(5000); // 14-sep lunes
    expect(w[1]).toBe(15000 - 2000); // martes: 1-sep (+15000) y 15-sep (reembolso −2000)
    expect(w.reduce((a, b) => a + b, 0)).toBe(15000 + 5000 - 2000 + 7777 + 4000);
  });
  it("sankey solo incluye flujos positivos con su categoría", async () => {
    const s = await getSankey("2026-09");
    expect(s).toContainEqual({ card: "Amex", category: "Comida", color: "#f50", cents: 15000 });
    expect(s.every((l) => l.cents > 0)).toBe(true);
    expect(s.some((l) => l.category === "Sin categoría")).toBe(true);
  });
  it("categorías del mes", async () => {
    const c = await getCategoryBreakdown("2026-09");
    expect(c[0]).toMatchObject({ name: "Comida", cents: 20000, count: 2 });
  });
  it("heatmap: 12 semanas completas alineadas lunes-domingo", async () => {
    const h = await getHeatmap(12, NOW);
    expect(h.cells).toHaveLength(84);
    expect(new Date(`${h.cells[0].date}T00:00:00Z`).getUTCDay()).toBe(1); // lunes
    expect(h.cells[83].date).toBe("2026-09-20"); // domingo de la semana actual
    expect(h.cells.find((c) => c.date === "2026-09-14")?.cents).toBe(5000);
    expect(h.cells.find((c) => c.date === "2026-09-21") ).toBeUndefined();
    expect(h.cells.find((c) => c.date === "2026-09-16")?.future).toBe(true);
  });
  it("recurrentes requiere 3+ meses con monto estable", async () => {
    for (const m of ["2026-07", "2026-08", "2026-09"]) await tx(`${m}-05`, 29900, bnx, "NETFLIX");
    for (const [m, c] of [["2026-07", 1000], ["2026-08", 9000], ["2026-09", 1000]] as const) await tx(`${m}-06`, c, bnx, "VARIABLE");
    const r = await getRecurring(NOW);
    expect(r.map((x) => x.merchant)).toEqual(["NETFLIX"]);
    expect(r[0].avgCents).toBe(29900);
  });
});
