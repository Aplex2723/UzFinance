import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PUT } from "@/app/api/categories/[id]/route";
import { closePool, query } from "@/lib/db/pool";
import { createCard } from "@/lib/repo/cards";
import { createCategory, listCategories } from "@/lib/repo/categories";
import { getMsi, listPlans, planKey, upsertPlan, type PlanInput } from "@/lib/repo/plans";
import { setMonthlyIncome } from "@/lib/repo/settings";
import { authed, ctx, req, resetDb } from "../helpers";

let cardA: number;
let cardB: number;
const base = (o: Partial<PlanInput> = {}): PlanInput => ({
  cardId: cardA, merchant: "TIENDA UNO", originalCents: 120_000_00, monthlyCents: 10_000_00, pendingCents: 20_000_00,
  nTotal: 12, nCurrent: 10, asOf: "2026-09-18", startedOn: "2025-12-18", startedEstimated: true, ...o,
});

beforeEach(async () => {
  await resetDb();
  cardA = (await createCard({ name: "Tarjeta A", issuer: "banamex", last4: "1111", aliases: null, color: "#ef4444" })).id;
  cardB = (await createCard({ name: "Tarjeta B", issuer: "amex", last4: null, aliases: null, color: "#9ca3af" })).id;
  await setMonthlyIncome(350_000_00);
});
afterAll(closePool);

describe("upsertPlan", () => {
  it("crea el plan y devuelve el id", async () => {
    const r = await upsertPlan(base());
    expect(r.status).toBe("created");
    const [p] = await listPlans();
    expect(p).toMatchObject({ id: r.id, merchant: "TIENDA UNO", cardName: "Tarjeta A", nTotal: 12, nCurrent: 10, asOf: "2026-09-18", startedOn: "2025-12-18", startedEstimated: true, monthlyCents: 10_000_00 });
  });

  it("un estado más nuevo actualiza el avance del MISMO plan (sin duplicar)", async () => {
    const a = await upsertPlan(base());
    const b = await upsertPlan(base({ nCurrent: 11, pendingCents: 10_000_00, asOf: "2026-10-18" }));
    expect(b).toEqual({ id: a.id, status: "updated" });
    const plans = await listPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ nCurrent: 11, pendingCents: 10_000_00, asOf: "2026-10-18" });
  });

  it("importar un estado más viejo no retrocede el avance; el mismo corte se reaplica sin daño", async () => {
    await upsertPlan(base({ nCurrent: 11, asOf: "2026-10-18", pendingCents: 10_000_00 }));
    expect((await upsertPlan(base())).status).toBe("stale");
    expect((await upsertPlan(base({ nCurrent: 11, asOf: "2026-10-18", pendingCents: 10_000_00 }))).status).toBe("updated");
    expect(await listPlans()).toHaveLength(1);
    expect((await listPlans())[0]).toMatchObject({ nCurrent: 11, pendingCents: 10_000_00 });
  });

  it("una fecha de compra real reemplaza a la estimada, pero una estimada no pisa a la real", async () => {
    await upsertPlan(base({ startedEstimated: true }));
    await upsertPlan(base({ nCurrent: 11, asOf: "2026-10-18", startedOn: "2025-11-30", startedEstimated: false }));
    expect((await listPlans())[0]).toMatchObject({ startedOn: "2025-11-30", startedEstimated: false });
    await upsertPlan(base({ nCurrent: 12, asOf: "2026-11-18", startedOn: "2025-12-18", startedEstimated: true }));
    expect((await listPlans())[0]).toMatchObject({ startedOn: "2025-11-30", startedEstimated: false });
  });

  it("planes distintos (otro comercio, monto, tarjeta o número de meses) no se mezclan", async () => {
    await upsertPlan(base());
    await upsertPlan(base({ merchant: "OTRA TIENDA" }));
    await upsertPlan(base({ originalCents: 99_000_00 }));
    await upsertPlan(base({ cardId: cardB }));
    await upsertPlan(base({ nTotal: 24 }));
    expect(await listPlans()).toHaveLength(5);
    expect(planKey(base())).toBe(planKey(base({ merchant: "tienda  uno" }))); // normaliza el comercio
  });

  it.each([
    ["fecha inválida", { asOf: "2026-13-40" }],
    ["avance mayor al total", { nCurrent: 13 }],
    ["monto cero", { originalCents: 0 }],
    ["saldo negativo", { pendingCents: -1 }],
  ])("rechaza datos inválidos: %s", async (_n, o) => {
    await expect(upsertPlan(base(o as Partial<PlanInput>))).rejects.toThrow();
    expect(await listPlans()).toHaveLength(0);
  });

  it("borrar una tarjeta con planes no es posible por FK (se desactiva, como con transacciones)", async () => {
    await upsertPlan(base());
    await expect(query("DELETE FROM dbo.cards WHERE id=@id", { id: { type: (await import("mssql")).default.Int, value: cardA } })).rejects.toThrow();
  });
});

describe("getMsi", () => {
  it("resume la carga del mes, el saldo, el calendario y cuándo terminas", async () => {
    await upsertPlan(base({ nCurrent: 10, nTotal: 12, pendingCents: 20_000_00 })); // la 12 se carga el 19-oct-2026
    await upsertPlan(base({ merchant: "PLAN DOS", cardId: cardB, monthlyCents: 5_000_00, originalCents: 30_000_00, pendingCents: 20_000_00, nTotal: 6, nCurrent: 2, asOf: "2026-09-25", startedOn: "2026-08-25", startedEstimated: false }));
    const s = await getMsi(new Date("2026-10-02T18:00:00Z"));
    expect(s.active).toHaveLength(2);
    expect(s.loadNow).toBe(10_000_00 + 5_000_00);
    expect(s.loadPct).toBeCloseTo((15_000_00 / 350_000_00) * 100, 5);
    expect(s.remainingTotal).toBe(10_000_00 + 15_000_00); // saldo del corte menos la mensualidad ya cargada después
    expect(s.freeMonth).toBe("2026-12");
    expect(s.cards.map((c) => c.name).sort()).toEqual(["Tarjeta A", "Tarjeta B"]);
    expect(s.schedule.find((r) => r.month === "2026-11")!.total).toBe(5_000_00); // el plan A ya terminó
  });
});

describe("descripción de categoría", () => {
  it("renombrar/recolorear (PUT sin descripción) NO borra la descripción; mandarla vacía sí", async () => {
    const c = await createCategory({ name: "Mascotas", color: "#f59e0b", description: "Veterinaria y croquetas." });
    const put = (body: unknown) => PUT(req(`/api/categories/${c.id}`, { method: "PUT", body, headers: authed() }), ctx({ id: String(c.id) }));
    expect((await put({ name: "Mascotas 2", color: "#112233" })).status).toBe(200);
    expect((await listCategories())[0]).toMatchObject({ name: "Mascotas 2", color: "#112233", description: "Veterinaria y croquetas." });
    expect((await put({ name: "Mascotas 2", color: "#112233", description: "Petco, veterinaria." })).status).toBe(200);
    expect((await listCategories())[0].description).toBe("Petco, veterinaria.");
    expect((await put({ name: "Mascotas 2", color: "#112233", description: "  " })).status).toBe(200);
    expect((await listCategories())[0].description).toBeNull();
  });
});
