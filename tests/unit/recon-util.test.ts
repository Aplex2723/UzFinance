import { describe, expect, it } from "vitest";
import { matchByKey } from "@/lib/recon/match";
import { clip, dayDiff, fingerprint, merchantKey, plain, shiftDay, similarity } from "@/lib/recon/util";

const sim = (a: string, b: string) => similarity(merchantKey(a), merchantKey(b));

describe("util de conciliación", () => {
  it("días entre fechas con cambio de mes, año y bisiesto", () => {
    expect(dayDiff("2026-12-31", "2027-01-02")).toBe(2);
    expect(dayDiff("2028-03-01", "2028-02-28")).toBe(2);
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("similitud de comercios: iguales, contenidos, tokens en común y sin relación", () => {
    expect(sim("Starbucks", "STARBUCKS")).toBe(1);
    expect(sim("MERCADO LIBRE", "MERCADOLIBRE")).toBe(1);
    expect(sim("Amazon", "AMAZON MX*2H4K9")).toBeGreaterThanOrEqual(0.5);
    expect(sim("Restaurante Luna", "RESTAURANTE LUNA 123")).toBeGreaterThanOrEqual(0.9);
    expect(sim("FARMACIA", "GASOLINERA")).toBe(0);
    expect(sim("", "X")).toBe(0);
    expect(sim("🔥", "🔥")).toBe(0); // sin texto comparable no se afirma nada
  });

  it("clip no parte un emoji y plain quita control/saltos", () => {
    expect(clip("ab🔥", 3)).toBe("ab");
    expect(clip("abc", 3)).toBe("abc");
    expect(plain("a\nb\u0000c‮d")).toBe("a b c d");
    expect(plain("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("fingerprint estable y sensible a cada parte", () => {
    expect(fingerprint("a", 1, null)).toBe(fingerprint("a", 1, undefined));
    expect(fingerprint("a", 1)).not.toBe(fingerprint("a", 2));
    expect(fingerprint("x")).toHaveLength(40);
  });
});

describe("matchByKey", () => {
  const args = (lineDays: number[], rowDays: number[], lineKeys = lineDays.map(() => 1), rowKeys = rowDays.map(() => 1)) => ({
    lineKeys, rowKeys, days: (i: number, j: number) => Math.abs(lineDays[i] - rowDays[j]), sim: () => 1, maxDays: 3,
  });
  it("maximiza parejas antes que minimizar fechas", () => {
    expect(matchByKey(args([10, 11], [11, 14]))).toEqual([[0, 0], [1, 1]]);
  });
  it("solo empareja el mismo monto", () => {
    expect(matchByKey(args([1, 1], [1, 1], [5, 6], [6, 5]))).toEqual([[0, 1], [1, 0]]);
  });
  it("grupos enormes (patológicos) usan el voraz y siguen siendo uno a uno", () => {
    const n = 250;
    const days = Array.from({ length: n }, (_, i) => i % 3);
    const r = matchByKey(args(days, days));
    expect(r).toHaveLength(n);
    expect(new Set(r.map((p) => p[1])).size).toBe(n);
  });
});
