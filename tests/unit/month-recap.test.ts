import { describe, expect, it, vi } from "vitest";
import { LlmError } from "@/lib/llm/openrouter";
import { generateVerified, unknownAmounts } from "@/lib/llm/verified";
import { buildMonthFacts, MONTH_SYSTEM, monthRecapHash, monthRecapKey } from "@/lib/month-recap";
import type { Insights } from "@/lib/repo/insights";

const ins = (o: Partial<Insights> = {}): Insights => ({
  month: "2026-10", isCurrent: true, income: 350_000_00, spent: 120_000_00, saved: 230_000_00, usedPct: 34.3, savedPct: 65.7, elapsedDays: 13, daysInMonth: 31, remainingDays: 18,
  avgPerDay: 9_230_77, prevAvgPerDay: 8_000_00, projected: 286_153_00, projectedPct: 81.8, dailyAllowance: 12_777_00, noSpendDays: 2, avgTicket: 1_500_00, count: 80,
  topDay: { date: "2026-10-07", cents: 20_000_00 }, topWeekday: { name: "viernes", cents: 30_000_00 },
  history: [
    { month: "2026-08", spent: 200_000_00, income: 350_000_00, saved: 150_000_00, savedPct: 42.9, usedPct: 57.1, avgPerDay: 0, days: 31, deltaPct: null },
    { month: "2026-09", spent: 210_000_00, income: 350_000_00, saved: 140_000_00, savedPct: 40, usedPct: 60, avgPerDay: 0, days: 30, deltaPct: 5 },
    { month: "2026-10", spent: 120_000_00, income: 350_000_00, saved: 230_000_00, savedPct: 65.7, usedPct: 34.3, avgPerDay: 0, days: 13, deltaPct: null },
  ],
  categoryDeltas: [{ name: "Compras y ropa", color: "#fff", cents: 50_000_00, prevCents: 40_000_00 }, { name: "Restaurantes", color: "#fff", cents: 30_000_00, prevCents: 0 }, { name: "Salud", color: "#fff", cents: 0, prevCents: 5_000_00 }],
  topMerchants: [{ merchant: "LIVERPOOL POLANCO", cents: 40_000_00, count: 3 }], messages: [], ...o,
});
const extras = { msi: { loadNow: 12_000_00, remaining: 80_000_00, active: 3, freeMonth: "2027-06" }, goals: { pending: 2, onTime: 1, surplus: 120_000_00 } };

describe("cifras del análisis mensual", () => {
  const f = buildMonthFacts(ins(), extras);
  it("manda totales y categorías ya formateados", () => {
    expect(f).toMatchObject({ mes: "Octubre 2026", ingreso_mensual: "$350,000", gastado: "$120,000", porcentaje_del_ingreso_gastado: "34%", proyeccion_al_cierre_del_mes: "$286,153", compras: 80, dias_sin_gasto: 2 });
    expect(f.categorias.map((c) => c.categoria)).toEqual(["Compras y ropa", "Restaurantes"]); // sin las de monto 0
    expect(f.categorias[0]).toMatchObject({ gastado: "$50,000", mes_anterior_mismo_periodo: "$40,000", cambio: "25%" });
    expect(f.categorias[1].cambio).toBeNull();
    expect(f.dia_de_la_semana_mas_caro).toEqual({ dia: "viernes", monto: "$30,000" });
    expect(f.ultimos_meses.map((m) => m.gastado)).toEqual(["$200,000", "$210,000"]); // sin el mes analizado
    expect(f.meses_sin_intereses).toMatchObject({ se_cobra_este_mes: "$12,000", planes_vigentes: 3, terminas_de_pagar: "junio 2027" });
    expect(f.metas_de_ahorro).toEqual({ metas_pendientes: 2, metas_a_tiempo: 1, excedente_mensual_tipico: "$120,000" });
  });
  it("nunca incluye comercios", () => {
    expect(JSON.stringify(f)).not.toMatch(/liverpool/i);
    expect(MONTH_SYSTEM).toContain("No menciones comercios");
  });
  it("un mes cerrado no trae proyección; sin MSI ni metas se omiten", () => {
    const c = buildMonthFacts(ins({ isCurrent: false, month: "2026-09" }), { msi: { loadNow: 0, remaining: 0, active: 0, freeMonth: null }, goals: null });
    expect(c.situacion).toBe("mes cerrado");
    expect(c).not.toHaveProperty("proyeccion_al_cierre_del_mes");
    expect(c.meses_sin_intereses).toBeNull();
    expect(c.metas_de_ahorro).toBeNull();
  });
  it("sin ingreso no inventa porcentajes", () => {
    const c = buildMonthFacts(ins({ income: 0, usedPct: null, savedPct: null, projectedPct: null }), extras);
    expect(c.ingreso_mensual).toBeNull();
    expect(c.porcentaje_del_ingreso_gastado).toBeNull();
  });
  it("huella y clave: cambian con el mes, las compras o el ingreso; no con centavos", () => {
    const h = monthRecapHash(ins());
    expect(monthRecapHash(ins({ count: 81 }))).not.toBe(h);
    expect(monthRecapHash(ins({ month: "2026-09" }))).not.toBe(h);
    expect(monthRecapHash(ins({ income: 400_000_00 }))).not.toBe(h);
    expect(monthRecapHash(ins({ spent: 120_000_00 + 99 }))).toBe(h);
    expect(monthRecapKey("2026-10")).toBe("month_recap:2026-10");
  });
});

describe("generateVerified", () => {
  const facts = { gastado: "$120,000" };
  const reply = (...t: string[]) => { const f = vi.fn(); t.forEach((x) => f.mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: x } }] }))); return f; };
  const run = (f: ReturnType<typeof vi.fn>) => generateVerified({ apiKey: "sk-or-test-key-1234567890", model: "a/b", system: "S", facts, fetchImpl: f as unknown as typeof fetch });

  it("acepta montos presentes en las cifras", async () => {
    const f = reply("Gastaste $120,000.");
    expect(await run(f)).toBe("Gastaste $120,000.");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("reintenta una vez si inventa un monto y si persiste lanza LlmError", async () => {
    const f = reply("Gastaste $99,999.", "Gastaste $120,000.");
    expect(await run(f)).toBe("Gastaste $120,000.");
    expect(f).toHaveBeenCalledTimes(2);
    await expect(run(reply("$1,111", "$2,222"))).rejects.toThrow(LlmError);
  });
  it("unknownAmounts acepta cualquier estructura de cifras", () => {
    expect(unknownAmounts("$5 y $120,000", facts)).toEqual(["$5"]);
  });
});
