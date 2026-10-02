import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listCards, POST as postCard } from "@/app/api/cards/route";
import { DELETE as delCard, PUT as putCard } from "@/app/api/cards/[id]/route";
import { GET as listCats, POST as postCat } from "@/app/api/categories/route";
import { DELETE as delCat } from "@/app/api/categories/[id]/route";
import { GET as listRules, POST as postRule } from "@/app/api/rules/route";
import { GET as listTx, POST as postTx } from "@/app/api/transactions/route";
import { DELETE as delTx, GET as getTx, PUT as putTx } from "@/app/api/transactions/[id]/route";
import { POST as importCsv } from "@/app/api/transactions/import/route";
import { POST as categorize } from "@/app/api/transactions/categorize/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { closePool, query } from "@/lib/db/pool";
import { authed, ctx, req, resetDb } from "../helpers";

beforeEach(resetDb);
afterAll(closePool);

const call = async (h: (r: Request, c: never) => Promise<Response>, path: string, opts: Parameters<typeof req>[1] = {}, params?: Record<string, string>) => {
  const res = await h(req(path, { ...opts, headers: { ...authed(), ...opts.headers } }), ctx(params) as never);
  const ct = res.headers.get("content-type") ?? "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : await res.text(), res };
};
const card = { name: "Banamex Oro", issuer: "banamex", last4: "4412", aliases: "Oro", color: "#ef4444" };

describe("tarjetas", () => {
  it("crea, lista, edita y elimina", async () => {
    const c = await call(postCard as never, "/api/cards", { body: card });
    expect(c.status).toBe(201);
    expect((await call(listCards as never, "/api/cards")).body).toHaveLength(1);
    const up = await call(putCard as never, `/api/cards/${c.body.id}`, { method: "PUT", body: { ...card, name: "Oro 2" } }, { id: String(c.body.id) });
    expect(up.body.name).toBe("Oro 2");
    expect((await call(delCard as never, `/api/cards/${c.body.id}`, { method: "DELETE" }, { id: String(c.body.id) })).body.result).toBe("deleted");
  });
  it("nombre duplicado → 409; datos inválidos → 400; inexistente → 404", async () => {
    await call(postCard as never, "/api/cards", { body: card });
    expect((await call(postCard as never, "/api/cards", { body: card })).status).toBe(409);
    expect((await call(postCard as never, "/api/cards", { body: { ...card, name: "X", issuer: "visa" } })).status).toBe(400);
    expect((await call(postCard as never, "/api/cards", { body: { ...card, name: "Y", last4: "12" } })).status).toBe(400);
    expect((await call(postCard as never, "/api/cards", { body: { ...card, name: "Z", color: "rojo" } })).status).toBe(400);
    expect((await call(postCard as never, "/api/cards", { body: { ...card, name: "W", extra: 1 } })).status).toBe(400);
    expect((await call(delCard as never, "/api/cards/99999", { method: "DELETE" }, { id: "99999" })).status).toBe(404);
    expect((await call(delCard as never, "/api/cards/abc", { method: "DELETE" }, { id: "abc" })).status).toBe(400);
  });
  it("acepta Nu como emisor y rechaza emisores desconocidos", async () => {
    const nu = await call(postCard as never, "/api/cards", { body: { name: "Nu Bank", issuer: "nu", last4: "9911", aliases: "Nu, NuBank, Nu México", color: "#8a05be" } });
    expect(nu.status).toBe(201);
    expect(nu.body.issuer).toBe("nu");
    const up = await call(putCard as never, `/api/cards/${nu.body.id}`, { method: "PUT", body: { name: "Nu Bank", issuer: "nu", last4: "9911", aliases: "Nu", color: "#8a05be" } }, { id: String(nu.body.id) });
    expect(up.status).toBe(200);
    expect((await call(postCard as never, "/api/cards", { body: { ...card, name: "X", issuer: "mercadopago" } })).status).toBe(400);
  });
  it("una tarjeta con movimientos se desactiva, no se borra", async () => {
    const c = (await call(postCard as never, "/api/cards", { body: card })).body;
    await call(postTx as never, "/api/transactions", { body: { date: "2026-09-10T12:00:00Z", amount: "10", merchant: "X", card_id: c.id } });
    expect((await call(delCard as never, `/api/cards/${c.id}`, { method: "DELETE" }, { id: String(c.id) })).body.result).toBe("deactivated");
    expect((await call(listCards as never, "/api/cards")).body[0].active).toBe(false);
  });
});

describe("categorías y reglas", () => {
  it("CRUD, unicidad y cascada", async () => {
    const k = (await call(postCat as never, "/api/categories", { body: { name: "Súper", color: "#f59e0b" } })).body;
    expect((await call(postCat as never, "/api/categories", { body: { name: "Súper" } })).status).toBe(409);
    const r = await call(postRule as never, "/api/rules", { body: { pattern: "walmart", category_id: k.id } });
    expect(r.status).toBe(201);
    expect(r.body.pattern).toBe("WALMART"); // se guarda normalizado
    expect((await call(postRule as never, "/api/rules", { body: { pattern: "WALMART", category_id: k.id } })).status).toBe(409);
    expect((await call(postRule as never, "/api/rules", { body: { pattern: "x", category_id: k.id } })).status).toBe(400);
    expect((await call(postRule as never, "/api/rules", { body: { pattern: "abc", category_id: 99999 } })).status).toBe(409);
    expect((await call(delCat as never, `/api/categories/${k.id}`, { method: "DELETE" }, { id: String(k.id) })).status).toBe(200);
    expect((await call(listRules as never, "/api/rules")).body).toHaveLength(0);
    expect((await call(listCats as never, "/api/categories")).body).toHaveLength(0);
  });
});

describe("transacciones", () => {
  async function setup() {
    const c = (await call(postCard as never, "/api/cards", { body: card })).body;
    const k = (await call(postCat as never, "/api/categories", { body: { name: "Comida" } })).body;
    return { c, k };
  }
  it("crea gasto y reembolso (monto negativo), edita y elimina", async () => {
    const { c, k } = await setup();
    const a = await call(postTx as never, "/api/transactions", { body: { date: "2026-09-10T18:00:00Z", amount: "$1,234.50", merchant: "Café Ágora", card_id: c.id, category_id: k.id, notes: "n" } });
    expect(a.status).toBe(201);
    const r = await call(postTx as never, "/api/transactions", { body: { date: "2026-09-11T18:00:00Z", amount: "-200", merchant: "Reembolso", card_id: c.id } });
    expect(r.status).toBe(201);
    const got = await call(getTx as never, `/api/transactions/${a.body.id}`, {}, { id: String(a.body.id) });
    expect(got.body).toMatchObject({ amount_cents: 123450, merchant_normalized: "CAFE AGORA", category_name: "Comida", source: "manual", occurred_date: "2026-09-10" });
    const list = await call(listTx as never, "/api/transactions?month=2026-09");
    expect(list.body.total).toBe(2);
    expect(list.body.rows.find((x: { merchant_raw: string }) => x.merchant_raw === "Reembolso").amount_cents).toBe(-20000);
    const up = await call(putTx as never, `/api/transactions/${a.body.id}`, { method: "PUT", body: { date: "2026-09-10T18:00:00Z", amount: "99", merchant: "Café", card_id: c.id, category_id: null } }, { id: String(a.body.id) });
    expect(up.body).toMatchObject({ amount_cents: 9900, category_id: null });
    expect((await call(delTx as never, `/api/transactions/${a.body.id}`, { method: "DELETE" }, { id: String(a.body.id) })).status).toBe(200);
    expect((await call(getTx as never, `/api/transactions/${a.body.id}`, {}, { id: String(a.body.id) })).status).toBe(404);
  });
  it("duplicado manual → 409; tarjeta inexistente → 4xx; datos inválidos → 400", async () => {
    const { c } = await setup();
    const body = { date: "2026-09-10T18:00:00Z", amount: "10", merchant: "X", card_id: c.id };
    expect((await call(postTx as never, "/api/transactions", { body })).status).toBe(201);
    expect((await call(postTx as never, "/api/transactions", { body })).status).toBe(409);
    expect((await call(postTx as never, "/api/transactions", { body: { ...body, amount: "abc" } })).status).toBe(400);
    expect((await call(postTx as never, "/api/transactions", { body: { ...body, merchant: "" } })).status).toBe(400);
    expect((await call(postTx as never, "/api/transactions", { body: { ...body, merchant: "Y", card_id: 99999 } })).status).toBeGreaterThanOrEqual(400);
  });
  it("filtros y paginación; LIKE con comodines se trata como texto", async () => {
    const { c } = await setup();
    for (let i = 1; i <= 7; i++) await call(postTx as never, "/api/transactions", { body: { date: `2026-09-${String(i).padStart(2, "0")}T18:00:00Z`, amount: String(i * 10), merchant: i === 3 ? "100% ALGODON" : `Tienda ${i}`, card_id: c.id } });
    expect((await call(listTx as never, "/api/transactions?limit=3&offset=0")).body.rows).toHaveLength(3);
    expect((await call(listTx as never, "/api/transactions?limit=3&offset=6")).body.rows).toHaveLength(1);
    expect((await call(listTx as never, "/api/transactions?q=tienda%205")).body.total).toBe(1);
    expect((await call(listTx as never, "/api/transactions?q=%25")).body.total).toBe(1); // solo el que contiene "%"
    expect((await call(listTx as never, "/api/transactions?q=_")).body.total).toBe(0);
    expect((await call(listTx as never, "/api/transactions?category=none")).body.total).toBe(7);
    expect((await call(listTx as never, "/api/transactions?limit=1000")).status).toBe(400);
  });
  it("la fecha local de CDMX decide el día (23:30 local cae en el día local, no en el UTC)", async () => {
    const { c } = await setup();
    const r = await call(postTx as never, "/api/transactions", { body: { date: "2026-09-11T05:30:00Z", amount: "10", merchant: "Noche", card_id: c.id } }); // 23:30 del 10 en CDMX
    expect((await call(getTx as never, `/api/transactions/${r.body.id}`, {}, { id: String(r.body.id) })).body.occurred_date).toBe("2026-09-10");
  });
});

describe("importación CSV y categorización", () => {
  const csv = (t: string) => ({ raw: t, method: "POST", headers: { "content-type": "text/csv" } });
  it("importa filas válidas, informa errores y es idempotente", async () => {
    await call(postCard as never, "/api/cards", { body: card });
    const k = (await call(postCat as never, "/api/categories", { body: { name: "Súper" } })).body;
    await call(postRule as never, "/api/rules", { body: { pattern: "walmart", category_id: k.id } });
    const text = "fecha,comercio,monto,tarjeta\n2026-08-01,WALMART 123,\"1,200.00\",Banamex Oro\n2026-08-02,Reembolso,-50,Oro\n2026-08-03,Mala,abc,Oro\n";
    const a = await call(importCsv as never, "/api/transactions/import", csv(text));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ inserted: 2, duplicates: 0, skipped: 1 });
    expect(a.body.errors[0].line).toBe(4);
    const b = await call(importCsv as never, "/api/transactions/import", csv(text));
    expect(b.body).toMatchObject({ inserted: 0, duplicates: 2 });
    const cat = await query<{ n: string }>("SELECT k.name n FROM dbo.transactions t JOIN dbo.categories k ON k.id=t.category_id");
    expect(cat.map((x) => x.n)).toEqual(["Súper"]);
  });
  it("CSV sin columnas requeridas, vacío o con tipo incorrecto → 4xx", async () => {
    expect((await call(importCsv as never, "/api/transactions/import", csv("a,b\n1,2"))).status).toBe(400);
    expect((await call(importCsv as never, "/api/transactions/import", csv(""))).status).toBe(400);
    expect((await call(importCsv as never, "/api/transactions/import", { raw: "x", method: "POST", headers: { "content-type": "application/json" } })).status).toBe(415);
    expect((await call(importCsv as never, "/api/transactions/import", csv("fecha,comercio,monto,tarjeta\n" + "a".repeat(2.5 * 1024 * 1024)))).status).toBe(413);
  });
  it("'Categorizar' aplica reglas nuevas a movimientos sin categoría", async () => {
    const c = (await call(postCard as never, "/api/cards", { body: card })).body;
    await call(postTx as never, "/api/transactions", { body: { date: "2026-09-10T18:00:00Z", amount: "10", merchant: "UBER TRIP", card_id: c.id } });
    const k = (await call(postCat as never, "/api/categories", { body: { name: "Transporte" } })).body;
    await call(postRule as never, "/api/rules", { body: { pattern: "uber", category_id: k.id } });
    expect((await call(categorize as never, "/api/transactions/categorize", { method: "POST", body: {} })).body).toMatchObject({ updated: 1, remaining: 0 });
  });
  it("exporta CSV neutralizando fórmulas", async () => {
    const c = (await call(postCard as never, "/api/cards", { body: card })).body;
    await call(postTx as never, "/api/transactions", { body: { date: "2026-09-10T18:00:00Z", amount: "10", merchant: "=cmd|' /C calc'!A0", card_id: c.id } });
    const r = await call(exportCsv as never, "/api/reports/export?month=2026-09");
    expect(r.res.headers.get("content-disposition")).toContain("uzfinance-2026-09.csv");
    expect(r.body).toContain("'=cmd");
    expect(r.body).not.toMatch(/,=cmd/);
    expect((await call(exportCsv as never, "/api/reports/export?month=2026-13")).status).toBe(400);
  });
});
