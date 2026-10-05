import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as listTx } from "@/app/api/transactions/route";
import { closePool, query, t } from "@/lib/db/pool";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { createManual, getTransactionSummary, listCardFacets, listTransactions } from "@/lib/repo/transactions";
import { authed, ctx, req, resetDb } from "../helpers";

// Todo inventado. "Hoy" de las pruebas: miércoles 2026-09-16 (la semana empieza el lunes 14).
const TODAY = "2026-09-16";
const ids: Record<string, number> = {};
let amex: number, bnx: number, costco: number, nu: number, dom: number, comida: number, sup: number;

type Opt = { cat?: number | null; sources?: string; mid?: string | null; recurring?: boolean; plan?: number | null; kind?: "expense" | "card_payment" };
async function add(key: string, date: string, cents: number, card: number, merchant: string, o: Opt = {}) {
  const r = await createManual({ occurredAt: new Date(`${date}T18:00:00Z`), amountCents: cents, merchant, cardId: card, categoryId: o.cat ?? null, notes: null });
  if (r.status !== "inserted") throw new Error(`no se insertó ${key}`);
  ids[key] = r.id;
  const sources = o.sources ?? "manual";
  const first = sources.split(",")[0];
  const source = ["shortcut", "email", "statement", "manual", "receipt"].includes(first) ? first : "manual";
  await query("UPDATE dbo.transactions SET source=@src, sources=@s, email_message_id=@m, is_recurring=@r, plan_id=@p, kind=@k WHERE id=@id", {
    id: t.int(r.id), src: t.varchar(source), s: t.varchar(sources), m: t.varchar(o.mid ?? null), r: t.bit(!!o.recurring), p: t.int(o.plan ?? null), k: t.varchar(o.kind ?? "expense"),
  });
}
const keys = async (f: Parameters<typeof listTransactions>[0]) => {
  const { rows, total } = await listTransactions({ limit: 100, ...f });
  const byId = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
  return { keys: rows.map((r) => byId[r.id]), total };
};
const sorted = async (f: Parameters<typeof listTransactions>[0]) => (await keys(f)).keys.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

beforeAll(async () => {
  await resetDb();
  amex = (await createCard({ name: "Amex Platinum", issuer: "amex", last4: null, aliases: null, color: "#9ca3af" })).id;
  bnx = (await createCard({ name: "Banamex Oro", issuer: "banamex", last4: null, aliases: null, color: "#ef4444" })).id;
  costco = (await createCard({ name: "Banamex Costco", issuer: "banamex", last4: null, aliases: null, color: "#f59e0b" })).id;
  nu = (await createCard({ name: "Nu", issuer: "nu", last4: null, aliases: null, color: "#8a05be" })).id;
  dom = (await createCard({ name: "Domiciliación", issuer: "banamex", last4: null, aliases: null, color: "#6b7280" })).id;
  comida = (await createCategory({ name: "Comida", color: "#f50" })).id;
  sup = (await createCategory({ name: "Súper", color: "#fa0" })).id;
  const plan = await query<{ id: number }>(
    `INSERT dbo.installment_plans (card_id, merchant, merchant_normalized, original_cents, monthly_cents, pending_cents, n_total, n_current, as_of, started_on, dedupe_key)
     OUTPUT INSERTED.id VALUES (@c, N'VIAJE MSI', N'VIAJE MSI', 600000, 50000, 550000, 12, 1, '2026-09-01', '2026-08-20', @k)`,
    { c: t.int(bnx), k: t.char("a".repeat(64)) },
  );
  // Hoy (miércoles 16)
  await add("t1", "2026-09-16", 30000, amex, "CAFE UNO", { cat: comida, sources: "shortcut,email", mid: "m1" });
  await add("t2", "2026-09-16", 12000, amex, "CAFE UNO", { cat: comida, sources: "shortcut" });
  await add("t3", "2026-09-16", 5000, bnx, "TIENDA UNO", { cat: sup, sources: "shortcut" });
  await add("t4", "2026-09-16", 4500, nu, "TIENDA DOS", { sources: "telegram" });
  await add("t5", "2026-09-16", -2000, bnx, "REEMBOLSO TIENDA", { sources: "whatsapp-d" });
  // Ayer: empate de monto entre dos tarjetas
  await add("t6", "2026-09-15", 20000, amex, "CENA", { sources: "statement" });
  await add("t7", "2026-09-15", 20000, bnx, "FARMACIA", { sources: "email", mid: "m7" });
  // Lunes, semana pasada, mes, agosto
  await add("t8", "2026-09-14", 8000, costco, "SUPER NUEVE", { sources: "receipt" });
  await add("t9", "2026-09-10", 15000, nu, "ROPA", { sources: "manual" });
  await add("t10", "2026-09-01", 9900, amex, "NETFLIX", { sources: "email", mid: "m10", recurring: true });
  await add("t11", "2026-08-20", 50000, bnx, "VIAJE MSI", { sources: "statement", plan: plan[0].id });
  await add("t12", "2026-08-15", 7000, amex, "VARIOS", { sources: "manual" });
  await add("t13", "2026-09-05", 1000, nu, "LEGACY", { sources: "" }); // fila antigua: sources vacío, cae a la columna source
  await query("UPDATE dbo.transactions SET source='statement' WHERE id=@id", { id: t.int(ids.t13) });
  // Un pago de tarjeta hoy (no es gasto)
  await add("p1", "2026-09-16", 100000, bnx, "PAGO A TARJETA", { sources: "email", mid: "mp1", kind: "card_payment" });
});
afterAll(closePool);

describe("listTransactions: filtros nuevos", () => {
  it("por omisión: solo gastos (13) y los pagos de tarjeta aparte", async () => {
    expect((await keys({})).total).toBe(13);
    expect(await keys({ kind: "card_payment" })).toMatchObject({ total: 1, keys: ["p1"] });
    expect((await keys({ kind: "all" })).total).toBe(14);
  });

  it("varias tarjetas (cardIds), una sola (cardId) y la unión de ambas", async () => {
    expect(await sorted({ cardIds: [amex, nu] })).toEqual(["t1", "t2", "t4", "t6", "t9", "t10", "t12", "t13"]);
    expect((await keys({ cardId: bnx })).total).toBe(4); // t3, t5, t7, t11
    expect((await keys({ cardId: bnx, cardIds: [nu, nu] })).total).toBe(4 + 3);
    expect((await keys({ cardIds: [] })).total).toBe(13);
    expect((await keys({ cardIds: [999999] })).total).toBe(0);
    expect((await keys({ cardIds: [costco], kind: "all" })).total).toBe(1);
  });

  it("from/to (extremos incluidos, abiertos, y month ∩ from/to)", async () => {
    expect(await sorted({ from: "2026-09-15", to: "2026-09-16" })).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
    expect((await keys({ from: "2026-09-16", to: "2026-09-16" })).total).toBe(5);
    expect((await keys({ from: "2026-09-14" })).total).toBe(8); // t1..t8
    expect((await keys({ to: "2026-08-31" })).total).toBe(2); // t11, t12
    expect((await keys({ month: "2026-08" })).total).toBe(2);
    expect((await keys({ month: "2026-09", from: "2026-09-10", to: "2026-10-31" })).total).toBe(9); // t1..t9
    expect((await keys({ from: "2026-10-01", to: "2026-10-31" })).total).toBe(0);
  });

  it("fuente: cada opción, las filas fusionadas cuentan para ambas, varias = O, y el chat incluye fecha explícita", async () => {
    expect(await sorted({ sources: ["email"] })).toEqual(["t1", "t7", "t10"]); // t1 es 'shortcut,email'
    expect(await sorted({ sources: ["shortcut"] })).toEqual(["t1", "t2", "t3"]);
    expect(await sorted({ sources: ["shortcut", "email"] })).toEqual(["t1", "t2", "t3", "t7", "t10"]);
    expect(await sorted({ sources: ["whatsapp"] })).toEqual(["t5"]); // 'whatsapp-d' (con fecha) también es WhatsApp
    expect(await sorted({ sources: ["telegram"] })).toEqual(["t4"]);
    expect(await sorted({ sources: ["manual"] })).toEqual(["t9", "t12"]); // lo capturado en la app, no lo del chat
    expect(await sorted({ sources: ["statement"] })).toEqual(["t6", "t11", "t13"]); // t13: sources vacío → columna source
    expect(await sorted({ sources: ["receipt"] })).toEqual(["t8"]);
    expect((await keys({ sources: ["email"], kind: "card_payment" })).keys).toEqual(["p1"]);
    expect((await keys({ sources: [] })).total).toBe(13);
  });

  it("coincide con la etiqueta completa: 'email' no encuentra 'emailx'", async () => {
    await add("x1", "2026-07-01", 111, nu, "ETIQUETA RARA", { sources: "emailx" });
    expect(await sorted({ sources: ["email"] })).toEqual(["t1", "t7", "t10"]);
    await query("DELETE dbo.transactions WHERE id=@id", { id: t.int(ids.x1) });
  });

  it("monto mínimo y máximo sobre el valor absoluto (un reembolso de $20 cuenta como 2000)", async () => {
    expect(await sorted({ minCents: 10000 })).toEqual(["t1", "t2", "t6", "t7", "t9", "t11"]);
    expect(await sorted({ maxCents: 5000 })).toEqual(["t3", "t4", "t5", "t13"]);
    expect(await sorted({ minCents: 4500, maxCents: 10000 })).toEqual(["t3", "t4", "t8", "t10", "t12"]);
    expect((await keys({ minCents: 5000, maxCents: 5000 })).keys).toEqual(["t3"]); // extremos incluidos
    expect((await keys({ minCents: 90000 })).total).toBe(0);
    expect((await keys({ minCents: 10000, maxCents: 4500 })).total).toBe(0); // al revés: vacío, no error
  });

  it("sin confirmar, MSI y recurrentes", async () => {
    // Banamex + solo Atajo/chat + sin correo + más de 24 h: t3 (Atajo) y t5 (WhatsApp con fecha). t7 tiene correo; t2 es Amex.
    expect(await sorted({ unconfirmed: true })).toEqual(["t3", "t5"]);
    const rows = (await listTransactions({ unconfirmed: true })).rows;
    expect(rows.every((r) => r.unconfirmed)).toBe(true);
    expect((await listTransactions({ limit: 100 })).rows.filter((r) => r.unconfirmed).length).toBe(2);
    expect(await sorted({ msi: true })).toEqual(["t11"]);
    expect(await sorted({ recurring: true })).toEqual(["t10"]);
    expect((await keys({ unconfirmed: false, msi: false, recurring: false })).total).toBe(13);
  });

  it("categoría: id, 'none' y combinada con otros filtros", async () => {
    expect(await sorted({ categoryId: comida })).toEqual(["t1", "t2"]);
    expect((await keys({ categoryId: "none" })).total).toBe(13 - 3);
    expect(await sorted({ categoryId: sup, cardIds: [bnx] })).toEqual(["t3"]);
  });

  it("orden: recientes, antiguos, mayor y menor monto (absoluto) con desempate estable", async () => {
    const recent = (await listTransactions({ sort: "recent", limit: 100 })).rows;
    for (let i = 1; i < recent.length; i++) expect(recent[i - 1].occurred_at >= recent[i].occurred_at).toBe(true);
    const oldest = (await listTransactions({ sort: "oldest", limit: 100 })).rows;
    expect(Number(oldest[0].id)).toBe(ids.t12);
    for (let i = 1; i < oldest.length; i++) expect(oldest[i - 1].occurred_at <= oldest[i].occurred_at).toBe(true);
    const desc = (await listTransactions({ sort: "amount_desc", limit: 100 })).rows;
    expect(Number(desc[0].id)).toBe(ids.t11);
    expect(desc.map((r) => Math.abs(r.amount_cents))).toEqual([...desc.map((r) => Math.abs(r.amount_cents))].sort((a, b) => b - a));
    expect(desc.slice(2, 4).map((r) => Number(r.id))).toEqual([ids.t7, ids.t6]); // empate de 20000: el más reciente (id mayor) primero
    const asc = (await listTransactions({ sort: "amount_asc", limit: 100 })).rows;
    expect(Number(asc[0].id)).toBe(ids.t13);
    expect(Number(asc[1].id)).toBe(ids.t5); // el reembolso de $20 va por su valor absoluto
    // Un valor desconocido (no tipado) cae al orden por omisión en vez de llegar al SQL
    const bogus = (await listTransactions({ sort: "x; DROP TABLE dbo.transactions" as never, limit: 100 })).rows;
    expect(bogus.map((r) => r.id)).toEqual(recent.map((r) => r.id));
  });

  it("combinaciones", async () => {
    expect(await sorted({ cardIds: [amex, bnx], sources: ["email"], minCents: 5000 })).toEqual(["t1", "t7", "t10"]);
    expect(await sorted({ from: "2026-09-16", to: "2026-09-16", cardIds: [bnx], unconfirmed: true })).toEqual(["t3", "t5"]);
    expect(await sorted({ month: "2026-09", sources: ["statement"], maxCents: 1000 })).toEqual(["t13"]);
    expect((await keys({ q: "cafe", cardIds: [nu] })).total).toBe(0);
    expect(await sorted({ q: "cafe", cardIds: [amex], from: TODAY, to: TODAY })).toEqual(["t1", "t2"]);
    expect((await keys({ kind: "card_payment", cardIds: [bnx], minCents: 100000, sources: ["email"] })).keys).toEqual(["p1"]);
    expect((await keys({ kind: "card_payment", cardIds: [amex] })).total).toBe(0);
  });

  it("paginación: el total no depende de la página y las páginas no se solapan", async () => {
    const a = await listTransactions({ sort: "amount_desc", limit: 5, offset: 0 });
    const b = await listTransactions({ sort: "amount_desc", limit: 5, offset: 5 });
    const c = await listTransactions({ sort: "amount_desc", limit: 5, offset: 10 });
    expect([a.total, b.total, c.total]).toEqual([13, 13, 13]);
    expect([a.rows.length, b.rows.length, c.rows.length]).toEqual([5, 5, 3]);
    const all = [...a.rows, ...b.rows, ...c.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(13);
    expect((await listTransactions({ limit: 5, offset: 100 })).rows).toHaveLength(0);
    // con filtros: el total refleja el filtrado
    const f = await listTransactions({ cardIds: [amex], limit: 2, offset: 2 });
    expect(f.total).toBe(5);
    expect(f.rows).toHaveLength(2);
  });

  it("listCardFacets: movimientos por tarjeta con todos los filtros menos el de tarjeta", async () => {
    const all = await listCardFacets({});
    expect(all.get(amex)?.count).toBe(5);
    expect(all.get(dom)).toBeUndefined();
    const today = await listCardFacets({ from: TODAY, to: TODAY, cardIds: [amex] }); // el filtro de tarjeta se ignora
    expect(today.get(amex)).toEqual({ count: 2, cents: 42000 });
    expect(today.get(bnx)).toEqual({ count: 2, cents: 3000 });
    expect(today.get(nu)?.count).toBe(1);
    expect(today.get(costco)).toBeUndefined();
    expect((await listCardFacets({ kind: "card_payment" })).get(bnx)?.count).toBe(1);
  });
});

describe("getTransactionSummary", () => {
  const today = { from: TODAY, to: TODAY };

  it("conjunto vacío: ceros, sin NaN y sin periodo anterior si no hay periodo", async () => {
    const s = await getTransactionSummary({ q: "NO EXISTE ESTE COMERCIO" }, { today: TODAY });
    expect(s).toMatchObject({ totalCents: 0, count: 0, purchaseCount: 0, purchaseCents: 0, refundCents: 0, avgTicketCents: null, cards: [], categories: [], topPurchase: null, topMerchant: null, previous: null, avg30: null, period: null });
  });

  it("un solo movimiento", async () => {
    const s = await getTransactionSummary({ q: "NETFLIX" }, { today: TODAY });
    expect(s).toMatchObject({ totalCents: 9900, count: 1, purchaseCount: 1, avgTicketCents: 9900 });
    expect(s.cards).toHaveLength(1);
    expect(s.cards[0]).toMatchObject({ name: "Amex Platinum", cents: 9900, pct: 100 });
    expect(s.topPurchase).toMatchObject({ merchant: "NETFLIX", cents: 9900, date: "2026-09-01", card: "Amex Platinum" });
    expect(s.topMerchant).toMatchObject({ merchant: "NETFLIX", count: 1 });
  });

  it("hoy: total neto con reembolso, ticket sin el reembolso, tarjetas con %, categorías, comparación contra ayer y promedio de 30 días", async () => {
    const s = await getTransactionSummary(today, { today: TODAY });
    expect(s.totalCents).toBe(30000 + 12000 + 5000 + 4500 - 2000);
    expect(s).toMatchObject({ count: 5, purchaseCount: 4, purchaseCents: 51500, refundCents: 2000, avgTicketCents: 12875 });
    expect(s.cards.map((c) => [c.name, c.cents])).toEqual([["Amex Platinum", 42000], ["Nu", 4500], ["Banamex Oro", 3000]]);
    expect(s.cards[0].pct).toBeCloseTo((42000 / 49500) * 100, 5);
    expect(s.cards.reduce((a, c) => a + c.pct, 0)).toBeCloseTo(100, 5);
    expect(s.cards[0]).toMatchObject({ issuer: "amex", color: "#9ca3af" });
    expect(s.categories.map((c) => [c.name, c.cents])).toEqual([["Comida", 42000], ["Súper", 5000]]); // top 2; "Sin categoría" (neto 2500) queda fuera
    expect(s.topPurchase).toMatchObject({ merchant: "CAFE UNO", cents: 30000 });
    expect(s.topMerchant).toMatchObject({ merchant: "CAFE UNO", cents: 42000, count: 2 });
    expect(s.period).toEqual({ from: TODAY, to: TODAY });
    expect(s.previous).toMatchObject({ from: "2026-09-15", to: "2026-09-15", label: "vs ayer", totalCents: 40000, count: 2 });
    expect(s.previous?.comparison?.pct).toBeCloseTo(((49500 - 40000) / 40000) * 100, 5);
    expect(s.previous?.comparison?.trend).toBe("up");
    // 30 días previos a hoy (17-ago … 15-sep): t11 50000, t6 20000, t7 20000, t8 8000, t9 15000, t10 9900, t13 1000
    const avg = Math.round(123900 / 30);
    expect(s.avg30).toMatchObject({ avgCents: avg, diffCents: 49500 - avg });
    expect(s.avg30?.pct).toBeCloseTo(((49500 - avg) / avg) * 100, 5);
  });

  it("el top-N de tarjetas se puede acotar y lo demás va al resto", async () => {
    const s = await getTransactionSummary(today, { today: TODAY, topCards: 1 });
    expect(s.cards).toHaveLength(1);
    expect(s.cardsRest).toEqual({ groups: 2, cents: 7500 });
  });

  it("empate de monto: orden por nombre y la compra más alta más reciente (id mayor)", async () => {
    const s = await getTransactionSummary({ from: "2026-09-15", to: "2026-09-15" }, { today: TODAY });
    expect(s.cards.map((c) => c.name)).toEqual(["Amex Platinum", "Banamex Oro"]);
    expect(s.cards.map((c) => c.pct)).toEqual([50, 50]);
    expect(Number(s.topPurchase?.id)).toBe(ids.t7);
    // ayer vs anteayer: el periodo anterior (14-sep) tiene t8
    expect(s.previous).toMatchObject({ label: "vs anteayer", totalCents: 8000 });
  });

  it("periodo anterior sin datos: total 0 y porcentaje null (no Infinity)", async () => {
    const s = await getTransactionSummary({ from: "2026-09-01", to: "2026-09-01" }, { today: TODAY });
    expect(s.totalCents).toBe(9900);
    expect(s.previous).toMatchObject({ from: "2026-08-31", to: "2026-08-31", totalCents: 0, count: 0 });
    expect(s.previous?.comparison).toEqual({ pct: null, diffCents: 9900, trend: "up" });
    expect(s.avg30).toBeNull(); // no es "hoy"
  });

  it("mes en curso contra los mismos días del mes pasado", async () => {
    const s = await getTransactionSummary({ month: "2026-09" }, { today: TODAY });
    expect(s.period).toEqual({ from: "2026-09-01", to: TODAY }); // recortado a hoy
    expect(s.previous).toMatchObject({ from: "2026-08-01", to: "2026-08-16", label: "vs mes pasado", totalCents: 7000 }); // t12 (15-ago); t11 (20-ago) queda fuera
    expect(s.totalCents).toBe(49500 + 40000 + 8000 + 15000 + 1000 + 9900);
    const closed = await getTransactionSummary({ month: "2026-08" }, { today: TODAY });
    expect(closed.totalCents).toBe(57000);
    expect(closed.previous).toMatchObject({ from: "2026-07-01", to: "2026-07-31", totalCents: 0 });
  });

  it("los demás filtros se aplican al resumen y a su periodo anterior", async () => {
    const s = await getTransactionSummary({ ...today, cardIds: [nu] }, { today: TODAY });
    expect(s).toMatchObject({ totalCents: 4500, count: 1 });
    expect(s.previous).toMatchObject({ totalCents: 0 });
    const msi = await getTransactionSummary({ msi: true }, { today: TODAY });
    expect(msi).toMatchObject({ totalCents: 50000, count: 1 });
    const un = await getTransactionSummary({ unconfirmed: true }, { today: TODAY });
    expect(un).toMatchObject({ totalCents: 3000, count: 2, purchaseCount: 1 });
    expect((await getTransactionSummary({ sources: ["email"], minCents: 10000 }, { today: TODAY })).totalCents).toBe(30000 + 20000);
  });

  it("pagos de tarjeta: habla de pagos (kind) y no mezcla gastos", async () => {
    const s = await getTransactionSummary({ ...today, kind: "card_payment" }, { today: TODAY });
    expect(s).toMatchObject({ kind: "card_payment", totalCents: 100000, count: 1, avgTicketCents: 100000 });
    expect(s.cards.map((c) => c.name)).toEqual(["Banamex Oro"]);
    expect(s.previous).toMatchObject({ totalCents: 0 });
    expect((await getTransactionSummary({ ...today, kind: "all" }, { today: TODAY })).totalCents).toBe(49500 + 100000);
  });

  it("el resumen ignora paginación y orden, y no carga filas (coincide con el total del listado)", async () => {
    const list = await listTransactions({ ...today, limit: 2, offset: 2, sort: "oldest" });
    const s = await getTransactionSummary({ ...today, limit: 2, offset: 2, sort: "oldest" }, { today: TODAY });
    expect(s.count).toBe(list.total);
  });
});

describe("seguridad del SQL", () => {
  it("el texto del usuario nunca se interpola en el SQL del repositorio", () => {
    const src = readFileSync(path.resolve(__dirname, "../../src/lib/repo/transactions.ts"), "utf8");
    const start = src.indexOf("function buildWhere");
    const end = src.indexOf("export async function getTransaction(");
    const block = src.slice(start, end);
    // Los fragmentos de WHERE (where.push) solo llevan parámetros (@q, @card0, @s0, @minc…): ninguna interpolación toca valores del filtro
    // (salvo el tipo de movimiento, que se reduce a una de dos constantes). El valor del usuario va en `params`, tipado.
    expect(block).toMatch(/@q|@minc|@card/);
    const pushes = [...block.matchAll(/(?:where\.push\(|const where: string\[\] = \[)([^;]*?)\)?;/g)].map((m) => m[1]);
    expect(pushes.length).toBeGreaterThan(8);
    for (const code of pushes) {
      for (const m of code.matchAll(/\$\{([^}]*)\}/g)) {
        const expr = m[1].trim();
        expect(expr, `interpolación sospechosa en el WHERE: \${${expr}}`).not.toMatch(/\bf\.(q|cardIds?|categoryId|month|from|to|sources|minCents|maxCents|unconfirmed|msi|recurring)\b/);
      }
    }
    expect(block).not.toMatch(/\bf\.q\b[^\n]*(where|SELECT)/);
  });
  it("entradas con comillas e inyección se tratan como datos", async () => {
    const evil = "'; DROP TABLE dbo.transactions; --";
    expect((await keys({ q: evil })).total).toBe(0);
    expect((await keys({ q: "' OR 1=1 --" })).total).toBe(0);
    expect((await getTransactionSummary({ q: evil }, { today: TODAY })).count).toBe(0);
    // un id de tarjeta no entero ni positivo se descarta (no se interpola)
    expect((await keys({ cardIds: [1.5, -3, Number.NaN] as number[] })).total).toBe(13);
    expect((await keys({ sources: ["email'; --" as never] })).total).toBe(13); // fuente desconocida: se ignora
    expect((await keys({})).total).toBe(13); // la tabla sigue ahí
  });
});

describe("GET /api/transactions", () => {
  const get = async (qs: string) => {
    const res = await listTx(req(`/api/transactions${qs}`, { headers: authed() }), ctx() as never);
    return { status: res.status, body: await res.json() };
  };

  it("acepta los filtros nuevos y card repetida o única", async () => {
    expect((await get(`?card=${amex}&card=${nu}`)).body.total).toBe(8);
    expect((await get(`?card=${bnx}`)).body.total).toBe(4);
    expect((await get(`?card=${amex}&card=${amex}`)).body.total).toBe(5); // duplicados se ignoran
    expect((await get("?from=2026-09-16&to=2026-09-16")).body.total).toBe(5);
    expect((await get("?source=email&source=shortcut")).body.total).toBe(5);
    expect((await get("?min=100&max=200")).body.total).toBe(4); // $100–$200: t2 (120), t6 y t7 (200), t9 (150)
    expect((await get("?min=99.5")).body.total).toBe(6);
    expect((await get("?unconfirmed=1")).body.total).toBe(2);
    expect((await get("?unconfirmed=0")).body.total).toBe(13);
    expect((await get("?msi=true")).body.total).toBe(1);
    expect((await get("?recurring=1")).body.total).toBe(1);
    const byAmount = await get("?sort=amount_desc&limit=2");
    expect(byAmount.body.rows.map((r: { amount_cents: number }) => r.amount_cents)).toEqual([50000, 30000]);
    expect((await get("?sort=oldest&limit=1")).body.rows[0].merchant_raw).toBe("VARIOS");
    expect((await get("?kind=card_payment&card=" + bnx)).body.total).toBe(1);
    expect((await get("?preset=today&from=2026-09-16&to=2026-09-16")).status).toBe(200);
  });

  it.each([
    ["from con formato inválido", "?from=2026-9-1"],
    ["fecha que no existe", "?from=2026-02-30"],
    ["to inválida", "?to=ayer"],
    ["from posterior a to", "?from=2026-10-02&to=2026-10-01"],
    ["rango de más de 5 años", "?from=2019-01-01&to=2026-10-01"],
    ["min no numérico", "?min=abc"],
    ["min negativo", "?min=-5"],
    ["min con tres decimales", "?min=1.234"],
    ["min vacío", "?min="],
    ["min mayor que max", "?min=500&max=100"],
    ["monto absurdo", "?max=999999999999"],
    ["fuente desconocida", "?source=hackeo"],
    ["fuente válida y otra mala", "?source=email&source=nope"],
    ["orden desconocido", "?sort=precio"],
    ["bandera inválida", "?unconfirmed=quizas"],
    ["msi inválido", "?msi=2"],
    ["tarjeta no numérica", "?card=abc"],
    ["tarjeta 0", "?card=0"],
    ["tarjeta vacía", "?card="],
    ["demasiadas tarjetas", `?${Array.from({ length: 51 }, (_, i) => `card=${i + 1}`).join("&")}`],
    ["preset desconocido", "?preset=ayer"],
    ["mes inválido", "?month=2026-13"],
    ["inyección en el orden", "?sort=recent;DROP%20TABLE%20dbo.transactions"],
  ])("400: %s", async (_name, qs) => {
    const r = await get(qs);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Datos inválidos");
  });

  it("la tabla sigue intacta tras las entradas hostiles", async () => {
    expect((await get("")).body.total).toBe(13);
  });
});

describe("búsqueda con comodines de LIKE", () => {
  it("%, _ y [ se tratan como texto literal", async () => {
    await resetDb();
    const card = (await createCard({ name: "Tarjeta X", issuer: "other", last4: null, aliases: null, color: "#111111" })).id;
    for (const [i, m] of ["OFERTA 50% DESC", "AB_CD", "TIENDA [2]", "NORMAL", "ABXCD"].entries()) {
      await createManual({ occurredAt: new Date(`2026-09-0${i + 1}T18:00:00Z`), amountCents: 1000 + i, merchant: m, cardId: card, categoryId: null, notes: null });
    }
    expect((await listTransactions({ q: "%" })).total).toBe(1);
    expect((await listTransactions({ q: "_" })).total).toBe(1);
    expect((await listTransactions({ q: "[" })).total).toBe(1);
    expect((await listTransactions({ q: "[2]" })).total).toBe(1);
    expect((await listTransactions({ q: "50%" })).total).toBe(1);
    expect((await listTransactions({ q: "B_C" })).total).toBe(1); // "_" literal: no encuentra ABXCD
    expect((await listTransactions({ q: "O%C" })).total).toBe(0); // % literal: no hace de "cualquier cosa"
    expect((await getTransactionSummary({ q: "%" })).count).toBe(1);
    expect((await listCardFacets({ q: "[" })).get(card)?.count).toBe(1);
  });
});
