import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { POST as createTx } from "@/app/api/transactions/route";
import { POST as toMsi } from "@/app/api/transactions/[id]/msi/route";
import { closePool, query } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { createCard } from "@/lib/repo/cards";
import { createManual, ingestTransaction } from "@/lib/repo/transactions";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { mcpFailures, mcpPerIp, mcpPerToken } from "@/lib/security/ingest-limiters";
import { localDate } from "@/lib/time";
import { authed, ctx, MCP_TOKEN, req, resetDb } from "../helpers";

const OLD_TOKEN = "old-mcp-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const call = (body: unknown, token = MCP_TOKEN) => POST(req("/api/mcp", { method: "POST", body, headers: { authorization: `Bearer ${token}` } }));
const tool = async (name: string, args: Record<string, unknown>, token = MCP_TOKEN) => {
  const out = await (await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, token)).json();
  return { isError: out.result?.isError as boolean, data: out.result ? JSON.parse(out.result.content[0].text) : null, error: out.error };
};
const rows = () => query<{ id: number; sources: string; notes: string | null; plan_id: number | null; amount_cents: number; merchant_raw: string }>("SELECT CAST(id AS int) AS id, sources, notes, plan_id, CAST(amount_cents AS float) AS amount_cents, merchant_raw FROM dbo.transactions ORDER BY id");

let amex: number;
let debit: number;

beforeEach(async () => {
  await resetDb();
  mcpPerIp.reset(); mcpFailures.reset(); mcpPerToken.reset();
  amex = (await createCard({ name: "Amex Gold", issuer: "amex", last4: "1005", aliases: null, color: "#aaa" })).id;
  debit = (await createCard({ name: "Débito Banamex", issuer: "banamex", last4: "0296", aliases: null, color: "#aaa" })).id;
  vi.stubEnv("MCP_WRITE_CLIENTS", "claude");
  resetEnvCache();
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCache(); });
afterAll(closePool);

describe("MCP con escritura (MCP_WRITE_CLIENTS)", () => {
  it("solo los clientes autorizados ven y pueden llamar add_expense", async () => {
    const list = async (t: string) => (await (await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, t)).json()).result.tools.map((x: { name: string }) => x.name);
    expect(await list(MCP_TOKEN)).toEqual(expect.arrayContaining(["add_expense", "delete_expense", "list_cards", "spending_summary"]));
    expect(await list(OLD_TOKEN)).not.toContain("add_expense");
    const denied = await tool("add_expense", { amount: 100, merchant: "Oxxo", card: "1005" }, OLD_TOKEN);
    expect(denied.error.code).toBe(-32602);
    expect(await rows()).toHaveLength(0);

    vi.stubEnv("MCP_WRITE_CLIENTS", "");
    resetEnvCache();
    expect(await list(MCP_TOKEN)).not.toContain("add_expense");
  });

  it("registra un gasto de hoy como fuente 'mcp' (fusionable con el Atajo) y lo categoriza", async () => {
    const r = await tool("add_expense", { amount: 249.9, merchant: "Oxxo", card: "1005" });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ registrado: true, comercio: "Oxxo", monto: 249.9, tarjeta: "Amex Gold", fecha: localDate(new Date()), a_meses: null });
    const [x] = await rows();
    expect(x).toMatchObject({ id: r.data.id, sources: "mcp", notes: "MCP · claude", amount_cents: 24_990, plan_id: null });

    // El Atajo de la misma compra minutos después solo se anota como segunda fuente (no duplica).
    const at = new Date(Date.now() + 60_000);
    const s = await ingestTransaction({ merchant: "OXXO SUC 12", amountCents: 24_990, cardRef: "Amex Gold", occurredAt: at }, "shortcut", { categorizer: new RulesCategorizer() });
    expect(s.status).toBe("merged");
    expect((await rows()).map((y) => y.sources)).toEqual(["mcp,shortcut"]);
  });

  it("con fecha explícita usa la etiqueta mcp-d; fechas futuras o inválidas se rechazan", async () => {
    const ok = await tool("add_expense", { amount: 50, merchant: "Uber", card: "Amex", date: "2026-07-01" });
    expect(ok.data).toMatchObject({ fecha: "2026-07-01", hora: null });
    expect((await rows())[0].sources).toBe("mcp-d");
    expect((await tool("add_expense", { amount: 50, merchant: "Uber", card: "Amex", date: "2999-01-01" })).isError).toBe(true);
    expect((await tool("add_expense", { amount: 50, merchant: "Uber", card: "Amex", date: "2026-02-30" })).isError).toBe(true);
  });

  it("un posible duplicado no se registra hasta que la persona lo confirme", async () => {
    await createManual({ occurredAt: new Date(), amountCents: 12_000, merchant: "STARBUCKS", cardId: amex, categoryId: null, notes: null });
    const dup = await tool("add_expense", { amount: 120, merchant: "Starbucks", card: "1005" });
    expect(dup.isError).toBe(true);
    expect(dup.data).toMatchObject({ necesita: "allow_duplicate", existente: { comercio: "STARBUCKS", monto: 120 } });
    expect(await rows()).toHaveLength(1);
    const again = await tool("add_expense", { amount: 120, merchant: "Starbucks", card: "1005", allow_duplicate: true });
    expect(again.isError).toBe(false);
    expect(await rows()).toHaveLength(2);
  });

  it("montos altos piden confirmación; tarjeta ambigua o inexistente devuelve las opciones", async () => {
    const big = await tool("add_expense", { amount: 25_000, merchant: "Liverpool", card: "1005" });
    expect(big.data.necesita).toBe("confirmed");
    expect((await tool("add_expense", { amount: 25_000, merchant: "Liverpool", card: "1005", confirmed: true })).isError).toBe(false);
    const none = await tool("add_expense", { amount: 10, merchant: "X", card: "Santander" });
    expect(none.isError).toBe(true);
    expect(none.data.tarjetas.map((c: { tarjeta: string }) => c.tarjeta)).toEqual(expect.arrayContaining(["Amex Gold", "Débito Banamex"]));
  });

  it("a meses: crea el plan manual ligado; débito no admite MSI", async () => {
    const r = await tool("add_expense", { amount: 3820, merchant: "Liverpool", card: "Amex Gold", installments: 3 });
    expect(r.data.a_meses).toMatchObject({ meses: 3, mensualidad: 1273.33 });
    const [x] = await rows();
    expect(x.plan_id).not.toBeNull();
    const [p] = await query<{ source: string; n_total: number; original_cents: number }>("SELECT source, n_total, CAST(original_cents AS float) AS original_cents FROM dbo.installment_plans");
    expect(p).toEqual({ source: "manual", n_total: 3, original_cents: 382_000 });

    const deb = await tool("add_expense", { amount: 900, merchant: "Sears", card: "0296", installments: 6 });
    expect(deb.isError).toBe(true);
    expect(deb.data.error).toMatch(/débito/);
  });

  it("delete_expense deshace lo del MCP (con su plan) pero nunca toca otras fuentes", async () => {
    const r = await tool("add_expense", { amount: 3820, merchant: "Liverpool", card: "Amex Gold", installments: 3 });
    const del = await tool("delete_expense", { id: r.data.id });
    expect(del.data).toMatchObject({ borrado: true, comercio: "Liverpool", monto: 3820 });
    expect(await rows()).toHaveLength(0);
    expect(await query("SELECT id FROM dbo.installment_plans")).toHaveLength(0);

    const other = await createManual({ occurredAt: new Date(), amountCents: 5_000, merchant: "APP", cardId: amex, categoryId: null, notes: null });
    if (other.status !== "inserted") throw new Error("setup");
    const refused = await tool("delete_expense", { id: other.id });
    expect(refused.isError).toBe(true);
    expect(await rows()).toHaveLength(1);
  });
});

describe("MSI desde la app", () => {
  const post = (body: unknown) => createTx(req("/api/transactions", { method: "POST", body, headers: authed() }), ctx());
  const base = (o: Record<string, unknown> = {}) => ({ date: new Date().toISOString(), amount: "3820", merchant: "Liverpool", card_id: amex, category_id: null, notes: null, ...o });

  it("agregar un gasto a 3 MSI crea el gasto completo y su plan", async () => {
    const res = await post(base({ msi_months: 3 }));
    expect(res.status).toBe(201);
    expect((await res.json()).msi).toMatchObject({ months: 3, monthly_cents: 127_333 });
    expect((await rows())[0].plan_id).not.toBeNull();
  });

  it("si la compra ya llegó (Atajo), ofrece pasar ESA a meses en vez de duplicarla", async () => {
    const prior = await ingestTransaction({ merchant: "LIVERPOOL PERISUR", amountCents: 382_000, cardRef: "Amex Gold", occurredAt: new Date(Date.now() - 3_600_000) }, "shortcut", { categorizer: new RulesCategorizer() });
    if (prior.status !== "inserted") throw new Error("setup");
    const res = await post(base({ msi_months: 6 }));
    expect(res.status).toBe(409);
    expect((await res.json()).similar).toMatchObject({ id: prior.id, merchant: "LIVERPOOL PERISUR" });
    expect(await rows()).toHaveLength(1);

    const conv = await toMsi(req(`/api/transactions/${prior.id}/msi`, { method: "POST", body: { months: 6 }, headers: authed() }), ctx({ id: String(prior.id) }));
    expect(conv.status).toBe(201);
    expect((await rows())[0].plan_id).not.toBeNull();
    // Dos veces no: ya está a meses.
    const twice = await toMsi(req(`/api/transactions/${prior.id}/msi`, { method: "POST", body: { months: 6 }, headers: authed() }), ctx({ id: String(prior.id) }));
    expect(twice.status).toBe(400);
    expect(await query("SELECT id FROM dbo.installment_plans")).toHaveLength(1);

    // "Es otra compra": se registra aparte.
    const other = await post(base({ msi_months: 6, allow_duplicate: true, date: new Date(Date.now() + 120_000).toISOString() }));
    expect(other.status).toBe(201);
    expect(await rows()).toHaveLength(2);
  });

  it("la misma compra a meses repetida otro mes es OTRO plan (no pisa el anterior)", async () => {
    expect((await post(base({ msi_months: 3, date: "2026-03-10T18:00:00Z" }))).status).toBe(201);
    expect((await post(base({ msi_months: 3, date: "2026-05-10T18:00:00Z" }))).status).toBe(201);
    const plans = await query<{ started_on: string }>("SELECT CONVERT(char(10), started_on, 23) AS started_on FROM dbo.installment_plans ORDER BY id");
    expect(plans.map((p) => p.started_on)).toEqual(["2026-03-10", "2026-05-10"]);
    const linked = await query<{ n: number }>("SELECT COUNT(DISTINCT plan_id) AS n FROM dbo.transactions");
    expect(linked[0].n).toBe(2);
  });

  it("pasar a meses un gasto cuyo plan ya trajo el estado de cuenta liga ESE plan (no crea otro)", async () => {
    const tx = await createManual({ occurredAt: new Date("2026-06-10T18:00:00Z"), amountCents: 382_000, merchant: "LIVERPOOL", cardId: amex, categoryId: null, notes: null });
    if (tx.status !== "inserted") throw new Error("setup");
    const { upsertPlan } = await import("@/lib/repo/plans");
    const stmt = await upsertPlan({ cardId: amex, merchant: "LIVERPOOL PERISUR", originalCents: 382_000, monthlyCents: 127_333, pendingCents: 127_334, nTotal: 3, nCurrent: 2, asOf: "2026-08-25", startedOn: "2026-06-11" });
    const conv = await toMsi(req(`/api/transactions/${tx.id}/msi`, { method: "POST", body: { months: 3 }, headers: authed() }), ctx({ id: String(tx.id) }));
    expect(conv.status).toBe(201);
    expect(await query("SELECT id FROM dbo.installment_plans")).toHaveLength(1);
    expect(Number((await rows())[0].plan_id)).toBe(stmt.id);
  });

  it("si la compra ya está a meses, avisa (sin ofrecer convertir) en vez de duplicarla", async () => {
    expect((await post(base({ msi_months: 3 }))).status).toBe(201);
    const res = await post(base({ msi_months: 3, date: new Date(Date.now() + 120_000).toISOString() }));
    expect(res.status).toBe(409);
    expect((await res.json()).similar.already_msi).toBe(true);
    expect(await rows()).toHaveLength(1);
  });

  it("débito o reembolso no van a meses", async () => {
    expect((await post(base({ card_id: debit, msi_months: 3 }))).status).toBe(400);
    expect((await post(base({ amount: "-3820", msi_months: 3 }))).status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });
});
