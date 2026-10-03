import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { closePool, query } from "@/lib/db/pool";
import { cardMapSchema, docSchema, importStatements, MSI_NEW_NOTE, type CardMap, type StatementDoc } from "@/lib/import/statements";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { listPlans } from "@/lib/repo/plans";
import { createRule } from "@/lib/repo/rules";
import { ingestTransaction } from "@/lib/repo/transactions";
import { resetDb } from "../helpers";

// Todo inventado: tarjetas, comercios y montos de ejemplo.
const cardMap: CardMap = cardMapSchema.parse({
  banco: { default: { name: "Banco Oro ···111", create: { issuer: "banamex", last4: "111" } }, sections: { digital: { name: "Banco Oro Virtual ···222", create: { issuer: "banamex", last4: "222" } } }, domiciliation: "Domiciliación" },
  nube: { default: { name: "Nube Morada", create: { issuer: "nu" } } },
  plata: { default: "Plata Platino", holders: { "ANA PEREZ": { name: "Plata Adicional · Ana", create: { issuer: "amex" } } } },
});

const tx = (o: Partial<StatementDoc["transactions"][number]> & { date: string; merchant: string; amount_cents: number }): StatementDoc["transactions"][number] =>
  ({ type: "purchase", holder: null, section: "regular", ...o }) as StatementDoc["transactions"][number];
const doc = (o: Partial<StatementDoc> & { document: string; card_key: string }): StatementDoc =>
  docSchema.parse({ period: { start: "2026-08-19", end: "2026-09-18" }, as_of: "2026-09-18", transactions: [], plans: [], checks: [], ...o });

const rows = () =>
  query<{ merchant_raw: string; cents: number; kind: string; card: string; cat: string | null; plan_id: number | null; d: string; notes: string | null }>(
    `SELECT x.merchant_raw, CAST(x.amount_cents AS float) AS cents, x.kind, c.name AS card, k.name AS cat, x.plan_id, CONVERT(char(10), x.occurred_date, 23) AS d, x.notes
     FROM dbo.transactions x JOIN dbo.cards c ON c.id=x.card_id LEFT JOIN dbo.categories k ON k.id=x.category_id ORDER BY x.occurred_date, x.id`,
  );
const run = (docs: StatementDoc[], dryRun = false) => importStatements(docs, cardMap, { categorizer: new RulesCategorizer(), dryRun });

beforeEach(async () => {
  await resetDb();
  await createCard({ name: "Plata Platino", issuer: "amex", last4: null, aliases: null, color: "#9ca3af" });
  await createCard({ name: "Domiciliación", issuer: "banamex", last4: null, aliases: null, color: "#6b7280" });
  for (const n of ["Comisiones e intereses", "Transferencias", "Efectivo", "Impuestos y gobierno", "Café"]) await createCategory({ name: n, color: "#123456" });
  const cafe = (await query<{ id: number }>("SELECT id FROM dbo.categories WHERE name = N'Café'"))[0].id;
  await createRule({ pattern: "CAFE", match_type: "contains", category_id: cafe, priority: 0 });
});
afterAll(closePool);

const stmt = doc({
  document: "banco_stmt", card_key: "banco",
  transactions: [
    tx({ date: "2026-08-20", merchant: "CAFE UNO", amount_cents: 9_500 }),
    tx({ date: "2026-08-21", merchant: "TIENDA DOS", amount_cents: 20_000, section: "digital", holder: "digital" }),
    tx({ date: "2026-08-22", merchant: "TIENDA DOS", amount_cents: 20_000, section: "digital", holder: "digital" }), // idéntica el mismo rango: otra compra
    tx({ date: "2026-08-23", merchant: "REEMBOLSO TIENDA", amount_cents: -5_000, type: "refund" }),
    tx({ date: "2026-08-24", merchant: "MENSUALIDAD LAPTOP", amount_cents: 148_742, type: "installment", installment: { n: 12, total: 24 } }),
    tx({ date: "2026-08-25", merchant: "SU ABONO GRACIAS", amount_cents: -1_000_00, type: "payment" }),
    tx({ date: "2026-08-31", merchant: "COMISION ADMINISTRACION", amount_cents: 22_712, type: "fee" }),
    tx({ date: "2026-09-01", merchant: "COMISION CERO", amount_cents: 0, type: "fee" }),
    tx({ date: "2026-09-02", merchant: "RETIRO CAJERO", amount_cents: 250_000, type: "cash_withdrawal" }),
    tx({ date: "2026-09-03", merchant: "TRASPASO", amount_cents: -50_000, type: "transfer_own" }),
    tx({ date: "2026-09-04", merchant: "NOMINA", amount_cents: -9_000_00, type: "income" }),
  ],
  plans: [
    // Plan viejo (12 de 24): su compra ya pasó; la fecha impresa es la de la última mensualidad.
    { merchant: "LAPTOP TIENDA", original_cents: 3_569_800, pending_cents: 1_784_896, monthly_cents: 148_742, n_current: 12, n_total: 24, rate_pct: "0.00", with_interest: false, op_date: "2026-08-19", op_date_is_latest_installment: true, kind: "purchase", holder: "titular" },
    // Compra NUEVA a MSI (mensualidad 1): nace con su monto completo.
    { merchant: "VIAJE HOTEL", original_cents: 1_009_563, pending_cents: 673_042, monthly_cents: 336_521, n_current: 1, n_total: 3, rate_pct: "0.00", with_interest: false, op_date: "2026-08-28", op_date_is_latest_installment: true, kind: "purchase", holder: "digital" },
  ],
});

describe("importStatements", () => {
  it("importa compras, comisiones, efectivo y pagos; ignora mensualidades, traspasos, ingresos y montos cero", async () => {
    const rep = await run([stmt]);
    const r = await rows();
    const by = (m: string) => r.filter((x) => x.merchant_raw === m);
    expect(by("CAFE UNO")).toMatchObject([{ cents: 9_500, card: "Banco Oro ···111", cat: "Café", kind: "expense" }]);
    expect(by("TIENDA DOS")).toHaveLength(2); // dos compras idénticas, ambas cuentan
    expect(by("TIENDA DOS")[0].card).toBe("Banco Oro Virtual ···222"); // sección digital → tarjeta digital
    expect(by("REEMBOLSO TIENDA")[0].cents).toBe(-5_000);
    expect(by("COMISION ADMINISTRACION")[0]).toMatchObject({ cat: "Comisiones e intereses", cents: 22_712 });
    expect(by("RETIRO CAJERO")[0].cat).toBe("Efectivo");
    expect(by("SU ABONO GRACIAS")[0]).toMatchObject({ kind: "card_payment", cents: 1_000_00 }); // positivo, fuera de estadísticas
    for (const gone of ["MENSUALIDAD LAPTOP", "COMISION CERO", "TRASPASO", "NOMINA"]) expect(by(gone)).toHaveLength(0);
    expect(rep.docs[0].skipped).toMatchObject({ "mensualidad MSI (va a planes)": 1, "monto cero": 1, "traspaso propio": 1, ingreso: 1 });
  });

  it("la compra nueva a MSI entra completa y ligada a su plan; el plan viejo no genera compra y deduce su fecha de inicio", async () => {
    await run([stmt]);
    const plans = await listPlans();
    expect(plans.map((p) => p.merchant).sort()).toEqual(["LAPTOP TIENDA", "VIAJE HOTEL"]);
    const laptop = plans.find((p) => p.merchant === "LAPTOP TIENDA")!;
    expect(laptop).toMatchObject({ nCurrent: 12, nTotal: 24, startedOn: "2025-09-19", startedEstimated: true, asOf: "2026-09-18", cardName: "Banco Oro ···111" });
    const viaje = plans.find((p) => p.merchant === "VIAJE HOTEL")!;
    expect(viaje).toMatchObject({ startedOn: "2026-08-28", startedEstimated: false, cardName: "Banco Oro Virtual ···222" });
    const compra = (await rows()).find((x) => x.merchant_raw === "VIAJE HOTEL")!;
    expect(compra).toMatchObject({ cents: 1_009_563, plan_id: viaje.id, d: "2026-08-28" });
    expect((await rows()).find((x) => x.merchant_raw === "LAPTOP TIENDA")).toBeUndefined();
  });

  it("es idempotente: volver a importar no duplica movimientos ni planes", async () => {
    await run([stmt]);
    const before = (await rows()).length;
    const rep = await run([stmt]);
    expect(await rows()).toHaveLength(before);
    expect(await listPlans()).toHaveLength(2);
    expect(rep.docs[0].inserted).toBe(0);
    expect(rep.docs[0].existing).toBeGreaterThan(0);
  });

  it("no duplica lo que ya llegó por Atajo/correo (misma tarjeta, monto y ±2 días), por conteo", async () => {
    // El Atajo ya registró UNA de las dos compras idénticas de 200.00 en la tarjeta digital (un día antes).
    const cats = new Map<string, number>();
    await createCard({ name: "Banco Oro Virtual ···222", issuer: "banamex", last4: "222", aliases: null, color: "#ef4444" });
    await ingestTransaction({ merchant: "TIENDA DOS WALLET", amountCents: 20_000, cardRef: "Banco Oro Virtual ···222", occurredAt: new Date("2026-08-21T01:30:00Z") }, "shortcut", { categorizer: new RulesCategorizer(), categoryIdsByName: cats });
    const rep = await run([stmt]);
    const tienda = (await rows()).filter((x) => x.cents === 20_000);
    expect(tienda).toHaveLength(2); // 1 del Atajo + 1 del estado (la otra se consumió contra el Atajo)
    expect(rep.docs[0].existing).toBe(1);
  });

  it("un pago de tarjeta que ya existe (otra tarjeta, ±5 días) no se duplica", async () => {
    const dom = (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE name = N'Domiciliación'"))[0].id;
    await query(
      `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, source, sources, dedupe_hash, kind)
       VALUES ('2026-08-27T12:00:00', '2026-08-27', 100000, 'DOMI BANCO', 'DOMI BANCO', ${dom}, 'email', 'email', REPLICATE('a', 64), 'card_payment')`,
    );
    await run([stmt]);
    expect((await rows()).filter((x) => x.kind === "card_payment")).toHaveLength(1);
  });

  it("el mismo pago visto en el estado de la tarjeta y en el del débito (misma importación) se guarda una vez", async () => {
    const cardDoc = doc({ document: "plata_stmt", card_key: "plata", transactions: [tx({ date: "2026-08-28", merchant: "GRACIAS POR SU PAGO EN LINEA", amount_cents: -4_053_669, type: "payment" })] });
    const debitDoc = doc({ document: "banco_debito", card_key: "banco", transactions: [tx({ date: "2026-08-31", merchant: "PLATA CO", amount_cents: 4_053_669, type: "domiciliation_card_payment", section: "domiciliation" })] });
    const rep = await run([cardDoc, debitDoc]);
    const pays = (await rows()).filter((x) => x.kind === "card_payment");
    expect(pays).toHaveLength(1);
    expect(rep.docs.reduce((a, d) => a + d.existing, 0)).toBe(1);
  });

  it("holders de Amex: el titular va a la tarjeta por defecto y el adicional a su propia tarjeta", async () => {
    const amex = doc({
      document: "plata_stmt", card_key: "plata", as_of: "2026-09-25", period: { start: "2026-08-26", end: "2026-09-25" },
      transactions: [tx({ date: "2026-09-01", merchant: "SUPER UNO", amount_cents: 30_000, holder: "TITULAR X" }), tx({ date: "2026-09-02", merchant: "SUPER DOS", amount_cents: 41_000, holder: "ANA PEREZ" })],
    });
    const rep = await run([amex]);
    expect(rep.cardsCreated).toEqual(["Plata Adicional · Ana"]);
    const r = await rows();
    expect(r.find((x) => x.merchant_raw === "SUPER UNO")!.card).toBe("Plata Platino");
    expect(r.find((x) => x.merchant_raw === "SUPER DOS")!.card).toBe("Plata Adicional · Ana");
  });

  it("CSV de la app: '3 MSI' es compra nueva (el monto del renglón es la mensualidad) y su plan arranca en el siguiente corte", async () => {
    const nube = doc({
      document: "nube_stmt", card_key: "nube", as_of: "2026-09-15", period: { start: "2026-08-16", end: "2026-09-15" },
      transactions: [tx({ date: "2026-09-01", merchant: "ROPA UNO", amount_cents: 10_000 })],
    });
    const csv = doc({
      document: "csv_nube", card_key: "nube", as_of: "2026-10-01", period: { start: "2026-09-17", end: "2026-10-01" },
      transactions: [
        tx({ date: "2026-09-29", time: "22:35", merchant: "Tienda A Meses", amount_cents: 29_610, note: MSI_NEW_NOTE, installment: { n: 1, total: 3 } }),
        tx({ date: "2026-09-30", time: "10:00", merchant: "Pendiente X", amount_cents: 1_500, pending: true }),
      ],
    });
    await run([nube, csv]);
    const msi = (await rows()).find((x) => x.merchant_raw === "Tienda A Meses")!;
    expect(msi).toMatchObject({ cents: 88_830, d: "2026-09-29" }); // 3 × la mensualidad de 296.10
    expect(msi.plan_id).not.toBeNull();
    expect(msi.notes).toContain("3 meses sin intereses");
    const [p] = await listPlans();
    expect(p).toMatchObject({ merchant: "Tienda A Meses", originalCents: 88_830, monthlyCents: 29_610, nTotal: 3, nCurrent: 1, asOf: "2026-10-15", startedOn: "2026-09-29" });
    expect((await rows()).find((x) => x.merchant_raw === "Pendiente X")!.notes).toBe("En proceso");
  });

  it("movimientos del periodo: '(001:003)' sin plan es una compra nueva a MSI = 3 × la mensualidad (confirmada por el abono que la convierte)", async () => {
    const mov = doc({
      document: "movements_banco", card_key: "banco", as_of: "2026-10-02", period: { start: "2026-09-19", end: "2026-10-01" },
      transactions: [
        tx({ date: "2026-09-29", merchant: "JUGUETERIA", amount_cents: 136_100, type: "installment", installment: { n: 1, total: 3 } }),
        tx({ date: "2026-09-29", merchant: "JUGUETERIA", amount_cents: -408_300, type: "installment_credit" }),
        tx({ date: "2026-09-30", merchant: "MENSUALIDAD VIEJA", amount_cents: 99_900, type: "installment", installment: { n: 13, total: 24 } }),
      ],
    });
    await run([stmt, mov]);
    const r = await rows();
    expect(r.find((x) => x.merchant_raw === "JUGUETERIA")).toMatchObject({ cents: 408_300, d: "2026-09-29" });
    expect(r.find((x) => x.merchant_raw === "MENSUALIDAD VIEJA")).toBeUndefined();
    expect((await listPlans()).find((p) => p.merchant === "JUGUETERIA")).toMatchObject({ originalCents: 408_300, monthlyCents: 136_100, asOf: "2026-10-18", nCurrent: 1 });
  });

  it("las correcciones del usuario cambian categoría y comercio de un movimiento concreto, y avisan si no coinciden", async () => {
    const d = doc({ document: "banco_stmt", card_key: "banco", transactions: [tx({ date: "2026-09-28", merchant: "Donativo", amount_cents: 2_000_000 }), tx({ date: "2026-09-29", merchant: "Donativo", amount_cents: 5_000 })] });
    const rep = await importStatements([d], cardMap, {
      categorizer: new RulesCategorizer(),
      overrides: [{ date: "2026-09-28", cents: 2_000_000, merchant_contains: "donativo", category: "Café", merchant_as: "Pago de deuda personal", note: "dinero que se debía" }, { merchant_contains: "NO EXISTE" }],
    });
    const r = await rows();
    expect(r.find((x) => x.cents === 2_000_000)).toMatchObject({ merchant_raw: "Pago de deuda personal", cat: "Café", notes: "dinero que se debía" });
    expect(r.find((x) => x.cents === 5_000)).toMatchObject({ merchant_raw: "Donativo", cat: null }); // el otro no coincide
    expect(rep.warnings.join("\n")).toContain("sin coincidencias");
  });

  it("simulación (dryRun) no escribe nada ni crea tarjetas", async () => {
    const before = await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.cards");
    const rep = await run([stmt], true);
    expect(rep.docs[0].inserted).toBeGreaterThan(5);
    expect(await rows()).toHaveLength(0);
    expect(await listPlans()).toHaveLength(0);
    expect((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.cards"))[0].n).toBe(before[0].n);
    expect(rep.cardsCreated.length).toBeGreaterThan(0);
  });

  it("rechaza un mapa que no sabe crear una tarjeta inexistente", async () => {
    const bad = cardMapSchema.parse({ banco: { default: "No Existe" } });
    await expect(importStatements([stmt], bad, { categorizer: new RulesCategorizer() })).rejects.toThrow(/no existe/);
  });
});
