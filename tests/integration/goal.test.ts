import sql from "mssql";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as postRoute } from "@/app/api/goals/route";
import { DELETE as delRoute, GET as getRoute, PUT as putRoute } from "@/app/api/goals/[id]/route";
import { POST as recapRoute } from "@/app/api/goals/recap/route";
import { closePool, query } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { MAX_GOALS } from "@/lib/goals";
import { LlmError } from "@/lib/llm/openrouter";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { createGoal, deleteGoal, getGoalById, listGoals, type GoalInput } from "@/lib/repo/goals";
import { getGoalsOverview } from "@/lib/repo/goals-plan";
import { generateRecap, getRecap } from "@/lib/repo/goals-recap";
import { setMonthlyIncome } from "@/lib/repo/settings";
import { getChangeRevision } from "@/lib/repo/transactions";
import { localDate } from "@/lib/time";
import { authed, ctx, req, resetDb } from "../helpers";

const NOW = new Date("2026-10-13T18:00:00Z");
const TODAY = "2026-10-13";
const ok = { name: "Tesla", kind: "auto", priority: 2, target: "1,500,000", target_date: "2027-04-11", month_only: false, saved: "100000" };
const input = (o: Partial<GoalInput> = {}): GoalInput => ({ name: "Depa", kind: "casa", priority: 2, targetCents: 1_600_000_00, targetDate: "2027-10-05", monthOnly: false, savedCents: 308_500_00, ...o });

const post = (body: unknown, headers: Record<string, string> = authed()) => postRoute(req("/api/goals", { method: "POST", body, headers }), ctx());
const put = (id: number | string, body: unknown, headers: Record<string, string> = authed()) => putRoute(req(`/api/goals/${id}`, { method: "PUT", body, headers }), ctx({ id: String(id) }));
const del = (id: number | string, headers: Record<string, string> = authed()) => delRoute(req(`/api/goals/${id}`, { method: "DELETE", headers }), ctx({ id: String(id) }));
const body = async (r: Response) => (await r.json()) as { goal?: Record<string, unknown>; goals?: Record<string, unknown>[]; error?: string; recap?: { text: string } };

let card: number, seq = 0;
async function spend(date: string, cents: number, cat: number | null = null) {
  await query(
    `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, source, sources, dedupe_hash, kind)
     VALUES (@at, @d, @c, 'X', 'X', @card, @cat, 'manual', 'manual', @h, 'expense')`,
    {
      at: { type: sql.DateTime2, value: new Date(`${date}T18:00:00Z`) }, d: { type: sql.Date, value: new Date(`${date}T00:00:00Z`) },
      c: { type: sql.BigInt, value: cents }, card: { type: sql.Int, value: card }, cat: { type: sql.Int, value: cat },
      h: { type: sql.Char, value: String(++seq).padStart(64, "0") },
    },
  );
}

beforeEach(async () => {
  await resetDb();
  await query("DELETE FROM dbo.savings_goals");
  card = (await createCard({ name: "Tarjeta Prueba", issuer: "other", last4: null, aliases: null, color: "#f00" })).id;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});
afterAll(async () => {
  await setMonthlyIncome(35_000_000);
  await closePool();
});

describe("API de metas", () => {
  it("sin metas devuelve lista vacía; POST crea con la fecha de hoy y GET la lee", async () => {
    expect(await body(await listRoute(req("/api/goals", { headers: authed() }), ctx()))).toEqual({ goals: [] });
    const res = await post(ok);
    expect(res.status).toBe(201);
    const { goal } = await body(res);
    expect(goal).toMatchObject({ name: "Tesla", kind: "auto", priority: 2, targetCents: 1_500_000_00, targetDate: "2027-04-11", monthOnly: false, savedCents: 100_000_00, savedAsOf: localDate(new Date()) });
    const got = await body(await getRoute(req(`/api/goals/${goal!.id}`, { headers: authed() }), ctx({ id: String(goal!.id) })));
    expect(got.goal).toMatchObject({ name: "Tesla" });
  });

  it("permite varias metas y las ordena por prioridad y fecha", async () => {
    await post({ ...ok, name: "Lejana", target_date: "2028-01-01" });
    await post({ ...ok, name: "Cercana", target_date: "2027-01-01" });
    await post({ ...ok, name: "Urgente", target_date: "2027-12-01", priority: 1 });
    expect((await listGoals()).map((g) => g.name)).toEqual(["Urgente", "Cercana", "Lejana"]);
  });

  it("solo mes: acepta AAAA-MM y guarda el último día del mes", async () => {
    const { goal } = await body(await post({ ...ok, month_only: true, target_date: "2027-04" }));
    expect(goal).toMatchObject({ targetDate: "2027-04-30", monthOnly: true });
    expect((await post({ ...ok, month_only: true, target_date: "2028-02" })).status).toBe(201);
    expect((await listGoals()).map((g) => g.targetDate)).toContain("2028-02-29");
  });

  it("PUT edita; el 'ahorrado a la fecha' solo se actualiza si cambia el ahorro", async () => {
    const { goal } = await body(await post(ok));
    const id = goal!.id as number;
    await query("UPDATE dbo.savings_goals SET saved_as_of = '2026-09-01' WHERE id = @id", { id: { type: sql.Int, value: id } });
    expect((await put(id, { ...ok, name: "Tesla Y", priority: 1 })).status).toBe(200);
    expect(await getGoalById(id)).toMatchObject({ name: "Tesla Y", priority: 1, savedAsOf: "2026-09-01" });
    await put(id, { ...ok, saved: "250000" });
    expect(await getGoalById(id)).toMatchObject({ savedCents: 250_000_00, savedAsOf: localDate(new Date()) });
  });

  it("una meta vencida se puede editar sin cambiar la fecha, pero no se puede mover a una fecha pasada", async () => {
    const g = await createGoal(input({ targetDate: "2026-01-15" }), "2025-12-01");
    expect((await put(g.id, { ...ok, target_date: "2026-01-15", name: "Vencida editada" })).status).toBe(200);
    expect((await put(g.id, { ...ok, target_date: "2026-02-01" })).status).toBe(400);
    expect((await post({ ...ok, target_date: "2020-01-01" })).status).toBe(400);
  });

  it("DELETE elimina solo esa meta; ids inexistentes o raros dan 404", async () => {
    const a = (await body(await post(ok))).goal!.id as number;
    const b = (await body(await post({ ...ok, name: "Depa" }))).goal!.id as number;
    expect((await del(a)).status).toBe(200);
    expect((await listGoals()).map((g) => g.id)).toEqual([b]);
    expect((await del(a)).status).toBe(404);
    expect((await put(a, ok)).status).toBe(404);
    expect((await del("abc")).status).toBe(404);
    expect((await del("1; DROP TABLE x")).status).toBe(404);
    expect(await deleteGoal(b)).toBe(true);
  });

  it.each([
    ["monto inválido", { ...ok, target: "abc" }],
    ["meta en cero", { ...ok, target: "0" }],
    ["ahorro negativo", { ...ok, saved: "-5" }],
    ["fecha inválida", { ...ok, target_date: "2027-13-45" }],
    ["mes inválido", { ...ok, month_only: true, target_date: "2027-13" }],
    ["mes con día", { ...ok, month_only: true, target_date: "2027-04-11" }],
    ["fecha exacta sin día", { ...ok, target_date: "2027-04" }],
    ["tipo desconocido", { ...ok, kind: "yate" }],
    ["prioridad 4", { ...ok, priority: 4 }],
    ["campo extra", { ...ok, extra: 1 }],
    ["nombre vacío", { ...ok, name: " " }],
  ])("rechaza %s", async (_n, b) => {
    expect((await post(b)).status).toBe(400);
    expect(await listGoals()).toEqual([]);
  });

  it("tope de metas: la número MAX+1 se rechaza con 409", async () => {
    for (let i = 0; i < MAX_GOALS; i++) await createGoal(input({ name: `Meta ${i}` }), TODAY);
    const res = await post(ok);
    expect(res.status).toBe(409);
    expect((await listGoals()).length).toBe(MAX_GOALS);
  });

  it("exige sesión y mismo origen (como el resto de la API)", async () => {
    const g = await createGoal(input(), TODAY);
    expect((await post(ok, {})).status).toBe(401);
    expect((await put(g.id, ok, {})).status).toBe(401);
    expect((await del(g.id, {})).status).toBe(401);
    expect((await post(ok, { ...authed(), origin: "https://evil.example" })).status).toBe(403);
    expect((await put(g.id, ok, { ...authed(), origin: "https://evil.example" })).status).toBe(403);
    expect((await del(g.id, { ...authed(), origin: "https://evil.example" })).status).toBe(403);
    expect((await recapRoute(req("/api/goals/recap", { method: "POST", body: {}, headers: {} }), ctx())).status).toBe(401);
    expect((await listGoals()).length).toBe(1);
  });

  it("crear, editar y borrar cambia la revisión de cambios (refresco en vivo)", async () => {
    const r0 = await getChangeRevision();
    const g = await createGoal(input(), TODAY);
    const r1 = await getChangeRevision();
    expect(r1).not.toBe(r0);
    await put(g.id, { ...ok, priority: 1 });
    const r2 = await getChangeRevision();
    expect(r2).not.toBe(r1);
    await del(g.id);
    expect(await getChangeRevision()).not.toBe(r2);
  });
});

describe("predicción de metas", () => {
  it("usa el promedio de los últimos 3 meses cerrados y reparte el excedente", async () => {
    await setMonthlyIncome(100_000_00);
    await spend("2026-06-10", 500_000_00); // fuera de los últimos 3
    await spend("2026-07-10", 55_000_00);
    await spend("2026-08-10", 60_000_00);
    await spend("2026-09-10", 65_000_00);
    await spend("2026-10-05", 999_00);
    await createGoal(input({ name: "Tesla", targetCents: 200_000_00, targetDate: "2027-04-11", savedCents: 0 }), TODAY);
    const o = await getGoalsOverview(NOW);
    expect(o.monthsUsed).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(o.capacity).toMatchObject({ basis: "history", months: 3, avgSpend: 60_000_00, surplus: 40_000_00 });
    expect(o.summary.plans[0]).toMatchObject({ status: "on_track", order: 1 });
    expect(o.summary.surplus).toBe(40_000_00);
    expect(o.scenarios.map((s) => s.cutPct)).toEqual([0, 10, 20]);
  });

  it("descarta el primer mes si el registro empezó ya avanzado (mes incompleto)", async () => {
    await setMonthlyIncome(100_000_00);
    await spend("2026-07-25", 5_000_00); // primer movimiento a fin de mes
    await spend("2026-08-10", 60_000_00);
    await spend("2026-09-10", 80_000_00);
    const o = await getGoalsOverview(NOW);
    expect(o.monthsUsed).toEqual(["2026-08", "2026-09"]);
    expect(o.capacity.avgSpend).toBe(70_000_00);
  });

  it("sin meses cerrados cae a la proyección del mes en curso; sin gastos no hay base", async () => {
    await setMonthlyIncome(100_000_00);
    expect((await getGoalsOverview(NOW)).capacity.basis).toBe("none");
    await spend("2026-10-02", 13_000_00);
    const o = await getGoalsOverview(NOW); // 13 mil en 13 días → 31 mil al mes
    expect(o.capacity).toMatchObject({ basis: "current", avgSpend: 31_000_00 });
  });

  it("devuelve el gasto promedio por categoría", async () => {
    await setMonthlyIncome(100_000_00);
    const rest = (await createCategory({ name: "Restaurantes", color: "#0af" })).id;
    await spend("2026-07-02", 3_000_00, null); // primer movimiento al inicio del mes: julio cuenta como completo
    await spend("2026-08-10", 30_000_00, rest);
    await spend("2026-09-10", 30_000_00, rest);
    await spend("2026-09-11", 6_000_00, null);
    const o = await getGoalsOverview(NOW);
    expect(o.categories).toEqual([{ name: "Restaurantes", avg: 20_000_00 }, { name: "Sin categoría", avg: 3_000_00 }]);
  });
});

describe("resumen con IA", () => {
  async function seed() {
    await setMonthlyIncome(100_000_00);
    for (const m of ["2026-07", "2026-08", "2026-09"]) await spend(`${m}-10`, 60_000_00);
    await createGoal(input({ name: "Tesla", targetCents: 200_000_00, targetDate: "2027-04-11", savedCents: 0 }), TODAY);
    return getGoalsOverview(NOW);
  }
  const reply = (...texts: string[]) => {
    const f = vi.fn();
    texts.forEach((t) => f.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: t } }] })));
    return f;
  };
  const deps = (f: ReturnType<typeof vi.fn>) => ({ apiKey: "sk-or-test-key-1234567890", model: "anthropic/claude-haiku-5.5", now: NOW, fetchImpl: f as unknown as typeof fetch });

  it("genera, verifica los montos y guarda el resumen", async () => {
    const o = await seed();
    const f = reply("**Resumen**\nTe sobran $40,000 al mes y “Tesla” pide $33,000.");
    // $33,000 no está en las cifras (el modelo lo calculó) → se pide corregir una vez
    f.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "**Resumen**\nTe sobran $40,000 al mes; la meta de $200,000 llega a tiempo." } }] }));
    const r = await generateRecap(o, deps(f));
    expect(f).toHaveBeenCalledTimes(2);
    expect(String((f.mock.calls[1][1] as RequestInit).body)).toContain("montos que no están en <datos>");
    expect(r.text).toContain("$200,000");
    expect(await getRecap()).toMatchObject({ text: r.text, model: "anthropic/claude-haiku-5.5", at: NOW.toISOString() });
  });

  it("si el modelo insiste en inventar montos, no guarda nada", async () => {
    const o = await seed();
    const f = reply("Aparta $12,345", "Aparta $67,890");
    await expect(generateRecap(o, deps(f))).rejects.toThrow(LlmError);
    expect(await getRecap()).toBeNull();
  });

  it("la ruta: sin API key → 503; sin metas o sin ingreso → 400; con key devuelve el resumen", async () => {
    const call = () => recapRoute(req("/api/goals/recap", { method: "POST", body: {}, headers: authed() }), ctx());
    vi.stubEnv("OPENROUTER_API_KEY", "");
    resetEnvCache();
    expect((await call()).status).toBe(503);

    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-key-1234567890");
    resetEnvCache();
    await setMonthlyIncome(100_000_00);
    expect((await call()).status).toBe(400); // sin metas

    await seed();
    vi.stubGlobal("fetch", reply("**Resumen**\nVas bien: te sobran $40,000 al mes."));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await body(res)).recap?.text).toContain("$40,000");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 402 })));
    const bad = await call();
    expect(bad.status).toBe(502);
    expect((await body(bad)).error).toContain("saldo");
  });
});
