import { describe, expect, it } from "vitest";
import { resolveArt } from "@/lib/card-art";
import { buildInsights, type InsightInput } from "@/lib/insights";

const base: InsightInput = {
  month: "2026-09", isCurrent: true, income: 100_000_00, spent: 40_000_00, prevSamePeriod: 30_000_00, elapsedDays: 15, daysInMonth: 30,
  projected: 80_000_00, avgPerDay: 2_666_00, prevAvgPerDay: 2_000_00, topDay: { date: "2026-09-12", cents: 9_000_00 },
  topWeekday: { name: "sábado", cents: 12_000_00 },
  categoryDeltas: [{ name: "Restaurantes", cents: 15_000_00, prevCents: 5_000_00 }, { name: "Súper", cents: 2_000_00, prevCents: 9_000_00 }],
};
const texts = (i: InsightInput) => buildInsights(i).map((m) => m.text);

describe("buildInsights", () => {
  it("avisa cuando vas más rápido que el calendario y proyecta el cierre", () => {
    const m = buildInsights({ ...base, spent: 60_000_00 });
    expect(m[0]).toMatchObject({ tone: "warn" });
    expect(m[0].text).toContain("60%");
    expect(m[0].text).toContain("50%");
    expect(m[1].text).toMatch(/cerrarás en .*80%.* ahorrarías/);
  });
  it("si la proyección rebasa el ingreso lo dice como alerta", () => {
    const m = buildInsights({ ...base, projected: 130_000_00 });
    expect(m[1]).toMatchObject({ tone: "warn" });
    expect(m[1].text).toContain("superarías tu ingreso");
  });
  it("va dentro del ritmo cuando gastas menos que el calendario", () => {
    expect(buildInsights(base)[0]).toMatchObject({ tone: "good" });
  });
  it("compara contra el mes anterior, el promedio diario y las categorías", () => {
    const t = texts(base).join("\n");
    expect(t).toContain("33% más que en el mismo periodo de agosto");
    expect(t).toContain("33% arriba del de agosto");
    expect(t).toMatch(/Restaurantes es lo que más subió: \+.* \(\+200%\)/);
    expect(t).toMatch(/Súper bajó/);
  });
  it("mes cerrado: habla de ahorro o de déficit real, sin proyección", () => {
    const ok = texts({ ...base, isCurrent: false, elapsedDays: 30, spent: 70_000_00, projected: 70_000_00 });
    expect(ok[0]).toMatch(/Gastaste 70% de tu ingreso y ahorraste/);
    expect(ok.join(" ")).not.toContain("cerrarás");
    expect(texts({ ...base, isCurrent: false, spent: 120_000_00 })[0]).toMatch(/Gastaste .* más de lo que ingresó/);
  });
  it("sin ingreso configurado no inventa porcentajes; sin datos devuelve vacío", () => {
    expect(texts({ ...base, income: 0 }).join(" ")).not.toContain("de tu ingreso");
    expect(buildInsights({ ...base, spent: 0, prevSamePeriod: 0, avgPerDay: 0, prevAvgPerDay: 0, topDay: null, topWeekday: null, categoryDeltas: [] })).toEqual([]);
  });
  it("máximo 6 frases", () => {
    expect(buildInsights(base).length).toBeLessThanOrEqual(6);
  });
});

describe("resolveArt", () => {
  const c = (name: string, issuer: "amex" | "banamex" | "nu" | "other", art: null | "nu" = null) => ({ name, issuer, art });
  it("deduce el diseño del emisor y del nombre (sin acentos ni mayúsculas)", () => {
    expect(resolveArt(c("American Express Platinum", "amex"))).toBe("amex-platinum");
    expect(resolveArt(c("Explora Banamex Virtual", "banamex"))).toBe("banamex-explora");
    expect(resolveArt(c("Clásica Banamex", "banamex"))).toBe("banamex-clasica");
    expect(resolveArt(c("Costco Banamex ···194", "banamex"))).toBe("banamex-costco");
    expect(resolveArt(c("Débito ···296", "banamex"))).toBe("banamex-debito");
    expect(resolveArt(c("Nu Mastercard Gold", "nu"))).toBe("nu");
    expect(resolveArt(c("Revolut", "other"))).toBe("generic");
    expect(resolveArt(c("Banamex sin nombrar", "banamex"))).toBe("generic");
  });
  it("el diseño elegido manda sobre la deducción", () => {
    expect(resolveArt(c("Mi tarjeta", "other", "nu"))).toBe("nu");
  });
});
