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
    expect(c.telegram).toEqual({ enabled: false, minSeverity: "warn" });
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

describe("telegram en la configuración", () => {
  it("una configuración guardada ANTES de existir `telegram` lo lee apagado, con el resto intacto", () => {
    const c = parseAlertConfig(JSON.stringify({ largePurchaseCents: 700_000, whatsapp: { enabled: true, minSeverity: "high" } }));
    expect(c.telegram).toEqual({ enabled: false, minSeverity: "warn" });
    expect(c.whatsapp).toEqual({ enabled: true, minSeverity: "high" });
    expect(c.largePurchaseCents).toBe(700_000);
  });
  it("tolerante: campos malos caen a su default y los buenos se conservan; `telegram` corrupto entero = defaults", () => {
    expect(parseAlertConfig({ telegram: { enabled: true, minSeverity: "urgente" } }).telegram).toEqual({ enabled: true, minSeverity: "warn" });
    expect(parseAlertConfig({ telegram: { enabled: "sí", minSeverity: "high" } }).telegram).toEqual({ enabled: false, minSeverity: "high" });
    for (const bad of [null, 7, "x", [], true]) expect(parseAlertConfig({ telegram: bad }).telegram).toEqual({ enabled: false, minSeverity: "warn" });
  });
  it("el parche es parcial y no toca WhatsApp (ni al revés)", () => {
    const a = applyAlertConfigPatch(DEFAULT_ALERT_CONFIG, { telegram: { enabled: true } });
    expect(a.telegram).toEqual({ enabled: true, minSeverity: "warn" });
    expect(a.whatsapp).toEqual(DEFAULT_ALERT_CONFIG.whatsapp);
    const b = applyAlertConfigPatch(a, { telegram: { minSeverity: "high" }, whatsapp: { enabled: true } });
    expect(b.telegram).toEqual({ enabled: true, minSeverity: "high" });
    expect(b.whatsapp).toEqual({ enabled: true, minSeverity: "warn" });
  });
  it("devuelve copias: mutar el resultado no contamina los defaults", () => {
    const c = parseAlertConfig({});
    c.telegram.enabled = true;
    expect(DEFAULT_ALERT_CONFIG.telegram.enabled).toBe(false);
    expect(parseAlertConfig({}).telegram.enabled).toBe(false);
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
    ["severidad de Telegram inválida", { telegram: { minSeverity: "x" } }],
    ["Telegram: interruptor no booleano", { telegram: { enabled: "sí" } }],
    ["Telegram: clave desconocida", { telegram: { token: "x" } }],
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
