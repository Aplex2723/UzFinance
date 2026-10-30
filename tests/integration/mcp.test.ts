import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { closePool } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { createManual } from "@/lib/repo/transactions";
import { mcpFailures, mcpPerIp, mcpPerToken } from "@/lib/security/ingest-limiters";
import { proxy } from "@/proxy";
import { authed, MCP_TOKEN, req, resetDb, TOKEN } from "../helpers";

const bearer = (t = MCP_TOKEN) => ({ authorization: `Bearer ${t}` });
const call = (body: unknown, headers: Record<string, string> = bearer()) => POST(req("/api/mcp", { method: "POST", body, headers }));
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

beforeAll(async () => {
  await resetDb();
  const card = (await createCard({ name: "Amex Gold", issuer: "amex", last4: "1234", aliases: null, color: "#aaa" })).id;
  const cat = (await createCategory({ name: "Restaurantes", color: "#f50" })).id;
  // Julio de 2026 ya pasó: el total es el mismo se corra cuando se corra.
  await createManual({ occurredAt: new Date("2026-07-10T18:00:00Z"), amountCents: 80_000, merchant: "RESTAURANTE LA CASA", cardId: card, categoryId: cat, notes: "NOTA PRIVADA" });
  await createManual({ occurredAt: new Date("2026-07-12T18:00:00Z"), amountCents: 20_050, merchant: "UBER TRIP", cardId: card, categoryId: null, notes: null });
});
beforeEach(() => { mcpPerIp.reset(); mcpFailures.reset(); mcpPerToken.reset(); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCache(); });
afterAll(closePool);

describe("POST /api/mcp: autenticación", () => {
  it("sin token, con token equivocado o con el token de otra puerta → 401 con WWW-Authenticate", async () => {
    for (const headers of [{}, bearer("x".repeat(40)), bearer(TOKEN), { authorization: `Basic ${MCP_TOKEN}` }, authed()]) {
      const res = await call(rpc("tools/list"), headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });
  it("acepta cualquiera de los tokens configurados (el vigente y el anterior durante una rotación)", async () => {
    expect((await call(rpc("ping"))).status).toBe(200);
    expect((await call(rpc("ping"), bearer("old-mcp-token-0123456789-abcdefghijklmnopqrstuvwxyz"))).status).toBe(200);
  });
  it("sin MCP_TOKENS configurado falla cerrado", async () => {
    vi.stubEnv("MCP_TOKENS", "");
    resetEnvCache();
    expect((await call(rpc("ping"))).status).toBe(401);
  });
  it("un navegador (Origin presente) se rechaza aunque lleve un token válido", async () => {
    expect((await call(rpc("ping"), { ...bearer(), origin: "https://evil.example" })).status).toBe(403);
  });
  it("10 tokens inválidos bloquean la IP un rato (429), incluso con el token bueno", async () => {
    for (let i = 0; i < 10; i++) expect((await call(rpc("ping"), bearer("y".repeat(40)))).status).toBe(401);
    const res = await call(rpc("ping"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("tope por token", async () => {
    for (let i = 0; i < 300; i++) mcpPerToken.hit("claude");
    expect((await call(rpc("ping"))).status).toBe(429);
  });
  it("GET y DELETE → 405 (no hay flujo SSE ni sesiones)", async () => {
    for (const h of [GET, DELETE]) {
      const res = h();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });
});

describe("POST /api/mcp: protocolo", () => {
  it("initialize → tools/list → tools/call de punta a punta", async () => {
    const init = await (await call(rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }))).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = await (await call(rpc("tools/list", undefined, 2))).json();
    expect(list.id).toBe(2);
    expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("spending_summary");
    const res = await call(rpc("tools/call", { name: "spending_summary", arguments: { month: "2026-07" } }, 3));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.result.isError).toBe(false);
    const data = JSON.parse(out.result.content[0].text);
    expect(data.total_gastado).toBe(1000.5);
    expect(data.movimientos).toBe(2);
    // Lo que decidió el dueño que se ve: comercios y montos. Las notas, no.
    expect(JSON.stringify(data)).not.toContain("NOTA PRIVADA");
  });
  it("un error de la herramienta (argumentos inválidos) llega como isError, con 200", async () => {
    const out = await (await call(rpc("tools/call", { name: "spending_summary", arguments: { month: "2026-13" } }))).json();
    expect(out.result.isError).toBe(true);
    expect(out.error).toBeUndefined();
  });
  it("las notificaciones se aceptan con 202 y sin cuerpo", async () => {
    const res = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
  it("lote: responde solo a las solicitudes, en orden; vacío o demasiado grande → 400", async () => {
    const res = await call([rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("tools/list", undefined, 2)]);
    const out = await res.json();
    expect(out.map((r: { id: number }) => r.id)).toEqual([1, 2]);
    expect((await call([])).status).toBe(400);
    expect((await call(Array.from({ length: 11 }, (_, i) => rpc("ping", undefined, i)))).status).toBe(400);
  });
  it("JSON malformado → -32700 (400); sin Content-Type JSON → 415; cuerpo enorme → 413", async () => {
    const bad = await POST(req("/api/mcp", { method: "POST", raw: "{no es json", headers: bearer() }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe(-32700);
    const noType = await POST(new Request("http://localhost:3000/api/mcp", { method: "POST", headers: { ...bearer(), "content-type": "text/plain" }, body: "{}" }));
    expect(noType.status).toBe(415);
    const big = await POST(req("/api/mcp", { method: "POST", raw: JSON.stringify({ pad: "x".repeat(70_000) }), headers: bearer() }));
    expect(big.status).toBe(413);
  });
  it("no registra argumentos ni resultados en el log (son datos financieros)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await call(rpc("tools/call", { name: "spending_summary", arguments: { month: "2026-07" } }));
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[mcp]"));
    log.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/status=200 token=claude methods=tools\/call ms=\d+/);
    expect(lines[0]).not.toContain("2026-07");
    expect(lines[0]).not.toContain(MCP_TOKEN);
  });
});

describe("proxy: /api/mcp queda fuera de Easy Auth pero con tope de cuerpo", () => {
  const px = (contentLength: string | null) =>
    proxy(new NextRequest("http://localhost:3000/api/mcp", { method: "POST", headers: contentLength === null ? {} : { "content-length": contentLength } }));
  it("pasa sin sesión (la autenticación es el token del handler) y respeta 64 KB", () => {
    expect(px("0").status).toBe(200);
    expect(px(String(64 * 1024)).status).toBe(200);
    expect(px(String(64 * 1024 + 1)).status).toBe(413);
    expect(px("abc").status).toBe(413);
  });
  it("rutas hermanas NO heredan la excepción (son rutas exactas)", () => {
    const p = (path: string) => proxy(new NextRequest(`http://localhost:3000${path}`, { method: "POST" }));
    expect(p("/api/mcp/otro").status).toBe(401);
    expect(p("/api/mcp/").status).toBe(401);
    expect(p("/api/mcpx").status).toBe(401);
  });
});
