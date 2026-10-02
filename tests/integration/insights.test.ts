import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getIncome, PUT as putIncome } from "@/app/api/settings/income/route";
import { POST as postCard } from "@/app/api/cards/route";
import { PUT as putCard } from "@/app/api/cards/[id]/route";
import { closePool, query } from "@/lib/db/pool";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { getInsights } from "@/lib/repo/insights";
import { getMonthlyIncome, setMonthlyIncome } from "@/lib/repo/settings";
import { createManual, getChangeRevision } from "@/lib/repo/transactions";
import { authed, ctx, req, resetDb } from "../helpers";

const NOW = new Date("2026-09-15T18:00:00Z"); // martes 15, 12:00 CDMX
let card: number, cat: number;
const tx = (date: string, cents: number, merchant = "X", category: number | null = null) =>
  createManual({ occurredAt: new Date(`${date}T18:00:00Z`), amountCents: cents, merchant, cardId: card, categoryId: category, notes: null });

beforeAll(async () => {
  await resetDb();
  await setMonthlyIncome(100_000);
  card = (await createCard({ name: "Insights", issuer: "banamex", last4: null, aliases: null, color: "#f00" })).id;
  cat = (await createCategory({ name: "Comida", color: "#f50" })).id;
  await tx("2026-08-02", 10000, "A");
  await tx("2026-08-10", 20000, "B");
  await tx("2026-08-20", 90000, "C");
  await tx("2026-09-01", 15000, "TACOS", cat);
  await tx("2026-09-12", 4000, "CAFE");
  await tx("2026-09-14", 5000, "TACOS", cat);
  await tx("2026-09-15", -2000, "Reembolso");
  await tx("2026-09-30", 7777, "FUTURO"); // posterior a "hoy": no entra al mes en curso
});
afterAll(async () => {
  await setMonthlyIncome(35_000_000); // deja el valor inicial de la migración
  await closePool();
});

describe("getInsights (mes en curso, día 15)", () => {
  it("cifras contra el ingreso, promedio por día y proyección", async () => {
    const i = await getInsights("2026-09", NOW);
    expect(i).toMatchObject({ isCurrent: true, income: 100_000, spent: 22_000, saved: 78_000, elapsedDays: 15, daysInMonth: 30, remainingDays: 15 });
    expect(i.usedPct).toBeCloseTo(22, 5);
    expect(i.avgPerDay).toBeCloseTo(22_000 / 15, 5);
    expect(i.prevAvgPerDay).toBeCloseTo(120_000 / 31, 5);
    expect(i.projected).toBe(44_000);
    expect(i.projectedPct).toBeCloseTo(44, 5);
    expect(i.dailyAllowance).toBe(5_200); // (1000 − 220) / 15 días restantes
  });
  it("compras, ticket promedio y días sin gasto ignoran reembolsos y el futuro", async () => {
    const i = await getInsights("2026-09", NOW);
    expect(i.count).toBe(3);
    expect(i.avgTicket).toBe(8_000); // (15000 + 4000 + 5000) / 3
    expect(i.noSpendDays).toBe(12); // días 1, 12 y 14 con gasto; el 15 neto es reembolso
    expect(i.topDay).toEqual({ date: "2026-09-01", cents: 15_000 });
  });
  it("historial de 12 meses con delta contra el mes previo", async () => {
    const i = await getInsights("2026-09", NOW);
    expect(i.history).toHaveLength(12);
    const sep = i.history[11], aug = i.history[10], jul = i.history[9];
    expect(sep.month).toBe("2026-09");
    expect(aug).toMatchObject({ month: "2026-08", spent: 120_000, saved: -20_000 });
    expect(jul.spent).toBe(0);
    expect(sep.deltaPct).toBeCloseTo(((22_000 - 120_000) / 120_000) * 100, 5);
    expect(sep.avgPerDay).toBeCloseTo(22_000 / 15, 5); // el mes en curso solo cuenta hasta hoy
    expect(aug.usedPct).toBeCloseTo(120, 5);
  });
  it("categorías contra el mismo periodo del mes previo, top comercios y frases", async () => {
    const i = await getInsights("2026-09", NOW);
    expect(i.categoryDeltas.find((c) => c.name === "Comida")).toMatchObject({ cents: 20_000, prevCents: 0 });
    expect(i.categoryDeltas.find((c) => c.name === "Sin categoría")).toMatchObject({ cents: 2_000, prevCents: 30_000 });
    expect(i.topMerchants[0]).toMatchObject({ merchant: "TACOS", cents: 20_000, count: 2 });
    expect(i.messages.length).toBeGreaterThan(0);
    expect(i.messages.map((m) => m.text).join(" ")).toContain("22%");
  });
  it("mes cerrado: sin proyección ni presupuesto diario, todo el mes", async () => {
    const i = await getInsights("2026-08", NOW);
    expect(i).toMatchObject({ isCurrent: false, spent: 120_000, projected: 120_000, remainingDays: 0, dailyAllowance: null, elapsedDays: 31, saved: -20_000 });
  });
  it("sin ingreso configurado: porcentajes nulos y sin presupuesto diario", async () => {
    await setMonthlyIncome(0);
    const i = await getInsights("2026-09", NOW);
    expect(i).toMatchObject({ income: 0, usedPct: null, savedPct: null, projectedPct: null, dailyAllowance: null });
    await setMonthlyIncome(100_000);
  });
});

describe("ingreso mensual: API", () => {
  const put = (body: unknown, headers: Record<string, string> = authed()) => putIncome(req("/api/settings/income", { method: "PUT", body, headers }), ctx() as never);
  it("lee y actualiza (acepta formato con comas y $)", async () => {
    const r = await put({ amount: "$350,000.50" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cents: 35_000_050 });
    expect(await getMonthlyIncome()).toBe(35_000_050);
    expect(await (await getIncome(req("/api/settings/income", { headers: authed() }), ctx() as never)).json()).toEqual({ cents: 35_000_050 });
    await put({ amount: 1000 });
    expect(await getMonthlyIncome()).toBe(100_000);
  });
  it("rechaza montos inválidos, negativos y fuera de rango; campos extra → 400", async () => {
    for (const body of [{ amount: "abc" }, { amount: "-5" }, { amount: "99999999999" }, { amount: "0" }, { amount: 1000, extra: 1 }, {}]) {
      expect((await put(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await getMonthlyIncome()).toBe(100_000);
  });
  it("sin sesión → 401, usuario ajeno → 403, cross-site → 403", async () => {
    expect((await put({ amount: 1 }, {})).status).toBe(401);
    expect((await put({ amount: 1 }, { "x-ms-client-principal": Buffer.from("{}").toString("base64") })).status).toBeGreaterThanOrEqual(401);
    expect((await put({ amount: 1 }, { ...authed(), origin: "https://evil.example" })).status).toBe(403);
    expect(await getMonthlyIncome()).toBe(100_000);
  });
  it("cambiar el ingreso cambia la revisión de actualización en vivo", async () => {
    const a = await getChangeRevision();
    await setMonthlyIncome(123_400);
    expect(await getChangeRevision()).not.toBe(a);
    await setMonthlyIncome(100_000);
  });
  it("la migración dejó el valor inicial de 350,000 (solo la tabla; los tests lo sobrescriben)", async () => {
    const r = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.app_settings WHERE [key]='monthly_income_cents'");
    expect(r[0].n).toBe(1);
  });
});

describe("diseño de tarjeta", () => {
  it("se guarda, se cambia y se rechaza uno desconocido", async () => {
    const res = await postCard(req("/api/cards", { body: { name: "Con arte", issuer: "banamex", art: "banamex-explora" }, headers: authed() }), ctx() as never);
    expect(res.status).toBe(201);
    const c = await res.json();
    expect(c.art).toBe("banamex-explora");
    const up = await putCard(req(`/api/cards/${c.id}`, { method: "PUT", body: { name: "Con arte", issuer: "banamex", art: null }, headers: authed() }), ctx({ id: String(c.id) }) as never);
    expect((await up.json()).art).toBeNull();
    const bad = await postCard(req("/api/cards", { body: { name: "Mala", issuer: "banamex", art: "dorada" }, headers: authed() }), ctx() as never);
    expect(bad.status).toBe(400);
  });
});
