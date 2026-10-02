import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET, PUT } from "@/app/api/settings/goal/route";
import { closePool, query } from "@/lib/db/pool";
import { getGoal, setGoal } from "@/lib/repo/goals";
import { getChangeRevision } from "@/lib/repo/transactions";
import { localDate } from "@/lib/time";
import { authed, ctx, req } from "../helpers";

const put = (body: unknown, headers: Record<string, string> = authed()) => PUT(req("/api/settings/goal", { method: "PUT", body, headers }), ctx());
const ok = { name: "Pago de departamento", target: "1,600,000", target_date: "2027-10-05", saved: "308500" };

beforeEach(async () => {
  await query("DELETE FROM dbo.savings_goals");
});
afterAll(closePool);

describe("meta de ahorro", () => {
  it("sin meta devuelve null; PUT la crea y GET la lee con la fecha de hoy", async () => {
    expect(await (await GET(req("/api/settings/goal", { headers: authed() }), ctx())).json()).toEqual({ goal: null });
    const res = await put(ok);
    expect(res.status).toBe(200);
    expect(await getGoal()).toEqual({ name: "Pago de departamento", targetCents: 1_600_000_00, targetDate: "2027-10-05", savedCents: 308_500_00, savedAsOf: localDate(new Date()) });
  });

  it("PUT reemplaza la única meta (no crea una segunda)", async () => {
    await put(ok);
    await put({ ...ok, saved: "0", name: "Otra" });
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.savings_goals"))[0].n)).toBe(1);
    expect(await getGoal()).toMatchObject({ name: "Otra", savedCents: 0 });
  });

  it.each([
    ["monto inválido", { ...ok, target: "abc" }],
    ["meta en cero", { ...ok, target: "0" }],
    ["ahorro negativo", { ...ok, saved: "-5" }],
    ["fecha inválida", { ...ok, target_date: "2027-13-45" }],
    ["campo extra", { ...ok, extra: 1 }],
    ["nombre vacío", { ...ok, name: " " }],
  ])("rechaza %s", async (_n, body) => {
    expect((await put(body)).status).toBe(400);
    expect(await getGoal()).toBeNull();
  });

  it("exige sesión y mismo origen (como el resto de la API)", async () => {
    expect((await put(ok, {})).status).toBe(401);
    expect((await put(ok, { ...authed(), origin: "https://evil.example" })).status).toBe(403);
  });

  it("setGoal valida rangos y la revisión de cambios cambia al actualizar la meta (refresco en vivo)", async () => {
    await expect(setGoal({ name: "x", targetCents: 0, targetDate: "2027-01-01", savedCents: 0, savedAsOf: "2026-10-02" })).rejects.toThrow();
    await put(ok);
    const a = await getChangeRevision();
    await put({ ...ok, saved: "400000" });
    expect(await getChangeRevision()).not.toBe(a);
  });
});
