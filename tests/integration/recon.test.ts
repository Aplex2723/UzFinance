import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { closePool, query, t } from "@/lib/db/pool";
import { cardMapSchema, docSchema, type CardMap, type StatementDoc } from "@/lib/import/statements";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { deleteTransaction, ingestTransaction } from "@/lib/repo/transactions";
import {
  getStatementCardMap, importMissing, listOpenFindings, listRuns, reconcileDocument, setFindingStatus, setStatementCardMap, unmappedCardKeys,
} from "@/lib/repo/recon";
import { resetDb } from "../helpers";

// Todo inventado: tarjetas, comercios y montos de ejemplo.
const map: CardMap = cardMapSchema.parse({
  banco: { default: "Banco Oro ···111" },
  plata: { default: "Plata Platino", holders: { "ANA PEREZ": "Plata Adicional · Ana" } },
  nube: { default: { name: "Nube Morada", create: { issuer: "nu" } } },
});
const NOW = new Date("2026-10-04T18:00:00Z");
const cats = new Map<string, number>();
const tx = (o: Partial<StatementDoc["transactions"][number]> & { date: string; merchant: string; amount_cents: number }) => ({ type: "purchase", holder: null, section: null, ...o }) as StatementDoc["transactions"][number];
const mkDoc = (o: Partial<StatementDoc> & { transactions: StatementDoc["transactions"] }): StatementDoc =>
  docSchema.parse({ document: "banco_stmt", card_key: "banco", period: { start: "2026-08-19", end: "2026-09-18" }, as_of: "2026-09-18", plans: [], checks: [], ...o });

let cardIds: Record<string, number> = {};
let docSeq = 0;
async function newDoc(statements: StatementDoc[] | null): Promise<number> {
  const sha = createHash("sha256").update(`doc-${++docSeq}-${Math.random()}`).digest("hex");
  const r = await query<{ id: number }>(
    "INSERT dbo.documents (sha256, kind, origin, status, size_bytes, extracted) OUTPUT INSERTED.id VALUES (@s, 'statement', 'app', 'processed', 1000, @e)",
    { s: t.char(sha), e: t.str(statements ? JSON.stringify({ statements }) : null) },
  );
  return r[0].id;
}
/** Una fila de la app como la dejaría el Atajo (12:00 local del día). */
const addRow = (card: string, date: string, merchant: string, cents: number, source: "shortcut" | "email" | "manual" = "shortcut", time = "18:00:00") =>
  ingestTransaction({ merchant, amountCents: cents, cardRef: card, occurredAt: new Date(`${date}T${time}Z`) }, source, { categorizer: new RulesCategorizer(), categoryIdsByName: cats });
const txCount = async () => (await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions"))[0].n;
const txSnapshot = () => query("SELECT id, amount_cents, merchant_raw, occurred_date, card_id, source FROM dbo.transactions ORDER BY id");

beforeEach(async () => {
  await resetDb();
  cardIds = {};
  for (const n of ["Banco Oro ···111", "Plata Platino", "Plata Adicional · Ana"]) cardIds[n] = (await createCard({ name: n, issuer: n.startsWith("Banco") ? "banamex" : "amex", last4: null, aliases: null, color: "#123456" })).id;
  for (const n of ["Comisiones e intereses", "Efectivo"]) await createCategory({ name: n, color: "#123456" });
});
afterAll(closePool);

describe("mapa de tarjetas", () => {
  it("guarda y lee el mapa validado; unmappedCardKeys dice qué falta; un valor corrupto se trata como ausente", async () => {
    expect(await getStatementCardMap()).toBeNull();
    await setStatementCardMap(map);
    expect(await getStatementCardMap()).toEqual(map);
    await setStatementCardMap({ ...map, otro: { default: "X" } });
    expect(Object.keys((await getStatementCardMap())!)).toContain("otro");
    expect(unmappedCardKeys(mkDoc({ transactions: [], card_key: "zzz" }), map)).toEqual(["zzz"]);
    expect(unmappedCardKeys(mkDoc({ transactions: [] }), map)).toEqual([]);
    expect(unmappedCardKeys(mkDoc({ transactions: [] }), null)).toEqual(["banco"]);
    await query("UPDATE dbo.app_settings SET value = N'{no es json' WHERE [key] = 'statement_card_map'");
    expect(await getStatementCardMap()).toBeNull();
    await expect(setStatementCardMap({ x: { default: 5 } } as unknown as CardMap)).rejects.toThrow();
  });
});

describe("reconcileDocument", () => {
  const stmt = () => mkDoc({
    transactions: [
      tx({ date: "2026-08-20", merchant: "CAFE UNO", amount_cents: 9_500 }),
      tx({ date: "2026-08-25", merchant: "TIENDA DOS", amount_cents: 20_000 }),
      tx({ date: "2026-09-02", merchant: "ELECTRO CASA", amount_cents: 650_000 }), // falta en la app y es grande
      tx({ date: "2026-09-04", merchant: "COMISION", amount_cents: 22_712, type: "fee" }),
      tx({ date: "2026-09-05", merchant: "SU PAGO GRACIAS", amount_cents: -100_000, type: "payment" }),
      tx({ date: "2026-09-06", merchant: "MENSUALIDAD LAPTOP", amount_cents: 148_742, type: "installment", installment: { n: 12, total: 24 } }),
    ],
  });

  it("concilia, guarda corrida y hallazgos, y no modifica ningún movimiento", async () => {
    await addRow("Banco Oro ···111", "2026-08-20", "Cafe Uno", 9_500);
    await addRow("Banco Oro ···111", "2026-08-26", "Tienda Dos", 20_000); // un día después: concilia
    await addRow("Banco Oro ···111", "2026-09-08", "FANTASMA", 7_700); // no está en el estado
    const before = await txSnapshot();
    const docId = await newDoc([stmt()]);
    const res = await reconcileDocument(docId, stmt(), map, NOW);
    expect(await txSnapshot()).toEqual(before);
    expect(res.runs).toHaveLength(1);
    expect(res.runs[0]).toMatchObject({ label: "Banco Oro ···111", periodStart: "2026-08-19", periodEnd: "2026-09-18", statementCount: 4, matched: 2, trusted: true });
    expect(res.runs[0].statementCents).toBe(9_500 + 20_000 + 650_000 + 22_712);
    expect(res.runs[0].appCents).toBe(9_500 + 20_000 + 7_700);
    expect(res.highFindings).toBe(1);
    const runs = await listRuns(docId);
    expect(runs).toHaveLength(1);
    const f = runs[0].findingList;
    expect(f.map((x) => x.kind)).toEqual(["missing_in_app", "not_in_statement", "missing_in_app", "missing_in_app", "total_mismatch"]);
    expect(f[0]).toMatchObject({ severity: "high", stmtAmountCents: 650_000, stmtMerchant: "ELECTRO CASA", stmtType: "purchase", stmtDate: "2026-09-02", status: "open" });
    expect(f[0].message).toContain("$6,500.00");
    expect(f[0].detail).toMatchObject({ importable: true });
    expect(f[1]).toMatchObject({ severity: "warn", stmtAmountCents: 7_700 });
    expect(f[1].txId).not.toBeNull();
    expect(f.find((x) => x.stmtType === "payment")).toMatchObject({ severity: "info" });
    expect((await listOpenFindings())[0].severity).toBe("high");
    expect(await listOpenFindings(2)).toHaveLength(2);
  });

  it("es idempotente: correr dos veces deja los mismos hallazgos (mismas filas, sin duplicar)", async () => {
    await addRow("Banco Oro ···111", "2026-09-08", "FANTASMA", 7_700);
    const docId = await newDoc([stmt()]);
    const a = await reconcileDocument(docId, stmt(), map, NOW);
    const first = (await listRuns(docId))[0].findingList;
    const b = await reconcileDocument(docId, stmt(), map, NOW);
    const second = (await listRuns(docId))[0].findingList;
    expect(b.runs[0].runId).toBe(a.runs[0].runId);
    expect(second.map((x) => [x.id, x.fingerprint, x.status, x.message])).toEqual(first.map((x) => [x.id, x.fingerprint, x.status, x.message]));
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.recon_runs"))[0].n).toBe(1);
    expect(b.openFindings).toBe(a.openFindings);
  });

  it("conserva lo descartado/resuelto a mano; lo que deja de aplicar pasa a resuelto solo y se reabre si vuelve", async () => {
    const docId = await newDoc([stmt()]);
    await addRow("Banco Oro ···111", "2026-08-20", "Cafe Uno", 9_500);
    await reconcileDocument(docId, stmt(), map, NOW);
    let f = (await listRuns(docId))[0].findingList;
    const tienda = f.find((x) => x.stmtMerchant === "TIENDA DOS")!;
    const electro = f.find((x) => x.stmtMerchant === "ELECTRO CASA")!;
    const comision = f.find((x) => x.stmtMerchant === "COMISION")!;
    expect(await setFindingStatus(tienda.id, "dismissed")).toBe(true);
    expect(await setFindingStatus(comision.id, "resolved")).toBe(true);
    expect(await setFindingStatus(999_999, "open")).toBe(false);
    // Aparece la compra de ELECTRO en la app: ese hallazgo deja de aplicar.
    await addRow("Banco Oro ···111", "2026-09-02", "Electro Casa", 650_000);
    await reconcileDocument(docId, stmt(), map, NOW);
    f = (await listRuns(docId))[0].findingList;
    const st = (id: number) => f.find((x) => x.id === id)!;
    expect(st(tienda.id).status).toBe("dismissed"); // sigue aplicando, pero lo descartaste
    expect(st(comision.id).status).toBe("resolved");
    expect(st(electro.id).status).toBe("resolved"); // dejó de aplicar
    expect(st(electro.id).resolvedAt).not.toBeNull();
    expect(st(electro.id).detail).toMatchObject({ autoResolved: true });
    // Se borra esa fila: el hallazgo vuelve a abrirse (la resolución fue automática, no tuya).
    const id = (await query<{ id: number }>("SELECT id FROM dbo.transactions WHERE amount_cents = 650000"))[0].id;
    await deleteTransaction(id);
    await reconcileDocument(docId, stmt(), map, NOW);
    f = (await listRuns(docId))[0].findingList;
    expect(st(electro.id).status).toBe("open");
    expect(f.find((x) => x.id === electro.id)!.resolvedAt).toBeNull();
    // Una resolución manual SÍ se conserva aunque el problema siga.
    await setFindingStatus(electro.id, "resolved");
    await reconcileDocument(docId, stmt(), map, NOW);
    expect((await listRuns(docId))[0].findingList.find((x) => x.id === electro.id)!.status).toBe("resolved");
  });

  it("la misma tarjeta+periodo REEMPLAZA la corrida (otro PDF del mismo estado) sin acumular hallazgos", async () => {
    const d1 = await newDoc([stmt()]);
    const d2 = await newDoc([stmt()]);
    const a = await reconcileDocument(d1, stmt(), map, NOW);
    const b = await reconcileDocument(d2, stmt(), map, NOW);
    expect(b.runs[0].runId).toBe(a.runs[0].runId);
    expect(await listRuns(d1)).toHaveLength(0);
    const runs = await listRuns(d2);
    expect(runs).toHaveLength(1);
    expect(new Set(runs[0].findingList.map((x) => x.fingerprint)).size).toBe(runs[0].findingList.length);
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.recon_findings"))[0].n).toBe(runs[0].findingList.length);
  });

  it("varios estados del mismo documento (otra tarjeta o periodo) conviven: reconciliar uno no borra al otro", async () => {
    const s1 = stmt();
    const s2 = mkDoc({ document: "nube_stmt", card_key: "plata", period: { start: "2026-08-26", end: "2026-09-25" }, transactions: [tx({ date: "2026-09-01", merchant: "SUPER UNO", amount_cents: 30_000 })] });
    const docId = await newDoc([s1, s2]);
    await reconcileDocument(docId, s1, map, NOW);
    await reconcileDocument(docId, s2, map, NOW);
    expect((await listRuns(docId)).map((r) => r.label).sort()).toEqual(["Banco Oro ···111", "Plata Platino"]);
    await reconcileDocument(docId, s1, map, NOW);
    expect(await listRuns(docId)).toHaveLength(2);
  });

  it("un estado de Amex con adicionales genera una corrida por tarjeta destino", async () => {
    await addRow("Plata Adicional · Ana", "2026-09-02", "Super Dos", 41_000);
    const amex = mkDoc({
      document: "plata_stmt", card_key: "plata", period: { start: "2026-08-26", end: "2026-09-25" }, as_of: "2026-09-25",
      transactions: [tx({ date: "2026-09-01", merchant: "SUPER UNO", amount_cents: 30_000, holder: "TITULAR X" }), tx({ date: "2026-09-02", merchant: "SUPER DOS", amount_cents: 41_000, holder: "ANA PEREZ" })],
    });
    const docId = await newDoc([amex]);
    const res = await reconcileDocument(docId, amex, map, NOW);
    expect(res.runs.map((r) => [r.label, r.statementCount, r.matched]).sort()).toEqual([["Plata Adicional · Ana", 1, 1], ["Plata Platino", 1, 0]]);
    expect(res.openFindings).toBeGreaterThan(0);
  });

  it("no crea tarjetas: si el destino no existe, error claro y nada escrito", async () => {
    const d = mkDoc({ card_key: "nube", transactions: [tx({ date: "2026-09-01", merchant: "ROPA", amount_cents: 1_000 })] });
    const docId = await newDoc([d]);
    await expect(reconcileDocument(docId, d, map, NOW)).rejects.toThrow(/Nube Morada.*no existe/);
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.recon_runs"))[0].n).toBe(0);
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.cards WHERE name = N'Nube Morada'"))[0].n).toBe(0);
    await expect(reconcileDocument(docId, { ...d, card_key: "no_mapeada" }, map, NOW)).rejects.toThrow(/Falta/);
  });

  it("estado sin movimientos: una corrida en la tarjeta por omisión; BIGINT grande y fechas de cambio de año", async () => {
    const empty = mkDoc({ transactions: [] });
    const docId = await newDoc([empty]);
    const r = await reconcileDocument(docId, empty, map, NOW);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ statementCount: 0, appCount: 0, open: 0 });
    // Año nuevo y monto de 90 mil millones de pesos.
    const big = 9_000_000_000_000;
    await addRow("Banco Oro ···111", "2027-01-02", "Notaria", big);
    const ny = mkDoc({ period: { start: "2026-12-10", end: "2027-01-09" }, as_of: "2027-01-09", transactions: [tx({ date: "2026-12-31", merchant: "NOTARIA", amount_cents: big })] });
    const d2 = await newDoc([ny]);
    const r2 = await reconcileDocument(d2, ny, map, new Date("2027-01-20T00:00:00Z"));
    expect(r2.runs[0]).toMatchObject({ matched: 1, open: 0, statementCents: big, appCents: big });
  });

  it("texto hostil se guarda como texto plano y truncado a las columnas", async () => {
    const evil = `${"Z".repeat(400)}'; DROP TABLE dbo.transactions;-- <script>🔥`;
    const d = mkDoc({ transactions: [tx({ date: "2026-09-01", merchant: evil.slice(0, 200), amount_cents: 1_000 })] });
    const docId = await newDoc([d]);
    await reconcileDocument(docId, d, map, NOW);
    const f = (await listRuns(docId))[0].findingList.find((x) => x.kind === "missing_in_app")!;
    expect(f.stmtMerchant!.length).toBeLessThanOrEqual(200);
    expect(f.message.length).toBeLessThanOrEqual(500);
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM sys.tables WHERE name = 'transactions'"))[0].n).toBe(1);
  });

  it("detecta dos filas de fuentes distintas a minutos de diferencia (duplicado probable)", async () => {
    await addRow("Banco Oro ···111", "2026-09-17", "Starbucks", 8_800, "shortcut", "20:00:00");
    await addRow("Banco Oro ···111", "2026-09-17", "STARBUCKS", 8_800, "manual", "20:06:00");
    const d = mkDoc({ transactions: [] });
    const docId = await newDoc([d]);
    const res = await reconcileDocument(docId, d, map, NOW);
    const dup = (await listRuns(docId))[0].findingList.find((x) => x.kind === "duplicate_suspect")!;
    expect(dup).toMatchObject({ severity: "high", status: "open" });
    expect(dup.txId).not.toBeNull();
    expect(res.highFindings).toBe(1);
  });
});

describe("importMissing", () => {
  const rows = () => query<{ merchant_raw: string; cents: number; source: string; d: string; card: string }>(
    `SELECT x.merchant_raw, CAST(x.amount_cents AS float) AS cents, x.source, CONVERT(char(10), x.occurred_date, 23) AS d, c.name AS card
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id ORDER BY x.id`,
  );
  const stmt = mkDoc({
    transactions: [
      tx({ date: "2026-09-02", merchant: "ELECTRO CASA", amount_cents: 650_000 }),
      tx({ date: "2026-09-03", merchant: "LIBRERIA", amount_cents: 31_000 }),
      tx({ date: "2026-09-04", merchant: "RETIRO CAJERO", amount_cents: 250_000, type: "cash_withdrawal" }),
    ],
  });
  const ctx = async (d: StatementDoc = stmt) => {
    await setStatementCardMap(map);
    const docId = await newDoc([d]);
    await reconcileDocument(docId, d, map, NOW);
    return docId;
  };
  const categorizer = new RulesCategorizer();

  it("importa solo las compras elegidas, marca esos hallazgos como resueltos y es idempotente", async () => {
    const docId = await ctx();
    const missing = (await listRuns(docId))[0].findingList.filter((f) => f.kind === "missing_in_app");
    const libreria = missing.find((f) => f.stmtMerchant === "LIBRERIA")!;
    const rep = await importMissing(docId, { categorizer, findingIds: [libreria.id] });
    expect(rep.docs[0]).toMatchObject({ inserted: 1, existing: 0 });
    expect(await rows()).toEqual([{ merchant_raw: "LIBRERIA", cents: 31_000, source: "statement", d: "2026-09-03", card: "Banco Oro ···111" }]);
    const after = (await listRuns(docId))[0].findingList;
    expect(after.find((f) => f.id === libreria.id)!.status).toBe("resolved");
    expect(after.filter((f) => f.kind === "missing_in_app" && f.status === "open")).toHaveLength(2);
    // Repetir con el mismo hallazgo no duplica (ya no está abierto) ni falla.
    const again = await importMissing(docId, { categorizer, findingIds: [libreria.id] });
    expect(again.docs).toEqual([]);
    expect(again.warnings.join(" ")).toContain("no se importan");
    expect(await rows()).toHaveLength(1);
    // Sin ids: todas las que siguen abiertas.
    const all = await importMissing(docId, { categorizer });
    expect(all.docs[0].inserted).toBe(2);
    expect(await rows()).toHaveLength(3);
    expect((await importMissing(docId, { categorizer })).docs).toEqual([]);
    expect((await listRuns(docId))[0].findingList.filter((f) => f.kind === "missing_in_app" && f.status === "open")).toHaveLength(0);
    // Conciliar otra vez: ya cuadra.
    expect((await reconcileDocument(docId, stmt, map, NOW)).openFindings).toBe(0);
  });

  it("dryRun no escribe nada", async () => {
    const docId = await ctx();
    const before = await txCount();
    const rep = await importMissing(docId, { categorizer, dryRun: true });
    expect(rep.docs[0].inserted).toBe(3);
    expect(await txCount()).toBe(before);
    expect((await listRuns(docId))[0].findingList.filter((f) => f.status === "open").length).toBeGreaterThan(0);
  });

  it("compras idénticas legítimas: si la app tiene una de dos, importa exactamente la que falta", async () => {
    await addRow("Banco Oro ···111", "2026-09-10", "Cafe Sol", 5_000);
    const d = mkDoc({ transactions: [tx({ date: "2026-09-10", merchant: "CAFE SOL", amount_cents: 5_000 }), tx({ date: "2026-09-11", merchant: "CAFE SOL", amount_cents: 5_000 })] });
    const docId = await ctx(d);
    expect((await listRuns(docId))[0].findingList.filter((f) => f.kind === "missing_in_app")).toHaveLength(1);
    const rep = await importMissing(docId, { categorizer });
    expect(rep.docs[0].inserted).toBe(1);
    expect(await rows()).toHaveLength(2);
    expect((await reconcileDocument(docId, d, map, NOW)).openFindings).toBe(0);
  });

  it("se niega si la extracción no es confiable y no importa lo no importable (pagos, montos que no cuadran)", async () => {
    const bad = mkDoc({ transactions: stmt.transactions, checks: [{ name: "suma", ok: false }] });
    const docId = await ctx(bad);
    const rep = await importMissing(docId, { categorizer });
    expect(rep.docs).toEqual([]);
    expect(rep.warnings.join(" ")).toContain("no es confiable");
    expect(await txCount()).toBe(0);
    const withPay = mkDoc({ transactions: [tx({ date: "2026-09-05", merchant: "SU PAGO GRACIAS", amount_cents: -100_000, type: "payment" })] });
    const d2 = await ctx(withPay);
    expect((await importMissing(d2, { categorizer })).docs).toEqual([]);
    expect(await txCount()).toBe(0);
  });

  it("lee extracted.statements (varios estados) y falla claro si el documento no sirve", async () => {
    await setStatementCardMap(map);
    const s2 = mkDoc({ document: "plata_stmt", card_key: "plata", period: { start: "2026-08-26", end: "2026-09-25" }, transactions: [tx({ date: "2026-09-01", merchant: "SUPER UNO", amount_cents: 30_000 })] });
    const docId = await newDoc([stmt, s2]);
    await reconcileDocument(docId, stmt, map, NOW);
    await reconcileDocument(docId, s2, map, NOW);
    const rep = await importMissing(docId, { categorizer });
    expect(rep.docs.map((d) => d.inserted).sort()).toEqual([1, 3]);
    expect((await rows()).find((r) => r.merchant_raw === "SUPER UNO")!.card).toBe("Plata Platino");
    await expect(importMissing(987_654, { categorizer })).rejects.toThrow(/no existe/);
    await expect(importMissing(await newDoc(null), { categorizer })).rejects.toThrow(/extra/);
    const junk = (await query<{ id: number }>("INSERT dbo.documents (sha256, kind, origin, status, size_bytes, extracted) OUTPUT INSERTED.id VALUES (@s, 'statement', 'app', 'processed', 1, N'{\"statements\":[{\"x\":1}]}')", { s: t.char("e".repeat(64)) }))[0].id;
    await expect(importMissing(junk, { categorizer })).rejects.toThrow(/no es válido/);
  });
});
