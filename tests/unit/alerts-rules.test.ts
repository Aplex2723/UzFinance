import { describe, expect, it } from "vitest";
import { parseAlertConfig } from "@/lib/alerts/config";
import { addDays, daysBetween, isoWeekKey, longDay } from "@/lib/alerts/dates";
import {
  dailySpikeCandidate, duplicateCandidate, goalCandidate, isAlertableExpense, isDuplicatePair, isMuted, isRecurringTx, isStale, largeAlertCandidate,
  largePurchaseSignal, median, newMerchantSignal, paceCandidate, unconfirmedCandidate, type DupFacts, type PaceInput, type SpikeInput, type TxFacts, type TxHistory,
} from "@/lib/alerts/rules";

const cfg = parseAlertConfig({});
const TODAY = "2026-10-04";
const tx = (o: Partial<TxFacts> = {}): TxFacts => ({
  id: 10, cents: 6_000_00, kind: "expense", occurredDate: TODAY, merchantNormalized: "LIVERPOOL", merchantRaw: "LIVERPOOL POLANCO", categoryId: 3, cardName: "Banamex Oro", isRecurring: false, ...o,
});
const hist = (o: Partial<TxHistory> = {}): TxHistory => ({ merchantSamples: [], categorySamples: [], merchantSeen: true, priorExpenseCount: 100, priorSameMerchant: [], ...o });
const nums = (n: number, v: number) => Array.from({ length: n }, () => v);

describe("utilidades", () => {
  it("median: impar, par, vacío, no finitos", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(median([NaN, Infinity])).toBeNull();
    expect(median([NaN, 5, 7])).toBe(6);
  });
  it("isStale: hasta 3 días atrás cuenta; 4 ya no; futuro no es viejo; fecha rota sí", () => {
    expect(isStale("2026-10-04", TODAY)).toBe(false);
    expect(isStale("2026-10-01", TODAY)).toBe(false);
    expect(isStale("2026-09-30", TODAY)).toBe(true);
    expect(isStale("2026-10-05", TODAY)).toBe(false);
    expect(isStale("basura", TODAY)).toBe(true);
  });
  it("isStale cruza el cambio de mes y año", () => {
    expect(isStale("2026-02-26", "2026-03-01")).toBe(false); // 3 días (febrero de 28)
    expect(isStale("2026-02-25", "2026-03-01")).toBe(true);
    expect(isStale("2025-12-30", "2026-01-02")).toBe(false);
    expect(isStale("2025-12-29", "2026-01-02")).toBe(true);
  });
  it("fechas: addDays, daysBetween, febrero bisiesto y semana ISO", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-02-01", "2026-03-01")).toBe(28);
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2027-01-03")).toBe("2026-W53");
    expect(isoWeekKey("2026-10-04")).toBe("2026-W40"); // domingo
    expect(isoWeekKey("2026-10-05")).toBe("2026-W41"); // lunes
    expect(longDay("2026-10-04")).toBe("4 de octubre");
  });
  it("isMuted: categoría y comercio (subcadena normalizada)", () => {
    const c = parseAlertConfig({ mutedMerchants: ["Renta Depa"], mutedCategoryIds: [7] });
    expect(isMuted({ merchantNormalized: "PAGO RENTA DEPA 12", categoryId: null }, c)).toBe(true);
    expect(isMuted({ merchantNormalized: "OXXO", categoryId: 7 }, c)).toBe(true);
    expect(isMuted({ merchantNormalized: "OXXO", categoryId: 8 }, c)).toBe(false);
    expect(isMuted({ merchantNormalized: "", categoryId: null }, c)).toBe(false);
  });
  it("isAlertableExpense: reembolsos, cero, pago de tarjeta, NaN y viejos nunca", () => {
    expect(isAlertableExpense(tx(), cfg, TODAY)).toBe(true);
    expect(isAlertableExpense(tx({ cents: -9_000_00 }), cfg, TODAY)).toBe(false);
    expect(isAlertableExpense(tx({ cents: 0 }), cfg, TODAY)).toBe(false);
    expect(isAlertableExpense(tx({ cents: NaN }), cfg, TODAY)).toBe(false);
    expect(isAlertableExpense(tx({ kind: "card_payment", cents: 50_000_00 }), cfg, TODAY)).toBe(false);
    expect(isAlertableExpense(tx({ occurredDate: "2026-09-01" }), cfg, TODAY)).toBe(false);
  });
  it("isRecurringTx: bandera, ±5 % entre 20 y 70 días, fuera de rango no", () => {
    expect(isRecurringTx(100, true, [])).toBe(true);
    expect(isRecurringTx(1000_00, false, [{ cents: 1040_00, daysAgo: 30 }])).toBe(true);
    expect(isRecurringTx(1000_00, false, [{ cents: 1060_00, daysAgo: 30 }])).toBe(false);
    expect(isRecurringTx(1000_00, false, [{ cents: 1000_00, daysAgo: 7 }])).toBe(false); // semanal: no es "mensual"
    expect(isRecurringTx(1000_00, false, [{ cents: 1000_00, daysAgo: 90 }])).toBe(false);
    expect(isRecurringTx(1000_00, false, [{ cents: NaN, daysAgo: 30 }])).toBe(false);
  });
});

describe("1. large_purchase", () => {
  it("arranque en frío: solo el umbral absoluto", () => {
    expect(largePurchaseSignal(4_999_99, hist(), cfg)).toBeNull();
    expect(largePurchaseSignal(5_000_00, hist(), cfg)).toMatchObject({ severity: "warn", absolute: true, typical: null });
    expect(largePurchaseSignal(9_999_99, hist(), cfg)?.severity).toBe("warn");
    expect(largePurchaseSignal(10_000_00, hist(), cfg)?.severity).toBe("high"); // 2× umbral
  });
  it("monto cero, negativo o no finito no dispara", () => {
    for (const c of [0, -1, -9_000_00, NaN, Infinity]) expect(largePurchaseSignal(c, hist(), cfg)).toBeNull();
  });
  it("relativa: ≥ 3× mediana del comercio con ≥5 muestras y ≥ $500", () => {
    const h = hist({ merchantSamples: nums(5, 300_00) });
    expect(largePurchaseSignal(899_99, h, cfg)).toBeNull();
    const s = largePurchaseSignal(900_00, h, cfg);
    expect(s).toMatchObject({ severity: "warn", absolute: false });
    expect(s?.typical).toMatchObject({ median: 300_00, scope: "merchant" });
  });
  it("relativa: menos de 5 muestras no cuenta", () => {
    expect(largePurchaseSignal(4_000_00, hist({ merchantSamples: nums(4, 100_00) }), cfg)).toBeNull();
  });
  it("relativa: el mínimo razonable protege los cafecitos", () => {
    const h = hist({ merchantSamples: nums(6, 30_00) }); // 3× = $90 < $500
    expect(largePurchaseSignal(400_00, h, cfg)).toBeNull();
    expect(largePurchaseSignal(500_00, h, cfg)?.severity).toBe("warn");
  });
  it("usa la categoría si el comercio no tiene muestras suficientes", () => {
    const h = hist({ merchantSamples: [100_00], categorySamples: nums(8, 400_00) });
    expect(largePurchaseSignal(1_300_00, h, cfg)?.typical).toMatchObject({ scope: "category", median: 400_00 });
    expect(largePurchaseSignal(1_100_00, h, cfg)).toBeNull();
  });
  it("relativa a high solo si duplica el umbral y pesa ≥ la mitad del absoluto", () => {
    const h = hist({ merchantSamples: nums(10, 500_00) }); // umbral relativo $1,500
    expect(largePurchaseSignal(2_900_00, h, cfg)?.severity).toBe("warn"); // por debajo de 2× el umbral relativo ($3,000)
    expect(largePurchaseSignal(3_000_00, h, cfg)?.severity).toBe("high");
    // 2× el umbral relativo pero pesa menos que la mitad del absoluto: sigue siendo warn
    expect(largePurchaseSignal(1_000_00, hist({ merchantSamples: nums(10, 100_00) }), cfg)?.severity).toBe("warn");
  });
  it("muestras con basura (NaN, ≤0) se ignoran", () => {
    const h = hist({ merchantSamples: [NaN, -5, 0, 100_00, 100_00, 100_00, 100_00, 100_00] });
    expect(largePurchaseSignal(600_00, h, cfg)?.typical?.median).toBe(100_00);
  });
  it("respeta umbrales configurados", () => {
    const c = parseAlertConfig({ largePurchaseCents: 1_000_00 });
    expect(largePurchaseSignal(1_000_00, hist(), c)?.severity).toBe("warn");
    expect(largePurchaseSignal(2_000_00, hist(), c)?.severity).toBe("high");
  });
});

describe("2. new_merchant_large", () => {
  it("comercio nunca visto con monto alto (y historial suficiente)", () => {
    expect(newMerchantSignal(2_000_00, hist({ merchantSeen: false }), cfg)).toEqual({ severity: "warn" });
    expect(newMerchantSignal(1_999_99, hist({ merchantSeen: false }), cfg)).toBeNull();
    expect(newMerchantSignal(5_000_00, hist({ merchantSeen: false }), cfg)).toEqual({ severity: "high" });
  });
  it("comercio ya visto o arranque en frío (sin historial): no", () => {
    expect(newMerchantSignal(9_000_00, hist({ merchantSeen: true }), cfg)).toBeNull();
    expect(newMerchantSignal(9_000_00, hist({ merchantSeen: false, priorExpenseCount: 3 }), cfg)).toBeNull();
    expect(newMerchantSignal(NaN, hist({ merchantSeen: false }), cfg)).toBeNull();
  });
});

describe("largeAlertCandidate (compra fuerte + comercio nuevo en una sola alerta)", () => {
  it("compra fuerte normal", () => {
    const c = largeAlertCandidate(tx(), hist(), cfg, TODAY)!;
    expect(c).toMatchObject({ rule: "large_purchase", severity: "warn", dedupeKey: "large:10:warn", txId: 10 });
    expect(c.title).toContain("$6,000.00");
    expect(c.body).toContain("Supera tu umbral");
  });
  it("misma transacción, misma clave (determinística)", () => {
    expect(largeAlertCandidate(tx(), hist(), cfg, TODAY)!.dedupeKey).toBe(largeAlertCandidate(tx(), hist(), cfg, TODAY)!.dedupeKey);
  });
  it("cruzar a un umbral mayor cambia la clave (alerta nueva); distinta transacción, otra clave", () => {
    expect(largeAlertCandidate(tx({ cents: 11_000_00 }), hist(), cfg, TODAY)!.dedupeKey).toBe("large:10:high");
    expect(largeAlertCandidate(tx({ id: 11 }), hist(), cfg, TODAY)!.dedupeKey).toBe("large:11:warn");
  });
  it("comercio nuevo combina con compra fuerte y lo dice", () => {
    const c = largeAlertCandidate(tx({ cents: 6_000_00 }), hist({ merchantSeen: false }), cfg, TODAY)!;
    expect(c.rule).toBe("large_purchase");
    expect(c.severity).toBe("high");
    expect(c.body).toContain("primera vez");
  });
  it("solo comercio nuevo: regla new_merchant_large", () => {
    const c = largeAlertCandidate(tx({ cents: 2_500_00 }), hist({ merchantSeen: false }), cfg, TODAY)!;
    expect(c).toMatchObject({ rule: "new_merchant_large", severity: "warn" });
  });
  it("reglas apagadas no generan", () => {
    const off = parseAlertConfig({ enabled: { large_purchase: false } });
    expect(largeAlertCandidate(tx(), hist(), off, TODAY)).toBeNull();
    expect(largeAlertCandidate(tx({ cents: 2_500_00 }), hist({ merchantSeen: false }), off, TODAY)?.rule).toBe("new_merchant_large");
    const off2 = parseAlertConfig({ enabled: { large_purchase: false, new_merchant_large: false } });
    expect(largeAlertCandidate(tx({ cents: 2_500_00 }), hist({ merchantSeen: false }), off2, TODAY)).toBeNull();
  });
  it("reembolso, pago de tarjeta, silenciado y viejo: nada", () => {
    expect(largeAlertCandidate(tx({ cents: -9_000_00 }), hist(), cfg, TODAY)).toBeNull();
    expect(largeAlertCandidate(tx({ kind: "card_payment", cents: 90_000_00 }), hist(), cfg, TODAY)).toBeNull();
    expect(largeAlertCandidate(tx({ categoryId: 5 }), hist(), parseAlertConfig({ mutedCategoryIds: [5] }), TODAY)).toBeNull();
    expect(largeAlertCandidate(tx(), hist(), parseAlertConfig({ mutedMerchants: ["liverpool"] }), TODAY)).toBeNull();
    expect(largeAlertCandidate(tx({ occurredDate: "2026-09-20" }), hist(), cfg, TODAY)).toBeNull();
  });
  it("recurrente (renta): baja a info, también con la bandera", () => {
    const rent = tx({ cents: 12_000_00, merchantRaw: "RENTA DEPA" });
    expect(largeAlertCandidate(rent, hist({ priorSameMerchant: [{ cents: 12_000_00, daysAgo: 30 }] }), cfg, TODAY)).toMatchObject({ severity: "info", dedupeKey: "large:10:info" });
    expect(largeAlertCandidate({ ...rent, isRecurring: true }, hist(), cfg, TODAY)?.severity).toBe("info");
    expect(largeAlertCandidate(rent, hist(), cfg, TODAY)?.severity).toBe("high"); // sin historial de renta sí grita
  });
  it("texto hostil del comercio: una línea, sin control, truncado; el título cabe en 120", () => {
    const evil = `<script>alert(1)</script>\n‮${"X".repeat(300)}\u0000`;
    const c = largeAlertCandidate(tx({ merchantRaw: evil, cardName: "Tarjeta\r\n‮" }), hist(), cfg, TODAY)!;
    expect(c.title).not.toMatch(/[\n\r\u0000‮]/);
    expect(c.title.length).toBeLessThanOrEqual(130);
    expect(c.body).not.toMatch(/[\u0000‮]/);
    expect(c.body).toContain("<script>"); // texto plano: no se interpreta ni se "limpia" de HTML
  });
  it("nunca imprime NaN ni undefined", () => {
    const c = largeAlertCandidate(tx(), hist({ merchantSamples: [NaN, NaN] }), cfg, TODAY)!;
    expect(`${c.title}${c.body}`).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe("3. spending_pace", () => {
  const base: PaceInput = { month: "2026-10", isCurrent: true, elapsedDays: 12, daysInMonth: 31, spent: 20_000_00, prevSamePeriod: 10_000_00, income: 100_000_00, projected: 51_000_00 };
  it("más de 25 % sobre el mes anterior → warn; ≥ 50 % → high", () => {
    expect(paceCandidate({ ...base, spent: 12_500_00 }, cfg)).toMatchObject({ severity: "warn", dedupeKey: "pace:2026-10:warn" });
    expect(paceCandidate({ ...base, spent: 12_400_00 }, cfg)).toBeNull();
    expect(paceCandidate({ ...base, spent: 15_000_00 }, cfg)).toMatchObject({ severity: "high", dedupeKey: "pace:2026-10:high" });
  });
  it("exige una diferencia mínima en pesos aunque el % sea alto", () => {
    expect(paceCandidate({ ...base, spent: 900_00, prevSamePeriod: 400_00, projected: 2_000_00 }, cfg)).toBeNull();
  });
  it("no antes del día 5 ni fuera del mes en curso", () => {
    expect(paceCandidate({ ...base, elapsedDays: 4 }, cfg)).toBeNull();
    expect(paceCandidate({ ...base, elapsedDays: 5 }, cfg)).not.toBeNull();
    expect(paceCandidate({ ...base, isCurrent: false }, cfg)).toBeNull();
  });
  it("proyección contra ingreso: ≥ 100 % warn, ≥ 120 % high (desde el día 10)", () => {
    const p = { ...base, spent: 10_500_00, prevSamePeriod: 10_000_00 };
    expect(paceCandidate({ ...p, projected: 99_999_00 }, cfg)).toBeNull();
    expect(paceCandidate({ ...p, projected: 100_000_00 }, cfg)).toMatchObject({ severity: "warn" });
    expect(paceCandidate({ ...p, projected: 125_000_00 }, cfg)).toMatchObject({ severity: "high" });
    expect(paceCandidate({ ...p, projected: 125_000_00, elapsedDays: 7 }, cfg)).toBeNull(); // proyección con pocos días = ruido
  });
  it("las dos señales juntas: nivel máximo y texto con ambas", () => {
    const c = paceCandidate({ ...base, spent: 13_000_00, projected: 105_000_00 }, cfg)!;
    expect(c.severity).toBe("warn");
    expect(c.body).toContain("30%");
    expect(c.body).toContain("105%");
  });
  it("cold start: sin mes anterior ni ingreso no hay alerta; sin gasto tampoco", () => {
    expect(paceCandidate({ ...base, prevSamePeriod: 0, income: 0 }, cfg)).toBeNull();
    expect(paceCandidate({ ...base, spent: 0 }, cfg)).toBeNull();
    expect(paceCandidate({ ...base, spent: -50_00 }, cfg)).toBeNull();
  });
  it("entradas NaN: sin alerta", () => {
    expect(paceCandidate({ ...base, spent: NaN }, cfg)).toBeNull();
    expect(paceCandidate({ ...base, projected: Infinity }, cfg)).toBeNull();
  });
  it("tolerancia configurable", () => {
    expect(paceCandidate({ ...base, spent: 11_200_00 }, parseAlertConfig({ paceTolerancePct: 10 }))?.severity).toBe("warn");
    expect(paceCandidate({ ...base, spent: 11_200_00 }, cfg)).toBeNull();
  });
});

describe("4. daily_spike", () => {
  const base: SpikeInput = { today: TODAY, todayCents: 4_000_00, windowTotalCents: 30 * 500_00, windowDays: 30, daysWithSpend: 25, topAlreadyAlerted: false };
  it("≥ 3× el promedio y ≥ $1,500", () => {
    expect(dailySpikeCandidate({ ...base, todayCents: 2_000_00 }, cfg)).toMatchObject({ severity: "warn", dedupeKey: `spike:${TODAY}:warn` }); // 4× de $500
    expect(dailySpikeCandidate({ ...base, todayCents: 1_499_00 }, cfg)).toBeNull(); // bajo el mínimo
    expect(dailySpikeCandidate({ ...base, todayCents: 1_500_00 }, cfg)).not.toBeNull(); // exactamente 3×
    expect(dailySpikeCandidate({ ...base, todayCents: 1_499_99 }, cfg)).toBeNull();
  });
  it("el mínimo manda aunque el factor se cumpla de sobra", () => {
    expect(dailySpikeCandidate({ ...base, windowTotalCents: 30 * 50_00, todayCents: 1_000_00 }, cfg)).toBeNull();
  });
  it("high a 2× factor y 2× mínimo", () => {
    expect(dailySpikeCandidate({ ...base, todayCents: 3_000_00 }, cfg)?.severity).toBe("high"); // 6× y ≥ $3,000
    expect(dailySpikeCandidate({ ...base, todayCents: 2_900_00 }, cfg)?.severity).toBe("warn");
  });
  it("arranque en frío / división entre cero: sin alerta y sin NaN", () => {
    expect(dailySpikeCandidate({ ...base, windowTotalCents: 0, daysWithSpend: 0 }, cfg)).toBeNull();
    expect(dailySpikeCandidate({ ...base, daysWithSpend: 4 }, cfg)).toBeNull();
    expect(dailySpikeCandidate({ ...base, windowDays: 0 }, cfg)).toBeNull();
    expect(dailySpikeCandidate({ ...base, todayCents: NaN }, cfg)).toBeNull();
  });
  it("si la compra grande de hoy ya tiene su alerta, no se repite como pico", () => {
    expect(dailySpikeCandidate({ ...base, topAlreadyAlerted: true }, cfg)).toBeNull();
  });
  it("factor y mínimo configurables", () => {
    const c = parseAlertConfig({ dailySpikeFactor: 10, dailySpikeMinCents: 100_00 });
    expect(dailySpikeCandidate({ ...base, todayCents: 4_000_00 }, c)).toBeNull(); // 8× < 10×
    expect(dailySpikeCandidate({ ...base, todayCents: 5_000_00 }, c)).not.toBeNull();
  });
});

describe("5. duplicate_suspect", () => {
  const a: DupFacts = { id: 1, cardId: 1, cents: 850_00, merchantNormalized: "UBER EATS", occurredAtMs: Date.parse("2026-10-04T18:00:00Z"), kind: "expense" };
  it("misma tarjeta + monto + comercio a ≤ 10 min", () => {
    expect(isDuplicatePair(a, { ...a, id: 2, occurredAtMs: a.occurredAtMs + 10 * 60_000 })).toBe(true);
    expect(isDuplicatePair(a, { ...a, id: 2, occurredAtMs: a.occurredAtMs - 9 * 60_000 })).toBe(true);
    expect(isDuplicatePair(a, { ...a, id: 2, occurredAtMs: a.occurredAtMs + 10 * 60_000 + 1 })).toBe(false);
  });
  it("cualquier diferencia lo descarta", () => {
    expect(isDuplicatePair(a, { ...a, id: 2, cents: 851_00 })).toBe(false);
    expect(isDuplicatePair(a, { ...a, id: 2, cardId: 2 })).toBe(false);
    expect(isDuplicatePair(a, { ...a, id: 2, merchantNormalized: "RAPPI" })).toBe(false);
    expect(isDuplicatePair(a, { ...a, id: 1 })).toBe(false); // consigo misma
    expect(isDuplicatePair({ ...a, merchantNormalized: "" }, { ...a, id: 2, merchantNormalized: "" })).toBe(false);
    expect(isDuplicatePair({ ...a, kind: "card_payment" }, { ...a, id: 2, kind: "card_payment" })).toBe(false);
    expect(isDuplicatePair({ ...a, cents: -850_00 }, { ...a, id: 2, cents: -850_00 })).toBe(false);
    expect(isDuplicatePair({ ...a, occurredAtMs: NaN }, { ...a, id: 2 })).toBe(false);
  });
  it("candidato: clave simétrica por pareja (el orden no importa) y no borra nada", () => {
    const t1 = tx({ id: 7, cents: 850_00 });
    const x = duplicateCandidate(t1, 3);
    const y = duplicateCandidate(tx({ id: 3, cents: 850_00 }), 7);
    expect(x.dedupeKey).toBe("dup:3:7");
    expect(y.dedupeKey).toBe("dup:3:7");
    expect(x).toMatchObject({ rule: "duplicate_suspect", severity: "warn" });
    expect(x.body).toContain("no se borró nada");
  });
});

describe("6. unconfirmed", () => {
  it("sin filas: nada; con filas: un resumen con la clave del movimiento más reciente", () => {
    expect(unconfirmedCandidate([], cfg)).toBeNull();
    const one = unconfirmedCandidate([{ id: 4, cents: 300_00, merchant: "OXXO" }], cfg)!;
    expect(one).toMatchObject({ severity: "info", dedupeKey: "unconfirmed:4" });
    expect(one.title).toBe("1 compra sin confirmar por el banco");
    const many = unconfirmedCandidate([{ id: 4, cents: 300_00, merchant: "OXXO" }, { id: 9, cents: 1_200_00, merchant: "CINEPOLIS" }, { id: 6, cents: 50_00, merchant: "TIENDA" }], cfg)!;
    expect(many).toMatchObject({ severity: "warn", dedupeKey: "unconfirmed:9" });
    expect(many.title).toBe("3 compras sin confirmar por el banco");
    expect(many.body).toContain("$1,550.00");
    expect(many.body).toContain("CINEPOLIS");
  });
  it("ignora filas inválidas (cero, negativas, NaN)", () => {
    expect(unconfirmedCandidate([{ id: 1, cents: 0, merchant: "x" }, { id: 2, cents: NaN, merchant: "x" }, { id: 3, cents: -5, merchant: "x" }], cfg)).toBeNull();
  });
});

describe("7. goal_off_track", () => {
  const g = { name: "Viaje", remaining: 60_000_00, perMonth: 10_000_00, done: false, overdue: false, daysLeft: 180, projectedSaving: 4_000_00 as number | null, today: TODAY };
  it("ahorro proyectado por debajo de lo necesario → warn; muy por debajo → high; clave por semana ISO", () => {
    expect(goalCandidate({ ...g, projectedSaving: 7_000_00 }, cfg)).toMatchObject({ severity: "warn", dedupeKey: "goal:2026-W40" });
    expect(goalCandidate(g, cfg)).toMatchObject({ severity: "high" });
    expect(goalCandidate({ ...g, projectedSaving: -3_000_00 }, cfg)?.body).toContain("$0.00"); // el negativo se trata como 0
  });
  it("dentro de la holgura (20 %) o con meta cubierta: nada", () => {
    expect(goalCandidate({ ...g, projectedSaving: 8_000_00 }, cfg)).toBeNull();
    expect(goalCandidate({ ...g, projectedSaving: 12_000_00 }, cfg)).toBeNull();
  });
  it("máximo una por semana (misma clave) y otra la semana siguiente", () => {
    const a = goalCandidate({ ...g, today: "2026-10-04" }, cfg)!;
    const b = goalCandidate({ ...g, today: "2026-10-01" }, cfg)!;
    const c = goalCandidate({ ...g, today: "2026-10-05" }, cfg)!;
    expect(a.dedupeKey).toBe(b.dedupeKey);
    expect(c.dedupeKey).not.toBe(a.dedupeKey);
  });
  it("meta lograda, sin proyección o NaN: nada", () => {
    expect(goalCandidate({ ...g, done: true }, cfg)).toBeNull();
    expect(goalCandidate({ ...g, remaining: 0 }, cfg)).toBeNull();
    expect(goalCandidate({ ...g, projectedSaving: null }, cfg)).toBeNull();
    expect(goalCandidate({ ...g, projectedSaving: NaN }, cfg)).toBeNull();
    expect(goalCandidate({ ...g, perMonth: NaN }, cfg)).toBeNull();
  });
  it("fecha vencida con faltante: aviso (aunque no haya proyección)", () => {
    expect(goalCandidate({ ...g, overdue: true, projectedSaving: null }, cfg)).toMatchObject({ severity: "warn", dedupeKey: "goal:2026-W40" });
  });
  it("tolerancia configurable", () => {
    expect(goalCandidate({ ...g, projectedSaving: 8_000_00 }, parseAlertConfig({ goalTolerancePct: 5 }))).not.toBeNull();
  });
});
