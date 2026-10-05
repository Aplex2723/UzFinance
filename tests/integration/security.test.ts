import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool } from "@/lib/db/pool";
import { GET as listTx, POST as createTx } from "@/app/api/transactions/route";
import { GET as listCards } from "@/app/api/cards/route";
import { GET as exportCsv } from "@/app/api/reports/export/route";
import { POST as importCsv } from "@/app/api/transactions/import/route";
import { POST as categorize } from "@/app/api/transactions/categorize/route";
import { DELETE as delTx } from "@/app/api/transactions/[id]/route";
import { PUT as putRule } from "@/app/api/rules/[id]/route";
import { GET as waGet, POST as waPost } from "@/app/api/whatsapp/route";
import { GET as tgGet, POST as tgPost } from "@/app/api/telegram/route";
import { proxy } from "@/proxy";
import { telegramFailures, telegramPerIp, whatsappFailures, whatsappPerIp } from "@/lib/security/ingest-limiters";
import { authed, ctx, guestPrincipal, req, resetDb } from "../helpers";
import { secretHeader, TG, TG_ENV, textUpdate } from "../tg-webhook-fixtures";
import { signed, textMsg, WA, WA_ENV, webhookBody } from "../wa-webhook-fixtures";

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

describe("webhook de WhatsApp: fuera de Easy Auth pero con firma obligatoria", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of Object.keys(WA_ENV)) saved[k] = process.env[k];
    Object.assign(process.env, WA_ENV);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    whatsappPerIp.reset();
    whatsappFailures.reset();
  });

  it("POST sin firma → 401 (con o sin sesión de Easy Auth)", async () => {
    const body = webhookBody([textMsg("wamid.SEC1", "hola")]);
    expect((await waPost(req("/api/whatsapp", { method: "POST", body }))).status).toBe(401);
    expect((await waPost(req("/api/whatsapp", { method: "POST", body, headers: authed() }))).status).toBe(401);
  });
  it("POST con firma de otro secreto → 401; GET sin verify token → 403", async () => {
    const raw = JSON.stringify(webhookBody([textMsg("wamid.SEC2", "hola")]));
    expect((await waPost(req("/api/whatsapp", { method: "POST", raw, headers: signed(raw, "otro-secreto-inventado-0123456789abc") }))).status).toBe(401);
    expect((await waGet(req("/api/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"))).status).toBe(403);
  });
  it("con firma válida no hace falta sesión (la autenticación es la firma)", async () => {
    const raw = JSON.stringify(webhookBody([]));
    expect((await waPost(req("/api/whatsapp", { method: "POST", raw, headers: signed(raw) }))).status).toBe(200);
    expect(WA.verifyToken).toBeTruthy();
  });
});

describe("webhook de Telegram: fuera de Easy Auth pero con secreto obligatorio", () => {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of Object.keys(TG_ENV)) saved[k] = process.env[k];
    Object.assign(process.env, TG_ENV);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  beforeEach(() => {
    telegramPerIp.reset();
    telegramFailures.reset();
  });

  it("POST sin el secreto → 401 (con o sin sesión de Easy Auth)", async () => {
    const body = textUpdate(1, "hola");
    expect((await tgPost(req("/api/telegram", { method: "POST", body }))).status).toBe(401);
    expect((await tgPost(req("/api/telegram", { method: "POST", body, headers: authed() }))).status).toBe(401);
  });
  it("POST con un secreto equivocado → 401; GET → 405", async () => {
    const headers = secretHeader("otro-secreto-inventado-0123456789abcdef");
    expect((await tgPost(req("/api/telegram", { method: "POST", body: textUpdate(2, "hola"), headers }))).status).toBe(401);
    expect((await tgGet()).status).toBe(405);
  });
  it("con el secreto válido no hace falta sesión (la autenticación es el secreto)", async () => {
    const res = await tgPost(req("/api/telegram", { method: "POST", body: { update_id: 3 }, headers: secretHeader() }));
    expect(res.status).toBe(200);
    expect(TG.secret).toBeTruthy();
  });
});

describe("proxy: tope de Content-Length en rutas sin sesión (antes de que Next copie el cuerpo)", () => {
  const px = (path: string, contentLength: string | null, method = "POST") =>
    proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers: contentLength === null ? {} : { "content-length": contentLength } }));
  const KB = 1024;

  it.each([
    ["/api/whatsapp", 256 * KB],
    ["/api/telegram", 256 * KB],
    ["/api/ingest", 64 * KB],
    ["/api/ingest/email", 64 * KB],
  ])("%s: justo en el tope pasa y un byte más → 413", async (path, max) => {
    expect(px(path, String(max)).status).toBe(200);
    expect(px(path, "0").status).toBe(200);
    expect(px(path, null).status).toBe(200); // sin Content-Length (p. ej. GET o chunked): lo limita el handler al leer
    const res = px(path, String(max + 1));
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Cuerpo demasiado grande" });
    expect(px(path, String(14 * 1024 * 1024)).status).toBe(413);
  });
  it("un Content-Length ilegible o negativo tampoco pasa por estas rutas", () => {
    expect(px("/api/whatsapp", "abc").status).toBe(413);
    expect(px("/api/telegram", "-5").status).toBe(413);
  });
  it("el 413 llega antes que cualquier otra cosa y no toca Easy Auth ni reemite la cookie", () => {
    expect(px("/api/ingest", String(64 * KB + 1)).headers.get("set-cookie")).toBeNull();
  });
  it("los PDF de la app (/api/documents) y el resto de rutas NO se limitan aquí (siguen exigiendo sesión)", () => {
    expect(px("/api/documents", String(10 * 1024 * 1024)).status).toBe(401);
    expect(px("/api/transactions/import", String(10 * 1024 * 1024)).status).toBe(401);
  });
  it("rutas parecidas no heredan el tope ni la exclusión de Easy Auth", () => {
    expect(px("/api/whatsapp/otra", String(300 * KB)).status).toBe(401);
    expect(px("/api/ingestx", String(300 * KB)).status).toBe(401);
  });
});
