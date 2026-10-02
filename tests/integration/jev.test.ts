import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCategorizer } from "@/lib/categorizer";
import { JevCategorizer, type JevOptions } from "@/lib/categorizer/jev";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { closePool, query } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { createRule } from "@/lib/repo/rules";
import { categorizeUncategorized, createManual, ingestTransaction, updateTransaction } from "@/lib/repo/transactions";
import { resetDb } from "../helpers";

type Cat = { id: number; name: string };
let rest: Cat, super_: Cat, other: Cat;

/** Respuesta de Jev simulada: elige por palabras clave del comercio (la simulación no sabe de categorías reales). */
function fakeJev(pick: (merchant: string) => { choice: string; p: number } | "fail") {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const merchant = body.state.comercio as string;
    calls.push(merchant);
    const r = pick(merchant);
    if (r === "fail") return new Response("{}", { status: 500 });
    const keys = Object.keys(body.questions.categoria.criteria);
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === r.choice ? r.p : (1 - r.p) / (keys.length - 1)]));
    return new Response(JSON.stringify({ answers: { categoria: { type: "choice", choice: r.choice, confidence: r.p, probabilities } } }), { status: 200 });
  });
  return { calls, opts: { apiKey: "sk-or-v1-prueba-0000000000000000", timeoutMs: 2000, retries: 0, fetchImpl: fetchImpl as unknown as typeof fetch } satisfies JevOptions };
}
const KEYS = { rest: "restaurantes_y_cafes", sup: "supermercado", otros: "otros" };

const categoryOf = async (merchant: string) =>
  (await query<{ name: string | null; category_source: string | null; category_confidence: number | null }>(
    `SELECT k.name, x.category_source, CAST(x.category_confidence AS float) AS category_confidence
     FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id WHERE x.merchant_raw=@m
     ORDER BY x.id DESC`,
    { m: { type: (await import("mssql")).default.NVarChar, value: merchant } },
  ))[0];

beforeEach(async () => {
  await resetDb();
  rest = await createCategory({ name: "Restaurantes y cafés", color: "#f97316", description: "Starbucks, taquerías." });
  super_ = await createCategory({ name: "Supermercado", color: "#22c55e", description: "Walmart, Soriana, Aki." });
  other = await createCategory({ name: "Otros", color: "#9ca3af" });
  await createCard({ name: "Tarjeta Prueba", issuer: "banamex", last4: "1234", aliases: "Prueba", color: "#ef4444" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetEnvCache();
});
afterAll(closePool);

const ingest = (merchant: string, categorizer: JevCategorizer, cents = 1000) =>
  ingestTransaction({ merchant, amountCents: cents, cardRef: "Prueba", occurredAt: new Date("2026-09-10T18:00:00Z") }, "shortcut", { categorizer });

describe("JevCategorizer", () => {
  it("Jev categoriza y la fila guarda su origen y confianza", async () => {
    const { calls, opts } = fakeJev(() => ({ choice: KEYS.sup, p: 0.93 }));
    const r = await ingest("SUPER W MERIDA 62", new JevCategorizer(new RulesCategorizer(), opts));
    expect(r).toMatchObject({ status: "inserted", categoryId: super_.id });
    expect(calls).toEqual(["SUPER W MERIDA 62"]);
    expect(await categoryOf("SUPER W MERIDA 62")).toEqual({ name: "Supermercado", category_source: "jev", category_confidence: 0.93 });
  });

  it("una regla del usuario gana y NO llama a Jev", async () => {
    await createRule({ pattern: "starbucks", match_type: "contains", category_id: rest.id, priority: 0 });
    const { calls, opts } = fakeJev(() => ({ choice: KEYS.sup, p: 0.99 }));
    await ingest("STARBUCKS REFORMA", new JevCategorizer(new RulesCategorizer(), opts));
    expect(calls).toEqual([]);
    expect(await categoryOf("STARBUCKS REFORMA")).toMatchObject({ name: "Restaurantes y cafés", category_source: "rule", category_confidence: null });
  });

  it("el historial (mismo comercio categorizado a mano) gana sobre Jev y NO llama a Jev", async () => {
    const tarjeta = (await query<{ id: number }>("SELECT id FROM dbo.cards"))[0].id;
    await createManual({ occurredAt: new Date("2026-08-01T18:00:00Z"), amountCents: 5000, merchant: "TAQUERIA EL PRIMO", cardId: tarjeta, categoryId: rest.id, notes: null });
    const { calls, opts } = fakeJev(() => ({ choice: KEYS.sup, p: 0.99 }));
    await ingest("TAQUERIA EL PRIMO", new JevCategorizer(new RulesCategorizer(), opts), 7777);
    expect(calls).toEqual([]);
    expect(await categoryOf("TAQUERIA EL PRIMO")).toMatchObject({ name: "Restaurantes y cafés", category_source: "history" });
  });

  it("lo que puso Jev NO alimenta el historial (un error no se refuerza solo)", async () => {
    const first = fakeJev(() => ({ choice: KEYS.rest, p: 0.9 }));
    await ingest("COMERCIO RARO", new JevCategorizer(new RulesCategorizer(), first.opts), 1111);
    const second = fakeJev(() => ({ choice: KEYS.sup, p: 0.9 }));
    await ingest("COMERCIO RARO", new JevCategorizer(new RulesCategorizer(), second.opts), 2222);
    expect(second.calls).toEqual(["COMERCIO RARO"]); // volvió a preguntar a Jev
  });

  it("probabilidad baja → queda sin categoría para que la revises", async () => {
    const { opts } = fakeJev(() => ({ choice: KEYS.otros, p: 0.4 }));
    const r = await ingest("MERCADOPAGO*XYZ", new JevCategorizer(new RulesCategorizer(), opts));
    expect(r).toMatchObject({ status: "inserted", categoryId: null });
    expect(await categoryOf("MERCADOPAGO*XYZ")).toEqual({ name: null, category_source: null, category_confidence: null });
  });

  it("si Jev falla o tarda, la ingesta igual guarda la transacción (sin categoría)", async () => {
    const { opts } = fakeJev(() => "fail");
    const r = await ingest("OXXO POETAS MID", new JevCategorizer(new RulesCategorizer(), opts));
    expect(r).toMatchObject({ status: "inserted", categoryId: null });
  });

  it("el mismo comercio se consulta una sola vez por instancia, y un fallo no se memoriza", async () => {
    let n = 0;
    const { calls, opts } = fakeJev(() => (++n === 1 ? "fail" : { choice: KEYS.sup, p: 0.9 }));
    const c = new JevCategorizer(new RulesCategorizer(), opts);
    const input = { merchantRaw: "SORIANA 523", merchantNormalized: "SORIANA", amountCents: 100 };
    expect(await c.categorize(input)).toBeNull();
    expect(await c.categorize(input)).toBe(super_.id);
    expect(await c.categorize(input)).toBe(super_.id);
    expect(calls).toHaveLength(2);
  });

  it("los pagos de tarjeta no se categorizan ni se mandan a Jev", async () => {
    const { calls, opts } = fakeJev(() => ({ choice: KEYS.sup, p: 0.9 }));
    await ingestTransaction({ merchant: "SU ABONO GRACIAS", amountCents: -500000, cardRef: "Prueba", occurredAt: new Date("2026-09-10T18:00:00Z"), kind: "card_payment" }, "statement", {
      categorizer: new JevCategorizer(new RulesCategorizer(), opts),
    });
    expect(calls).toEqual([]);
    expect((await query<{ kind: string; category_id: number | null }>("SELECT kind, category_id FROM dbo.transactions"))[0]).toEqual({ kind: "card_payment", category_id: null });
  });

  it("cambiar la categoría a mano la marca 'manual' y borra la confianza; sin cambio conserva el origen", async () => {
    const { opts } = fakeJev(() => ({ choice: KEYS.sup, p: 0.8 }));
    const r = await ingest("TIENDA X", new JevCategorizer(new RulesCategorizer(), opts));
    const id = (r as { id: number }).id;
    const tarjeta = (await query<{ id: number }>("SELECT id FROM dbo.cards"))[0].id;
    const patch = { occurredAt: new Date("2026-09-10T18:00:00Z"), amountCents: 1000, merchant: "TIENDA X", cardId: tarjeta, categoryId: super_.id, notes: "nota" };
    await updateTransaction(id, patch); // misma categoría: sigue siendo de Jev
    expect(await categoryOf("TIENDA X")).toMatchObject({ category_source: "jev", category_confidence: 0.8 });
    await updateTransaction(id, { ...patch, categoryId: rest.id });
    expect(await categoryOf("TIENDA X")).toEqual({ name: "Restaurantes y cafés", category_source: "manual", category_confidence: null });
    await updateTransaction(id, { ...patch, categoryId: null });
    expect(await categoryOf("TIENDA X")).toEqual({ name: null, category_source: null, category_confidence: null });
  });
});

describe("getCategorizer / categorizeUncategorized", () => {
  it("sin OPENROUTER_API_KEY cae a solo reglas aunque CATEGORIZER=jev (falla seguro)", async () => {
    vi.stubEnv("CATEGORIZER", "jev");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    resetEnvCache();
    expect(await getCategorizer()).toBeInstanceOf(RulesCategorizer);
  });

  it("'Categorizar' pone categoría a lo pendiente con Jev, una consulta por comercio, y respeta lo ya categorizado", async () => {
    const tarjeta = (await query<{ id: number }>("SELECT id FROM dbo.cards"))[0].id;
    const mk = (m: string, cents: number, cat: number | null = null) =>
      createManual({ occurredAt: new Date("2026-09-10T18:00:00Z"), amountCents: cents, merchant: m, cardId: tarjeta, categoryId: cat, notes: null });
    await mk("AKI CHOLUL", 100);
    await mk("AKI CHOLUL", 200);
    await mk("DESCONOCIDO ZZ", 300);
    await mk("YA CATEGORIZADO", 400, rest.id);
    vi.stubEnv("CATEGORIZER", "jev");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-v1-prueba-0000000000000000");
    resetEnvCache();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      seen.push(body.state.comercio);
      const ok = body.state.comercio.startsWith("AKI");
      const keys = Object.keys(body.questions.categoria.criteria);
      const choice = ok ? KEYS.sup : KEYS.otros;
      const p = ok ? 0.95 : 0.3;
      return new Response(JSON.stringify({ answers: { categoria: { type: "choice", choice, confidence: p, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : 0.05])) } } }));
    });
    const res = await categorizeUncategorized();
    expect(res).toEqual({ updated: 2, remaining: 1 });
    expect(seen.filter((m) => m === "AKI CHOLUL")).toHaveLength(1);
    expect(await categoryOf("YA CATEGORIZADO")).toMatchObject({ name: "Restaurantes y cafés", category_source: "manual" });
    expect(other.id).toBeGreaterThan(0);
  });
});
