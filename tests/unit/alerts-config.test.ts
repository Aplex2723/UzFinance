import { describe, expect, it } from "vitest";
import { z } from "zod";
import { applyAlertConfigPatch, DEFAULT_ALERT_CONFIG, parseAlertConfig } from "@/lib/alerts/config";
import { ALERT_RULES } from "@/lib/alerts/types";

describe("parseAlertConfig (lectura tolerante)", () => {
  it("vacío, null, basura, JSON roto, arreglo: defaults", () => {
    for (const raw of [undefined, null, "", "{no json", "null", "[]", 42, true, {}]) expect(parseAlertConfig(raw)).toEqual(DEFAULT_ALERT_CONFIG);
  });
  it("defaults razonables y todas las reglas encendidas", () => {
    const c = parseAlertConfig({});
    expect(c.largePurchaseCents).toBe(500_000);
    expect(c.largeVsTypicalFactor).toBe(3);
    expect(c.whatsapp).toEqual({ enabled: false, minSeverity: "warn" });
    expect(Object.keys(c.enabled).sort()).toEqual([...ALERT_RULES].sort());
    expect(Object.values(c.enabled).every(Boolean)).toBe(true);
  });
  it("cada campo inválido cae a su default y conserva los válidos", () => {
    const c = parseAlertConfig({ largePurchaseCents: -5, largeVsTypicalFactor: 4, mutedCategoryIds: ["x"], enabled: { daily_spike: false, large_purchase: "no" }, whatsapp: { enabled: true, minSeverity: "urgente" } });
    expect(c.largePurchaseCents).toBe(500_000);
    expect(c.largeVsTypicalFactor).toBe(4);
    expect(c.mutedCategoryIds).toEqual([]);
    expect(c.enabled.daily_spike).toBe(false);
    expect(c.enabled.large_purchase).toBe(true);
    expect(c.whatsapp).toEqual({ enabled: true, minSeverity: "warn" });
  });
  it("acepta el JSON guardado como string", () => {
    expect(parseAlertConfig(JSON.stringify({ dailySpikeFactor: 5 })).dailySpikeFactor).toBe(5);
  });
  it("fuera de rango (NaN, enorme, decimal en centavos) cae a default", () => {
    const c = parseAlertConfig({ largePurchaseCents: 1.5, dailySpikeFactor: 1e9, paceTolerancePct: NaN, newMerchantCents: 99_999_999_99 });
    expect(c).toMatchObject({ largePurchaseCents: 500_000, dailySpikeFactor: 3, paceTolerancePct: 25, newMerchantCents: 200_000 });
  });
  it("devuelve copias: mutar el resultado no contamina los defaults", () => {
    const c = parseAlertConfig({});
    c.mutedMerchants.push("X");
    c.enabled.daily_spike = false;
    expect(DEFAULT_ALERT_CONFIG.mutedMerchants).toEqual([]);
    expect(parseAlertConfig({}).enabled.daily_spike).toBe(true);
  });
  it("comercios silenciados se normalizan y se deduplican", () => {
    expect(parseAlertConfig({ mutedMerchants: ["  Renta Depa ", "RENTA DEPA", "café #123"] }).mutedMerchants).toEqual(["RENTA DEPA", "CAFE"]);
  });
});

describe("applyAlertConfigPatch (escritura estricta)", () => {
  const cur = DEFAULT_ALERT_CONFIG;
  it("parche parcial se mezcla sin perder lo demás (incluso anidado)", () => {
    const n = applyAlertConfigPatch(cur, { largePurchaseCents: 800_000, enabled: { daily_spike: false }, whatsapp: { enabled: true } });
    expect(n.largePurchaseCents).toBe(800_000);
    expect(n.enabled.daily_spike).toBe(false);
    expect(n.enabled.large_purchase).toBe(true);
    expect(n.whatsapp).toEqual({ enabled: true, minSeverity: "warn" });
    expect(n.dailySpikeFactor).toBe(3);
  });
  it("parche vacío = igual", () => {
    expect(applyAlertConfigPatch(cur, {})).toEqual(cur);
  });
  it.each([
    ["monto negativo", { largePurchaseCents: -1 }],
    ["monto no entero", { largePurchaseCents: 100.5 }],
    ["demasiado bajo", { largePurchaseCents: 10 }],
    ["factor fuera de rango", { largeVsTypicalFactor: 1 }],
    ["clave desconocida", { hackeo: true }],
    ["regla desconocida", { enabled: { nope: true } }],
    ["severidad inválida", { whatsapp: { minSeverity: "x" } }],
    ["hora inválida", { quietHours: { start: "25:00" } }],
    ["muted no numérico", { mutedCategoryIds: [1, "a"] }],
    ["muted negativo", { mutedCategoryIds: [-1] }],
    ["comercio vacío", { mutedMerchants: ["   "] }],
    ["no es objeto", "texto"],
    ["null", null],
  ])("rechaza: %s", (_n, patch) => {
    expect(() => applyAlertConfigPatch(cur, patch)).toThrow(z.ZodError);
  });
  it("horas de silencio válidas se guardan", () => {
    expect(applyAlertConfigPatch(cur, { quietHours: { enabled: true, start: "23:30", end: "07:15" } }).quietHours).toEqual({ enabled: true, start: "23:30", end: "07:15" });
  });
  it("silenciar comercios y categorías", () => {
    const n = applyAlertConfigPatch(cur, { mutedMerchants: ["Transferencias SPEI"], mutedCategoryIds: [3, 3, 4] });
    expect(n.mutedMerchants).toEqual(["TRANSFERENCIAS SPEI"]);
    expect(n.mutedCategoryIds).toEqual([3, 4]);
  });
});
