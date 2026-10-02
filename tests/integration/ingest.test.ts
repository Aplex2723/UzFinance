import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/ingest/route";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { createRule } from "@/lib/repo/rules";
import { closePool, query } from "@/lib/db/pool";
import { ingestFailures, ingestPerIp } from "@/lib/security/ingest-limiters";
import { req, resetDb, TOKEN } from "../helpers";

const auth = { authorization: `Bearer ${TOKEN}` };
let n = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${++n % 250}:4000` }); // IP distinta por prueba
const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) => POST(req("/api/ingest", { method: "POST", body, raw, headers: { ...ip(), ...headers } }));
const count = async () => Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions"))[0].n);
const payload = { merchant: "STARBUCKS REFORMA 123", amount: "$85.50", card: "Banamex Oro", date: "2026-09-10T15:30:00-06:00" };

beforeEach(async () => {
  await resetDb();
  ingestFailures.reset();
  ingestPerIp.reset();
  const cat = await createCategory({ name: "Restaurantes", color: "#ff4d1c" });
  await createRule({ pattern: "starbucks", match_type: "contains", category_id: cat.id, priority: 0 });
  await createCard({ name: "Banamex Oro", issuer: "banamex", last4: "4412", aliases: "Oro Visa", color: "#ef4444" });
});
afterAll(closePool);

describe("autenticación por token", () => {
  it("sin Authorization → 401 y no inserta", async () => {
    const res = await post(payload);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await count()).toBe(0);
  });
  it.each([
    ["token incorrecto", "Bearer " + "x".repeat(48)],
    ["esquema incorrecto", `Basic ${TOKEN}`],
    ["sin esquema", TOKEN],
    ["token casi correcto", `Bearer ${TOKEN}0`],
    ["vacío", "Bearer "],
  ])("%s → 401", async (_n, h) => {
    expect((await post(payload, { authorization: h })).status).toBe(401);
    expect(await count()).toBe(0);
  });
  it("la sesión de Easy Auth NO sustituye al token", async () => {
    expect((await post(payload, { "x-ms-client-principal": "e30=" })).status).toBe(401);
  });
  it("token válido → 200 e inserta con categoría por regla", async () => {
    const res = await post(payload, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "inserted", cardMatched: true });
    const rows = await query<{ amount_cents: number; merchant_normalized: string; name: string; source: string }>(
      "SELECT CAST(t.amount_cents AS float) amount_cents, t.merchant_normalized, k.name, t.source FROM dbo.transactions t JOIN dbo.categories k ON k.id=t.category_id");
    expect(rows).toEqual([{ amount_cents: 8550, merchant_normalized: "STARBUCKS REFORMA 123", name: "Restaurantes", source: "shortcut" }]);
  });
  it("durante la rotación acepta el token anterior", async () => {
    process.env.INGEST_TOKEN_PREVIOUS = "previous-token-0123456789-abcdefghijklmnopqrst";
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    try {
      expect((await post(payload, { authorization: `Bearer ${process.env.INGEST_TOKEN_PREVIOUS}` })).status).toBe(200);
    } finally {
      delete process.env.INGEST_TOKEN_PREVIOUS;
      resetEnvCache();
    }
    expect((await post({ ...payload, merchant: "OTRO" }, { authorization: "Bearer previous-token-0123456789-abcdefghijklmnopqrst" })).status).toBe(401);
  });
});

describe("deduplicación", () => {
  it("el mismo payload dos veces inserta una sola vez", async () => {
    const h = { ...auth, "x-forwarded-for": "203.0.113.50" };
    expect((await (await post(payload, h)).json()).status).toBe("inserted");
    const second = await post(payload, h);
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("duplicate");
    expect(await count()).toBe(1);
  });
  it("cambia el monto → es otro movimiento", async () => {
    await post(payload, auth);
    await post({ ...payload, amount: "$85.51" }, auth);
    expect(await count()).toBe(2);
  });
  it("llamadas concurrentes idénticas no duplican", async () => {
    const h = { ...auth, "x-forwarded-for": "203.0.113.51" };
    await Promise.all(Array.from({ length: 6 }, () => post(payload, h)));
    expect(await count()).toBe(1);
  });
  it("estado de cuenta no duplica un cargo ya recibido por el Atajo (misma tarjeta, día, monto)", async () => {
    await post(payload, auth);
    const { POST: importCsv } = await import("@/app/api/transactions/import/route");
    const { authed } = await import("../helpers");
    const csv = "fecha,comercio,monto,tarjeta\n2026-09-10,STARBUCKS COFFEE MX,85.50,Banamex Oro\n";
    const res = await importCsv(req("/api/transactions/import", { raw: csv, method: "POST", headers: { ...authed(), "content-type": "text/csv" } }), { params: Promise.resolve({}) });
    expect(await res.json()).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await count()).toBe(1);
  });
});

describe("validación estricta → 400", () => {
  it.each([
    ["JSON malformado", undefined, "{not json"],
    ["body vacío", undefined, ""],
    ["falta merchant", { amount: "10", card: "x" }, undefined],
    ["falta amount", { merchant: "x", card: "x" }, undefined],
    ["falta card", { merchant: "x", amount: "10" }, undefined],
    ["clave desconocida", { ...payload, admin: true }, undefined],
    ["monto no numérico", { ...payload, amount: "mucho" }, undefined],
    ["monto cero", { ...payload, amount: "0" }, undefined],
    ["monto como objeto", { ...payload, amount: { $gt: 0 } }, undefined],
    ["fecha inválida", { ...payload, date: "ayer" }, undefined],
    ["fecha futura", { ...payload, date: "2099-01-01T00:00:00Z" }, undefined],
    ["merchant demasiado largo", { ...payload, merchant: "x".repeat(121) }, undefined],
    ["arreglo en vez de objeto", [payload], undefined],
    ["null", null, "null"],
  ])("%s", async (_n, body, raw) => {
    const res = await post(body, auth, raw);
    expect(res.status).toBe(400);
    expect(await count()).toBe(0);
  });
  it("Content-Type incorrecto → 415; body > 8 KB → 413", async () => {
    expect((await post(undefined, { ...auth, "content-type": "text/plain" }, "hola")).status).toBe(415);
    expect((await post({ ...payload, notes: "x".repeat(9000) }, auth)).status).toBe(413);
  });
  it("intentos de inyección SQL se guardan como texto inerte", async () => {
    const evil = "'; DROP TABLE dbo.transactions; --";
    expect((await post({ ...payload, merchant: evil }, auth)).status).toBe(200);
    const rows = await query<{ merchant_raw: string }>("SELECT merchant_raw FROM dbo.transactions");
    expect(rows[0].merchant_raw).toBe(evil);
  });
  it("las respuestas de error no reflejan el payload", async () => {
    const res = await post({ ...payload, amount: "SECRETO-123" }, auth);
    expect(JSON.stringify(await res.json())).not.toContain("SECRETO-123");
  });
});

describe("comportamiento del Atajo", () => {
  it("tarjeta desconocida → 'Sin asignar' (no se pierde el gasto)", async () => {
    const res = await post({ ...payload, card: "Tarjeta Rara" }, auth);
    expect(await res.json()).toMatchObject({ status: "inserted", cardMatched: false });
    const r = await query<{ name: string }>("SELECT c.name FROM dbo.transactions t JOIN dbo.cards c ON c.id=t.card_id");
    expect(r[0].name).toBe("Sin asignar");
  });
  it("si la tarjeta no se reconoce, anota el texto recibido para crear el alias", async () => {
    await post({ ...payload, card: "Nu México", notes: "viaje" }, auth);
    const r = await query<{ notes: string }>("SELECT notes FROM dbo.transactions");
    expect(r[0].notes).toBe('Tarjeta sin reconocer: "Nu México" · viaje');
  });
  it("reconoce la tarjeta por alias y por últimos 4", async () => {
    expect((await (await post({ ...payload, card: "oro visa" }, auth)).json()).cardMatched).toBe(true);
    expect((await (await post({ ...payload, merchant: "OTRO", card: "•••• 4412" }, auth)).json()).cardMatched).toBe(true);
  });
  it("monto numérico y reembolsos negativos", async () => {
    await post({ ...payload, amount: 120.5 }, auth);
    await post({ ...payload, merchant: "REEMBOLSO", amount: "-45.00" }, auth);
    const r = await query<{ c: number }>("SELECT CAST(amount_cents AS float) c FROM dbo.transactions ORDER BY amount_cents");
    expect(r.map((x) => x.c)).toEqual([-4500, 12050]);
  });
  it("sin fecha usa la hora actual", async () => {
    const { date: _d, ...noDate } = payload;
    void _d;
    await post(noDate, auth);
    const r = await query<{ s: number }>("SELECT ABS(DATEDIFF(second, occurred_at, SYSUTCDATETIME())) s FROM dbo.transactions");
    expect(r[0].s).toBeLessThan(30);
  });
  it("X-Dry-Run valida pero no inserta", async () => {
    expect((await post(payload, { ...auth, "x-dry-run": "1" })).status).toBe(200);
    expect((await post({ ...payload, amount: "x" }, { ...auth, "x-dry-run": "1" })).status).toBe(400);
    expect(await count()).toBe(0);
  });
});

describe("rate limiting", () => {
  it("tras 10 tokens inválidos desde una IP → 429 (incluso con token bueno)", async () => {
    const h = { "x-forwarded-for": "192.0.2.77" };
    for (let i = 0; i < 10; i++) expect((await post(payload, h)).status).toBe(401);
    const blocked = await post(payload, { ...h, ...auth });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // otra IP no se ve afectada
    expect((await post(payload, { ...auth, "x-forwarded-for": "192.0.2.78" })).status).toBe(200);
  });
  it("más de 60 solicitudes/min por IP → 429", async () => {
    const h = { ...auth, "x-forwarded-for": "192.0.2.90" };
    let last = 200;
    for (let i = 0; i < 61; i++) last = (await post({ ...payload, merchant: `M${i}` }, h)).status;
    expect(last).toBe(429);
  });
});
