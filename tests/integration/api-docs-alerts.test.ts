import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listAlerts } from "@/app/api/alerts/route";
import { PATCH as patchAlert } from "@/app/api/alerts/[id]/route";
import { POST as readAll } from "@/app/api/alerts/read-all/route";
import { DELETE as delDoc, GET as getDoc } from "@/app/api/documents/[id]/route";
import { POST as importMissing } from "@/app/api/documents/[id]/import-missing/route";
import { POST as reconcile } from "@/app/api/documents/[id]/reconcile/route";
import { GET as listFindings } from "@/app/api/recon/findings/route";
import { PATCH as patchFinding } from "@/app/api/recon/findings/[id]/route";
import { GET as getAlertCfg, PUT as putAlertCfg } from "@/app/api/settings/alerts/route";
import { GET as getMap, PUT as putMap } from "@/app/api/settings/statement-cards/route";
import { closePool, query, t } from "@/lib/db/pool";
import { docSchema, type StatementDoc } from "@/lib/import/statements";
import { createAlert, getAlertConfig } from "@/lib/repo/alerts";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { ingestTransaction } from "@/lib/repo/transactions";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { authed, ctx, guestPrincipal, req, resetDb } from "../helpers";

// Todo inventado: tarjetas, comercios y montos de ejemplo.
const tx = (o: { date: string; merchant: string; amount_cents: number; type?: string }) => ({ type: "purchase", holder: null, section: null, ...o }) as StatementDoc["transactions"][number];
const stmt = (o: Partial<StatementDoc> = {}) =>
  docSchema.parse({
    document: "banco_stmt", card_key: "banco", period: { start: "2026-08-19", end: "2026-09-18" }, as_of: "2026-09-18", plans: [], checks: [],
    transactions: [tx({ date: "2026-08-20", merchant: "CAFE UNO", amount_cents: 9_500 }), tx({ date: "2026-09-02", merchant: "ELECTRO CASA", amount_cents: 650_000 })],
    ...o,
  });

let seq = 0;
async function newDoc(o: { kind?: string; status?: string; extracted?: unknown } = {}): Promise<number> {
  const sha = createHash("sha256").update(`api-${++seq}-${Math.random()}`).digest("hex");
  const r = await query<{ id: number }>(
    "INSERT dbo.documents (sha256, kind, origin, status, title, size_bytes, extracted) OUTPUT INSERTED.id VALUES (@s, @k, 'app', @st, N'Documento de prueba', 1000, @e)",
    { s: t.char(sha), k: t.varchar(o.kind ?? "statement"), st: t.varchar(o.status ?? "needs_review"), e: t.str(o.extracted === undefined ? JSON.stringify({ statements: [stmt()] }) : JSON.stringify(o.extracted)) },
  );
  return r[0].id;
}
const call = (h: (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>, path: string, init: Parameters<typeof req>[1] = {}, id?: string | number) =>
  h(req(path, { headers: authed(), ...init }), ctx(id === undefined ? {} : { id: String(id) }));
const body = async (r: Response) => (await r.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const txCount = async () => Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions"))[0].n);
const mapBody = { banco: { default: "Banco Oro ···111" } };

beforeEach(async () => {
  await resetDb();
  await createCard({ name: "Banco Oro ···111", issuer: "banamex", last4: "111", aliases: null, color: "#123456" });
  await createCategory({ name: "Comisiones e intereses", color: "#123456" });
});
afterAll(closePool);

// Todas las rutas nuevas exigen sesión, usuario permitido y (en mutaciones) mismo origen.
type H = (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>;
const ROUTES: [string, H, string, string][] = [
  ["GET /api/documents/[id]", getDoc as H, "/api/documents/1", "GET"],
  ["DELETE /api/documents/[id]", delDoc as H, "/api/documents/1", "DELETE"],
  ["POST reconcile", reconcile as H, "/api/documents/1/reconcile", "POST"],
  ["POST import-missing", importMissing as H, "/api/documents/1/import-missing", "POST"],
  ["GET statement-cards", getMap as H, "/api/settings/statement-cards", "GET"],
  ["PUT statement-cards", putMap as H, "/api/settings/statement-cards", "PUT"],
  ["GET findings", listFindings as H, "/api/recon/findings", "GET"],
  ["PATCH finding", patchFinding as H, "/api/recon/findings/1", "PATCH"],
  ["GET alerts", listAlerts as H, "/api/alerts", "GET"],
  ["PATCH alert", patchAlert as H, "/api/alerts/1", "PATCH"],
  ["POST read-all", readAll as H, "/api/alerts/read-all", "POST"],
  ["GET settings/alerts", getAlertCfg as H, "/api/settings/alerts", "GET"],
  ["PUT settings/alerts", putAlertCfg as H, "/api/settings/alerts", "PUT"],
];

describe("seguridad de las rutas nuevas", () => {
  it.each(ROUTES)("%s sin sesión → 401", async (_n, h, path, method) => {
    expect((await h(req(path, { method, raw: method === "GET" ? undefined : "{}" }), ctx({ id: "1" }))).status).toBe(401);
  });
  it.each(ROUTES)("%s con usuario NO permitido → 403", async (_n, h, path, method) => {
    const headers = { "x-ms-client-principal": guestPrincipal("intruso@example.com") };
    expect((await h(req(path, { method, headers, raw: method === "GET" ? undefined : "{}" }), ctx({ id: "1" }))).status).toBe(403);
  });
  it.each(ROUTES.filter((r) => r[3] !== "GET"))("%s desde otro origen (CSRF) → 403", async (_n, h, path, method) => {
    expect((await h(req(path, { method, raw: "{}", headers: authed({ origin: "https://evil.example" }) }), ctx({ id: "1" }))).status).toBe(403);
  });
  it("ids inválidos → 400", async () => {
    expect((await call(getDoc as H, "/api/documents/abc", {}, "abc")).status).toBe(400);
    expect((await call(patchAlert as H, "/api/alerts/0", { method: "PATCH", body: { action: "read" } }, "0")).status).toBe(400);
  });
});

describe("GET/DELETE /api/documents/[id]", () => {
  it("404 si no existe; no filtra la huella; trae tarjetas", async () => {
    expect((await call(getDoc as H, "/api/documents/999", {}, 999)).status).toBe(404);
    const id = await newDoc();
    const res = await call(getDoc as H, `/api/documents/${id}`, {}, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = await body(res);
    expect(j.document.sha256).toBeUndefined();
    expect(j.document).toMatchObject({ id, kind: "statement", status: "needs_review" });
    expect(j.statement).toMatchObject({ needsMapping: ["banco"], map: null, runs: [] });
    expect(j.statement.keys).toEqual([{ card_key: "banco", documents: ["banco_stmt"], holders: [], sections: [], domiciliation: false }]);
    expect(j.cards.map((c: { name: string }) => c.name)).toContain("Banco Oro ···111");
  });

  it("comprobante en revisión: trae lo leído, los conflictos y la tarjeta candidata por terminación", async () => {
    await createCard({ name: "Débito ···456", issuer: "banamex", last4: "456", aliases: null, color: "#38bdf8" });
    const transfer = { template: "banamex_app", amountCents: 123_456, occurredAt: "2026-10-01T15:05:00.000Z", originLabel: "MiCuenta Banamex", originTail: "456", destAlias: "Casero", destTail: "789", destBank: "Bbva", destName: "Juan Perez", concept: "Renta", reference: "4321", trackingKey: "012345678901234567", authCode: "123456", accountType: "Débito" };
    const id = await newDoc({ kind: "transfer_receipt", extracted: { transfer, read: "ocr", conflicts: ["monto"], reason: "las dos lecturas no coinciden" } });
    const j = await body(await call(getDoc as H, `/api/documents/${id}`, {}, id));
    expect(j.statement).toBeNull();
    expect(j.transfer).toMatchObject({ read: "ocr", conflicts: ["monto"], reason: "las dos lecturas no coinciden", candidate: { cardName: "Débito ···456", how: "terminación" } });
    expect(j.transfer.transfer.amountCents).toBe(123_456);
  });

  it("DELETE borra el documento y sus conciliaciones pero NUNCA los movimientos; 404 después", async () => {
    await ingestTransaction({ merchant: "Cafe Uno", amountCents: 9_500, cardRef: "Banco Oro ···111", occurredAt: new Date("2026-08-20T18:00:00Z") }, "shortcut", { categorizer: new RulesCategorizer(), categoryIdsByName: new Map() });
    const id = await newDoc();
    await call(putMap as H, "/api/settings/statement-cards", { method: "PUT", body: mapBody });
    expect((await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id)).status).toBe(200);
    const runs = Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.recon_runs"))[0].n);
    expect(runs).toBe(1);
    const before = await txCount();
    expect((await call(delDoc as H, `/api/documents/${id}`, { method: "DELETE" }, id)).status).toBe(200);
    expect(await txCount()).toBe(before);
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.recon_runs"))[0].n)).toBe(0);
    expect((await call(delDoc as H, `/api/documents/${id}`, { method: "DELETE" }, id)).status).toBe(404);
    expect((await call(getDoc as H, `/api/documents/${id}`, {}, id)).status).toBe(404);
  });
});

describe("mapa de tarjetas de los estados", () => {
  it("GET vacío; PUT valida el esquema, que las tarjetas existan y que no se cree ninguna", async () => {
    expect(await body(await call(getMap as H, "/api/settings/statement-cards"))).toMatchObject({ map: null });
    const put = (b: unknown) => call(putMap as H, "/api/settings/statement-cards", { method: "PUT", body: b });
    expect((await put({ banco: { default: "No existe" } })).status).toBe(400);
    expect((await put({ banco: { default: { name: "Nueva", create: { issuer: "nu" } } } })).status).toBe(400);
    expect((await put({ banco: { default: "Banco Oro ···111", extra: 1 } })).status).toBe(400);
    expect((await put({ banco: { default: "Banco Oro ···111", holders: { "ANA": "Fantasma" } } })).status).toBe(400);
    expect((await put({ banco: 5 })).status).toBe(400);
    expect((await put([])).status).toBe(400);
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.cards"))[0].n)).toBe(1); // no se creó ninguna
    const ok = await put({ banco: { default: { name: "Banco Oro ···111" } } });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({ map: mapBody });
    expect(await body(await call(getMap as H, "/api/settings/statement-cards"))).toMatchObject({ map: mapBody });
  });
});

describe("conciliar, hallazgos e importar faltantes", () => {
  async function setup() {
    await ingestTransaction({ merchant: "Cafe Uno", amountCents: 9_500, cardRef: "Banco Oro ···111", occurredAt: new Date("2026-08-20T18:00:00Z") }, "shortcut", { categorizer: new RulesCategorizer(), categoryIdsByName: new Map() });
    await ingestTransaction({ merchant: "FANTASMA", amountCents: 7_700, cardRef: "Banco Oro ···111", occurredAt: new Date("2026-09-08T18:00:00Z") }, "shortcut", { categorizer: new RulesCategorizer(), categoryIdsByName: new Map() });
    const id = await newDoc();
    await call(putMap as H, "/api/settings/statement-cards", { method: "PUT", body: mapBody });
    return id;
  }
  const detail = async (id: number) => body(await call(getDoc as H, `/api/documents/${id}`, {}, id));

  it("reconcile: 404 / 409 si no es un estado; concilia y deja corrida con hallazgos y movimientos relacionados", async () => {
    expect((await call(reconcile as H, "/api/documents/999/reconcile", { method: "POST", body: {} }, 999)).status).toBe(404);
    const receipt = await newDoc({ kind: "transfer_receipt", extracted: null });
    expect((await call(reconcile as H, `/api/documents/${receipt}/reconcile`, { method: "POST", body: {} }, receipt)).status).toBe(409);

    const id = await setup();
    const r = await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id);
    expect(r.status).toBe(200);
    expect(await body(r)).toMatchObject({ documentId: id, status: "processed" });
    const j = await detail(id);
    expect(j.statement.needsMapping).toEqual([]);
    expect(j.statement.runs).toHaveLength(1);
    const kinds = j.statement.runs[0].findingList.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(["missing_in_app", "not_in_statement"]));
    const nis = j.statement.runs[0].findingList.find((f: { kind: string }) => f.kind === "not_in_statement");
    expect(j.statement.transactions[nis.txId]).toMatchObject({ merchant: "FANTASMA", cents: 7_700, card: "Banco Oro ···111" });
    expect((await body(await call(listFindings as H, "/api/recon/findings"))).findings.length).toBeGreaterThanOrEqual(2);
  });

  it("reconcile con un estado sin tarjeta evidente lo deja en revisión por mapeo (sin romper)", async () => {
    // Un card_key sin tarjeta evidente (el backend solo asigna solo lo inequívoco): se queda esperando el mapa.
    const id = await newDoc({ extracted: { statements: [stmt({ card_key: "zzz" })] } });
    const r = await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id);
    expect(await body(r)).toMatchObject({ status: "needs_review", needsMapping: ["zzz"] });
    expect((await body(await call(getDoc as H, `/api/documents/${id}`, {}, id))).statement).toMatchObject({ needsMapping: ["zzz"], runs: [] });
  });

  it("PATCH hallazgo: valida el cuerpo, 404, descartar y reabrir; no toca movimientos", async () => {
    const id = await setup();
    await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id);
    const f = (await detail(id)).statement.runs[0].findingList[0];
    const patch = (fid: number | string, b: unknown) => call(patchFinding as H, `/api/recon/findings/${fid}`, { method: "PATCH", body: b }, fid);
    expect((await patch(f.id, { status: "borrar" })).status).toBe(400);
    expect((await patch(f.id, { status: "dismissed", extra: 1 })).status).toBe(400);
    expect((await patch(999_999, { status: "dismissed" })).status).toBe(404);
    const before = await txCount();
    expect((await patch(f.id, { status: "dismissed" })).status).toBe(200);
    expect((await body(await call(listFindings as H, "/api/recon/findings"))).findings.map((x: { id: number }) => x.id)).not.toContain(f.id);
    expect((await patch(f.id, { status: "open" })).status).toBe(200);
    expect(await txCount()).toBe(before);
  });

  it("import-missing: valida, 404/409, vista previa sin escribir, importa solo lo faltante y es idempotente", async () => {
    const post = (id: number | string, b: unknown) => call(importMissing as H, `/api/documents/${id}/import-missing`, { method: "POST", body: b }, id);
    expect((await post(999, {})).status).toBe(404);
    const receipt = await newDoc({ kind: "transfer_receipt", extracted: null });
    expect((await post(receipt, {})).status).toBe(409);
    const nomap = await newDoc();
    expect((await post(nomap, {})).status).toBe(409); // sin mapa de tarjetas

    const id = await setup();
    await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id);
    expect((await post(id, { finding_ids: ["x"] })).status).toBe(400);
    expect((await post(id, { dry_run: "si" })).status).toBe(400);
    expect((await post(id, { otra: 1 })).status).toBe(400);

    const base = await txCount();
    const dry = await post(id, { dry_run: true });
    expect(dry.status).toBe(200);
    expect((await body(dry)).docs[0].inserted).toBe(1);
    expect(await txCount()).toBe(base); // la vista previa no escribe

    const real = await post(id, {});
    expect(real.status).toBe(200);
    expect(await txCount()).toBe(base + 1);
    expect((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions WHERE merchant_raw LIKE '%ELECTRO%'"))[0].n).toBe(1);
    // El hallazgo ya no está abierto y volver a importar no duplica.
    const open = (await detail(id)).statement.runs[0].findingList.filter((f: { kind: string; status: string }) => f.kind === "missing_in_app" && f.status === "open");
    expect(open).toHaveLength(0);
    await post(id, {});
    expect(await txCount()).toBe(base + 1);
  });

  it("no importa si los totales del PDF no cuadraron (extraction_check_failed)", async () => {
    await ingestTransaction({ merchant: "Cafe Uno", amountCents: 9_500, cardRef: "Banco Oro ···111", occurredAt: new Date("2026-08-20T18:00:00Z") }, "shortcut", { categorizer: new RulesCategorizer(), categoryIdsByName: new Map() });
    const id = await newDoc({ extracted: { statements: [stmt({ checks: [{ name: "suma de cargos", ok: false }] })] } });
    await call(putMap as H, "/api/settings/statement-cards", { method: "PUT", body: mapBody });
    await call(reconcile as H, `/api/documents/${id}/reconcile`, { method: "POST", body: {} }, id);
    const j = await detail(id);
    expect(j.statement.failedChecks).toEqual(["banco: suma de cargos"]);
    expect(j.statement.runs[0].trusted).toBe(false);
    const base = await txCount();
    const r = await call(importMissing as H, `/api/documents/${id}/import-missing`, { method: "POST", body: {} }, id);
    expect(r.status).toBe(200);
    expect((await body(r)).warnings.join(" ")).toContain("no se importa");
    expect(await txCount()).toBe(base);
  });
});

describe("alertas", () => {
  const mk = (k: string, severity: "info" | "warn" | "high" = "warn") => createAlert({ rule: "large_purchase", severity, title: `Alerta ${k}`, body: "Texto de prueba", dedupeKey: `test:${k}` });

  it("GET lista (sin descartadas por defecto), valida filtros; PATCH leer/descartar; read-all", async () => {
    await mk("a", "high");
    await mk("b");
    await mk("c", "info");
    let j = await body(await call(listAlerts as H, "/api/alerts"));
    expect(j.unread).toBe(3);
    expect(j.alerts).toHaveLength(3);
    const [a, b] = j.alerts as { id: number }[];
    expect((await call(listAlerts as H, "/api/alerts?limit=0")).status).toBe(400);
    expect((await call(listAlerts as H, "/api/alerts?limit=1")).status).toBe(200);
    expect((await body(await call(listAlerts as H, "/api/alerts?limit=1"))).alerts).toHaveLength(1);

    const patch = (id: number, b2: unknown) => call(patchAlert as H, `/api/alerts/${id}`, { method: "PATCH", body: b2 }, id);
    expect((await patch(a.id, { action: "borrar" })).status).toBe(400);
    expect((await patch(999_999, { action: "read" })).status).toBe(404);
    expect((await patch(a.id, { action: "read" })).status).toBe(200);
    expect((await body(await call(listAlerts as H, "/api/alerts"))).unread).toBe(2);
    expect((await patch(b.id, { action: "dismiss" })).status).toBe(200);
    j = await body(await call(listAlerts as H, "/api/alerts"));
    expect(j.alerts).toHaveLength(2);
    expect((await body(await call(listAlerts as H, "/api/alerts?include_dismissed=true"))).alerts).toHaveLength(3);

    const all = await call(readAll as H, "/api/alerts/read-all", { method: "POST", body: {} });
    expect(await body(all)).toEqual({ updated: 1 });
    expect((await body(await call(listAlerts as H, "/api/alerts"))).unread).toBe(0);
  });

  it("configuración: GET trae valores y defaults; PUT parcial guarda y valida (400 con los problemas)", async () => {
    const g = await body(await call(getAlertCfg as H, "/api/settings/alerts"));
    expect(g.config.largePurchaseCents).toBe(g.defaults.largePurchaseCents);
    const put = (b: unknown) => call(putAlertCfg as H, "/api/settings/alerts", { method: "PUT", body: b });
    const ok = await put({ largePurchaseCents: 8_000_00, mutedMerchants: ["uber eats"], whatsapp: { enabled: true } });
    expect(ok.status).toBe(200);
    const saved = (await body(ok)).config;
    expect(saved).toMatchObject({ largePurchaseCents: 8_000_00, whatsapp: { enabled: true, minSeverity: "warn" } });
    expect(saved.mutedMerchants).toHaveLength(1);
    expect((await getAlertConfig()).largePurchaseCents).toBe(8_000_00);

    const bad = await put({ largePurchaseCents: 5 });
    expect(bad.status).toBe(400);
    expect((await body(bad)).issues[0].path).toBe("largePurchaseCents");
    expect((await put({ desconocida: 1 })).status).toBe(400);
    expect((await put({ quietHours: { start: "25:99" } })).status).toBe(400);
    expect((await put({ enabled: { large_purchase: "si" } })).status).toBe(400);
    expect((await put([1])).status).toBe(400);
    expect((await getAlertConfig()).largePurchaseCents).toBe(8_000_00); // lo inválido no cambió nada
  });
});
