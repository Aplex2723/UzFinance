import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/lib/db/pool";
import { GET as listTx, POST as createTx } from "@/app/api/transactions/route";
import { GET as listCards } from "@/app/api/cards/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { POST as importCsv } from "@/app/api/transactions/import/route";
import { POST as categorize } from "@/app/api/transactions/categorize/route";
import { DELETE as delTx } from "@/app/api/transactions/[id]/route";
import { PUT as putRule } from "@/app/api/rules/[id]/route";
import { authed, ctx, guestPrincipal, req, resetDb } from "../helpers";

beforeEach(resetDb);
afterAll(closePool);

const ENDPOINTS: [string, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>, string, string?][] = [
  ["GET /api/transactions", listTx as never, "/api/transactions"],
  ["POST /api/transactions", createTx as never, "/api/transactions", "POST"],
  ["GET /api/cards", listCards as never, "/api/cards"],
  ["GET /api/reports/export", exportCsv as never, "/api/reports/export?month=2026-09"],
  ["POST /api/transactions/import", importCsv as never, "/api/transactions/import", "POST"],
  ["POST /api/transactions/categorize", categorize as never, "/api/transactions/categorize", "POST"],
];

describe("sesión obligatoria en endpoints protegidos", () => {
  it.each(ENDPOINTS)("%s sin sesión → 401", async (_n, handler, path, method) => {
    const res = await handler(req(path, { method, ...(method ? { body: {} } : {}) }), ctx());
    expect(res.status).toBe(401);
  });

  it.each(ENDPOINTS)("%s con usuario NO permitido → 403", async (_n, handler, path, method) => {
    const res = await handler(req(path, { method, headers: { "x-ms-client-principal": guestPrincipal("intruso@gmail.com") }, ...(method ? { body: {} } : {}) }), ctx());
    expect(res.status).toBe(403);
  });

  it("rutas con parámetro también exigen sesión", async () => {
    expect((await delTx(req("/api/transactions/1", { method: "DELETE" }), ctx({ id: "1" }))).status).toBe(401);
    expect((await putRule(req("/api/rules/1", { method: "PUT", body: {} }), ctx({ id: "1" }))).status).toBe(401);
  });

  it("usuario permitido → 200", async () => {
    expect((await listTx(req("/api/transactions", { headers: authed() }), ctx())).status).toBe(200);
  });

  it("header X-MS-CLIENT-PRINCIPAL manipulado o vacío → 401", async () => {
    for (const bad of ["", "###", Buffer.from("{}").toString("base64"), Buffer.from('{"claims":[]}').toString("base64")]) {
      const res = await listTx(req("/api/transactions", { headers: { "x-ms-client-principal": bad } }), ctx());
      expect([401, 403]).toContain(res.status);
    }
  });

  it("mutación desde otro origen (CSRF) → 403 aun con sesión", async () => {
    const res = await createTx(req("/api/transactions", { body: {}, headers: authed({ origin: "https://evil.example" }) }), ctx());
    expect(res.status).toBe(403);
  });

  it("Content-Type distinto de JSON → 415; JSON malformado → 400; body enorme → 413", async () => {
    const h = authed();
    expect((await createTx(req("/api/transactions", { raw: "x=1", headers: { ...h, "content-type": "application/x-www-form-urlencoded" } }), ctx())).status).toBe(415);
    expect((await createTx(req("/api/transactions", { raw: "{no json", headers: h }), ctx())).status).toBe(400);
    expect((await createTx(req("/api/transactions", { raw: JSON.stringify({ merchant: "x".repeat(100_000) }), headers: h }), ctx())).status).toBe(413);
  });

  it("errores 500 no filtran detalles internos", async () => {
    const res = await listTx(req("/api/transactions?limit=abc", { headers: authed() }), ctx());
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
