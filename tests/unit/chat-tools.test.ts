import { describe, expect, it } from "vitest";
import { executeTool, resolvePeriod, TOOL_SPECS, toolLabel } from "@/lib/chat/tools";

const ctx = { now: new Date("2026-10-15T18:00:00Z"), categories: [], cards: [] };
const TODAY = "2026-10-15";

describe("periodos de las herramientas", () => {
  it("sin nada = mes en curso hasta hoy", () => {
    expect(resolvePeriod({}, TODAY)).toEqual({ from: "2026-10-01", to: TODAY });
  });
  it("un mes pasado completo; el mes en curso se recorta a hoy", () => {
    expect(resolvePeriod({ month: "2026-09" }, TODAY)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolvePeriod({ month: "2026-10" }, TODAY)).toEqual({ from: "2026-10-01", to: TODAY });
  });
  it("from sin to llega hasta hoy; un fin futuro se recorta", () => {
    expect(resolvePeriod({ from: "2026-10-10" }, TODAY)).toEqual({ from: "2026-10-10", to: TODAY });
    expect(resolvePeriod({ from: "2026-10-10", to: "2027-01-01" }, TODAY)).toEqual({ from: "2026-10-10", to: TODAY });
  });
  it("rechaza combinaciones inválidas, el futuro, rangos al revés y de más de 5 años", () => {
    expect(() => resolvePeriod({ month: "2026-10", from: "2026-10-01" }, TODAY)).toThrow(/no ambos/);
    expect(() => resolvePeriod({ to: "2026-10-01" }, TODAY)).toThrow(/'from'/);
    expect(() => resolvePeriod({ month: "2026-12" }, TODAY)).toThrow(/aún no llega/);
    expect(() => resolvePeriod({ from: "2026-10-20" }, TODAY)).toThrow(/aún no llega/);
    expect(() => resolvePeriod({ from: "2026-10-10", to: "2026-10-01" }, TODAY)).toThrow();
    expect(() => resolvePeriod({ from: "2018-01-01", to: TODAY }, TODAY)).toThrow(/5 años/);
  });
});

describe("definiciones de herramientas", () => {
  it("nombres únicos, descripción y esquema de objeto sin $schema", () => {
    expect(new Set(TOOL_SPECS.map((t) => t.name)).size).toBe(TOOL_SPECS.length);
    for (const t of TOOL_SPECS) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.parameters, t.name).toMatchObject({ type: "object" });
      expect(t.parameters).not.toHaveProperty("$schema");
    }
    expect(TOOL_SPECS.map((t) => t.name)).toEqual(expect.arrayContaining(["spending_summary", "spending_by_category", "search_transactions", "savings_simulation", "calculate"]));
  });
  it("etiqueta en español para cada una y una genérica para las desconocidas", () => {
    for (const t of TOOL_SPECS) expect(toolLabel(t.name), t.name).not.toBe("Consultando tus datos");
    expect(toolLabel("nope")).toBe("Consultando tus datos");
  });
});

describe("executeTool: nunca lanza, siempre devuelve algo que el modelo pueda leer", () => {
  it("calculate", async () => {
    expect(await executeTool("calculate", '{"expression":"(50000-12000)/4"}', ctx)).toEqual({ ok: true, content: '{"expresion":"(50000-12000)/4","resultado":9500}' });
    const bad = await executeTool("calculate", '{"expression":"1/0"}', ctx);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("cero");
  });
  it("herramienta desconocida, JSON roto y argumentos inválidos", async () => {
    expect((await executeTool("drop_tables", "{}", ctx)).ok).toBe(false);
    expect(JSON.parse((await executeTool("calculate", "{no json", ctx)).content).error).toMatch(/JSON/);
    const inv = await executeTool("calculate", '{"expression":123}', ctx);
    expect(inv.ok).toBe(false);
    expect(JSON.parse(inv.content).error).toBe("Argumentos inválidos");
    expect((await executeTool("spending_by_category", '{"month":"2026-13"}', ctx)).ok).toBe(false);
    expect((await executeTool("spending_by_category", '{"limit":999}', ctx)).ok).toBe(false);
  });
  it("argumentos vacíos son válidos cuando todo es opcional; un error de periodo llega como texto", async () => {
    const r = await executeTool("spending_by_card", '{"month":"2099-01"}', ctx);
    expect(r).toEqual({ ok: false, content: '{"error":"Ese periodo aún no llega"}' });
  });
});
