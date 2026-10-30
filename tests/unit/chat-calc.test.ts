import { describe, expect, it } from "vitest";
import { calculate, CalcError } from "@/lib/chat/calc";

describe("calculadora de UzChat", () => {
  it("aritmética con precedencia y paréntesis", () => {
    expect(calculate("2+3*4")).toBe(14);
    expect(calculate("(2+3)*4")).toBe(20);
    expect(calculate("(50000-12000)/6")).toBeCloseTo(6333.33333333, 6);
    expect(calculate("10 - 2 - 3")).toBe(5);
    expect(calculate("100/4/5")).toBe(5);
  });
  it("potencias (derecha a izquierda) y signo", () => {
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-2^2")).toBe(-4);
    expect(calculate("2^-1")).toBe(0.5);
    expect(calculate("-(3+2)")).toBe(-5);
    expect(calculate("10000*(1+0.08/12)^24")).toBeCloseTo(11728.88, 2);
  });
  it("porcentajes posfijos, $ y espacios", () => {
    expect(calculate("$50000 * 15%")).toBe(7500);
    expect(calculate("200 + 10%")).toBe(200.1); // el % solo afecta al número que le precede
    expect(calculate(" 1 + 1 ")).toBe(2);
  });
  it("funciones", () => {
    expect(calculate("round(2.567, 1)")).toBe(2.6);
    expect(calculate("round(2.5)")).toBe(3);
    expect(calculate("ceil(7.1)+floor(7.9)")).toBe(15);
    expect(calculate("max(3, 9, 4) - min(3, 9, 4)")).toBe(6);
    expect(calculate("sqrt(81)+abs(-2)")).toBe(11);
  });
  it("redondea en decimal (1.005 → 1.01) y no funde números separados por espacios", () => {
    expect(calculate("round(1.005, 2)")).toBe(1.01);
    expect(calculate("round(2.675, 2)")).toBe(2.68);
    expect(calculate("round(1234.5)")).toBe(1235);
    expect(() => calculate("10 20")).toThrow(/dos números/);
    expect(() => calculate("1 500+1")).toThrow(CalcError);
    expect(calculate("10 + 20")).toBe(30);
  });
  it("evita ruido de coma flotante", () => {
    expect(calculate("0.1+0.2")).toBe(0.3);
  });
  it("rechaza lo que no es aritmética (nunca ejecuta código)", () => {
    for (const bad of ["", "   ", "1/0", "2+", "(1+2", "1+2)", "foo(1)", "round", "process.exit()", "1;2", "a+1", "2**3", "1,500+1", "constructor", "sqrt()", "9".repeat(201)]) {
      expect(() => calculate(bad), bad.slice(0, 20)).toThrow(CalcError);
    }
  });
  it("un resultado no finito es error", () => {
    expect(() => calculate("10^1000")).toThrow(CalcError);
    expect(() => calculate("sqrt(-1)")).toThrow(CalcError);
  });
});
