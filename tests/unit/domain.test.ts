import { describe, expect, it } from "vitest";
import { matchRule } from "@/lib/categorizer";
import { matchCard } from "@/lib/repo/cards";
import { dedupeHash } from "@/lib/repo/transactions";
import { cutoffDay } from "@/lib/repo/stats";
import { normalizeMerchant } from "@/lib/merchant";
import { formatMXN, MoneyParseError, parseAmountToCents } from "@/lib/money";
import { csvSource, parseCsvText } from "@/lib/sources/csv";
import { ingestSchema, toRaw } from "@/lib/sources/shortcut";
import { currentMonth, daysInMonth, localDate, prevMonth } from "@/lib/time";
import type { Card, Rule } from "@/lib/types";

describe("parseAmountToCents", () => {
  it.each([
    ["$1,234.50", 123450], ["1234.5", 123450], ["99", 9900], ["MXN 10.05", 1005], ["-45.20", -4520], ["($12.00)", -1200],
    [12, 1200], [0.1 + 0.2, 30], ["1,000", 100000], [19.99, 1999],
  ])("%s → %i", (i, c) => expect(parseAmountToCents(i as string | number)).toBe(c));
  it.each(["", "abc", "1.234,56", "12.345", "1,23", "0", "0.00", "1e5", "--5", "$", "NaN"])("rechaza %j", (i) => expect(() => parseAmountToCents(i)).toThrow(MoneyParseError));
  it("rechaza no finitos y montos absurdos", () => {
    expect(() => parseAmountToCents(Infinity)).toThrow();
    expect(() => parseAmountToCents(1e12)).toThrow();
  });
  it("formatMXN", () => expect(formatMXN(123450)).toMatch(/1,234\.50/));
});

describe("normalizeMerchant", () => {
  it("quita acentos, folios y símbolos", () => {
    expect(normalizeMerchant("Café   Ágora #1234 ")).toBe("CAFE AGORA");
    expect(normalizeMerchant("OXXO 98765 CDMX")).toBe("OXXO CDMX");
    expect(normalizeMerchant("Apple.com/bill")).toBe("APPLE COM BILL");
  });
});

describe("matchRule", () => {
  const r = (id: number, pattern: string, cat: number, match_type: Rule["match_type"] = "contains", priority = 0): Rule => ({ id, pattern, match_type, category_id: cat, priority });
  it("contains / startswith / exact", () => {
    const rules = [r(1, "STARBUCKS", 10), r(2, "UBER", 20, "startswith"), r(3, "OXXO", 30, "exact")];
    expect(matchRule(rules, "STARBUCKS REFORMA")).toBe(10);
    expect(matchRule(rules, "UBER EATS")).toBe(20);
    expect(matchRule(rules, "MI UBER")).toBeNull();
    expect(matchRule(rules, "OXXO")).toBe(30);
    expect(matchRule(rules, "OXXO CDMX")).toBeNull();
  });
  it("gana mayor prioridad y luego el patrón más específico", () => {
    expect(matchRule([r(1, "UBER", 1), r(2, "UBER EATS", 2)], "UBER EATS MX")).toBe(2);
    expect(matchRule([r(1, "UBER EATS", 1, "contains", 0), r(2, "UBER", 2, "contains", 5)], "UBER EATS MX")).toBe(2);
  });
});

describe("matchCard", () => {
  const card = (id: number, name: string, last4: string | null, aliases: string | null): Card => ({ id, name, issuer: "banamex", last4, aliases, color: "#fff", active: true });
  const cards = [card(1, "Banamex Oro", "4412", "Oro Visa, Citibanamex Oro"), card(2, "American Express Platinum", "1005", "Amex"), card(3, "Banamex Costco", "7788", null)];
  it("por nombre, alias (sin acentos/mayúsculas) y últimos 4", () => {
    expect(matchCard(cards, "banamex oro")?.id).toBe(1);
    expect(matchCard(cards, "AMEX")?.id).toBe(2);
    expect(matchCard(cards, "Citibanamex Oro")?.id).toBe(1);
    expect(matchCard(cards, "Tarjeta •••• 7788")?.id).toBe(3);
  });
  it("devuelve null si es ambiguo o desconocido", () => {
    expect(matchCard(cards, "Visa Platino")).toBeNull();
    expect(matchCard([card(1, "A", "1111", null), card(2, "B", "1111", null)], "x 1111")).toBeNull();
  });
});

describe("dedupeHash", () => {
  const base = { cardId: 1, occurredAt: new Date("2026-09-10T15:30:10Z"), cents: 5000, merchantNormalized: "OXXO", source: "shortcut" as const };
  it("es determinista y estable dentro del mismo minuto", () => {
    expect(dedupeHash(base)).toBe(dedupeHash({ ...base, occurredAt: new Date("2026-09-10T15:30:55Z") }));
    expect(dedupeHash(base)).toHaveLength(64);
  });
  it("cambia con tarjeta, monto, comercio o minuto", () => {
    const h = dedupeHash(base);
    for (const alt of [{ cardId: 2 }, { cents: 5001 }, { merchantNormalized: "OXXO2" }, { occurredAt: new Date("2026-09-10T15:31:00Z") }]) {
      expect(dedupeHash({ ...base, ...alt })).not.toBe(h);
    }
  });
  it("estado de cuenta se agrupa por día", () => {
    const a = dedupeHash({ ...base, source: "statement" });
    expect(a).toBe(dedupeHash({ ...base, source: "statement", occurredAt: new Date("2026-09-10T20:00:00Z") }));
  });
});

describe("schema del Atajo", () => {
  const ok = { merchant: "OXXO", amount: "$55.00", card: "Banamex Oro" };
  it("acepta payload válido (monto como texto o número, fecha ISO)", () => {
    expect(ingestSchema.safeParse(ok).success).toBe(true);
    expect(ingestSchema.safeParse({ ...ok, amount: 55.5, date: "2026-09-10T12:00:00-06:00" }).success).toBe(true);
  });
  it("rechaza faltantes, claves extra, tipos y fechas mal formadas", () => {
    for (const bad of [{}, { ...ok, extra: 1 }, { ...ok, merchant: "" }, { ...ok, merchant: "x".repeat(121) }, { ...ok, amount: {} }, { ...ok, date: "ayer" }, { ...ok, card: 5 }]) {
      expect(ingestSchema.safeParse(bad).success).toBe(false);
    }
  });
  it("toRaw rechaza montos inválidos y fechas futuras/antiguas", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    expect(toRaw(ingestSchema.parse(ok), now).amountCents).toBe(5500);
    expect(() => toRaw(ingestSchema.parse({ ...ok, amount: "gratis" }), now)).toThrow();
    expect(() => toRaw(ingestSchema.parse({ ...ok, date: "2026-12-25T00:00:00Z" }), now)).toThrow();
    expect(() => toRaw(ingestSchema.parse({ ...ok, date: "1999-01-01T00:00:00Z" }), now)).toThrow();
  });
});

describe("CSV", () => {
  it("parsea comillas, comas y saltos dentro de campo, BOM y CRLF", () => {
    const t = '﻿a,b\r\n"x, y","l1\nl2"\r\n"he said ""hi""",z\r\n';
    expect(parseCsvText(t)).toEqual([["a", "b"], ["x, y", "l1\nl2"], ['he said "hi"', "z"]]);
  });
  it("csvSource: encabezados en español, fechas AAAA-MM-DD y DD/MM/AAAA, reembolsos", () => {
    const { rows, errors } = csvSource.parse("fecha,comercio,monto,tarjeta,categoria\n2026-09-01,OXXO,\"1,200.50\",Banamex Oro,Súper\n05/09/2026,Amazon,-459.00,Amex,\n");
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.amountCents)).toEqual([120050, -45900]);
    expect(localDate(rows[0].occurredAt)).toBe("2026-09-01");
    expect(localDate(rows[1].occurredAt)).toBe("2026-09-05");
    expect(rows[0].categoryName).toBe("Súper");
  });
  it("reporta filas inválidas con su número de línea y columnas faltantes", () => {
    const r = csvSource.parse("date,merchant,amount,card\n2026-09-01,OXXO,abc,Oro\n2026-13-40,X,10,Oro\n2026-09-02,,10,Oro\n2026-09-03,OK,10,Oro");
    expect(r.rows).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4]);
    expect(csvSource.parse("a,b\n1,2").errors[0].message).toMatch(/falta la columna/);
    expect(csvSource.parse("").errors).toHaveLength(1);
  });
});

describe("fechas", () => {
  it("localDate usa America/Mexico_City (UTC-6)", () => {
    expect(localDate(new Date("2026-09-11T03:00:00Z"))).toBe("2026-09-10");
    expect(localDate(new Date("2026-09-11T07:00:00Z"))).toBe("2026-09-11");
  });
  it("prevMonth / daysInMonth / cutoffDay", () => {
    expect(prevMonth("2026-01")).toBe("2025-12");
    expect(prevMonth("2026-03")).toBe("2026-02");
    expect(daysInMonth("2028-02")).toBe(29);
    const now = new Date("2026-10-15T18:00:00Z");
    expect(currentMonth(now)).toBe("2026-10");
    expect(cutoffDay("2026-10", now)).toBe(15);
    expect(cutoffDay("2026-09", now)).toBe(30);
  });
});
