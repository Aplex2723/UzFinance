import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { closePool, query } from "@/lib/db/pool";
import { reconcileStatements } from "@/lib/docs/statement-flow";
import { cardMapSchema, docSchema, type StatementDoc } from "@/lib/import/statements";
import { createCard } from "@/lib/repo/cards";
import { createDocument, getDocument } from "@/lib/repo/documents";
import { getStatementCardMap, importMissing, setStatementCardMap } from "@/lib/repo/recon";
import { ingestTransaction } from "@/lib/repo/transactions";
import { resetDb } from "../helpers";

// Todo inventado.
const stmt = (o: Partial<StatementDoc> = {}): StatementDoc =>
  docSchema.parse({
    document: "nu_stmt", card_key: "nu", period: { start: "2026-08-16", end: "2026-09-15" }, as_of: "2026-09-15", plans: [], checks: [],
    transactions: [
      { date: "2026-08-20", merchant: "TIENDA UNO", amount_cents: 120_000, type: "purchase" },
      { date: "2026-08-25", merchant: "TIENDA DOS", amount_cents: 35_050, type: "purchase" },
    ],
    ...o,
  });
let n = 0;
const makeDoc = (statements: unknown[]) => createDocument(`${(++n).toString(16).padStart(64, "a")}`, 1000, { kind: "statement", origin: "app", status: "needs_review", title: "Estado inventado", extracted: { statements } });
const wallet = (merchant: string, cents: number, card: string, at: string) =>
  ingestTransaction({ merchant, amountCents: cents, cardRef: card, occurredAt: new Date(at) }, "shortcut", { categorizer: new RulesCategorizer() });
const alerts = () => query<{ rule: string; severity: string }>("SELECT [rule], severity FROM dbo.alerts");

beforeEach(async () => {
  await resetDb();
  await createCard({ name: "Nube Morada", issuer: "nu", last4: null, aliases: null, color: "#8a05be" });
});
afterAll(closePool);

describe("conciliar un estado guardado", () => {
  it("asigna la tarjeta solo cuando es inequívoca, guarda el mapa y concilia", async () => {
    await wallet("TIENDA UNO", 120_000, "Nube Morada", "2026-08-20T18:00:00Z");
    const id = await makeDoc([stmt()]);
    const o = await reconcileStatements(id);
    expect(o).toMatchObject({ status: "processed", openFindings: 2 });
    expect(o.detail).toContain("Asigné automáticamente");
    expect(await getStatementCardMap()).toEqual({ nu: { default: "Nube Morada" } });
    expect((await getDocument(id))?.status).toBe("processed");
    // volver a conciliar es idempotente y ya no dice que asignó nada
    const again = await reconcileStatements(id);
    expect(again).toMatchObject({ status: "processed", openFindings: 2 });
    expect(again.detail).not.toContain("Asigné");
  });

  it("ambigüedad (dos tarjetas Nu) → pide el mapa y no escribe nada", async () => {
    await createCard({ name: "Nube Dorada", issuer: "nu", last4: null, aliases: null, color: "#aaa" });
    const id = await makeDoc([stmt()]);
    const o = await reconcileStatements(id);
    expect(o).toMatchObject({ status: "needs_review", needsMapping: ["nu"] });
    expect(await getStatementCardMap()).toBeNull();
    expect(await query("SELECT 1 AS x FROM dbo.recon_runs")).toHaveLength(0);
    // el usuario elige y reconcilia
    await setStatementCardMap(cardMapSchema.parse({ nu: { default: "Nube Dorada" } }));
    expect((await reconcileStatements(id)).status).toBe("processed");
  });

  it("un mapa que apunta a una tarjeta inexistente → revisión con motivo, sin escribir a medias", async () => {
    await setStatementCardMap(cardMapSchema.parse({ nu: { default: "Tarjeta Fantasma" } }));
    const o = await reconcileStatements(await makeDoc([stmt()]));
    expect(o.status).toBe("needs_review");
    expect(o.detail).toContain("No pude conciliar");
    expect(await query("SELECT 1 AS x FROM dbo.recon_runs")).toHaveLength(0);
  });

  it("un check del extractor que falla deja el documento en revisión y marca la extracción", async () => {
    const bad = stmt({ checks: [{ name: "suma de cargos", ok: false }] });
    const id = await makeDoc([bad]);
    const o = await reconcileStatements(id);
    expect(o.status).toBe("needs_review");
    expect(o.detail).toContain("no cuadran");
    // y no se puede importar nada de ese estado
    const rep = await importMissing(id, { categorizer: new RulesCategorizer() });
    expect(rep.warnings.length).toBeGreaterThan(0);
    expect(await query("SELECT 1 AS x FROM dbo.transactions")).toHaveLength(0);
  });

  it("datos extraídos dañados → failed (hay que volver a subir)", async () => {
    const id = await makeDoc([{ document: "x" }]);
    expect(await reconcileStatements(id)).toMatchObject({ status: "failed" });
    const id2 = await createDocument("b".repeat(64), 10, { kind: "statement", origin: "app", status: "needs_review", extracted: { otra: 1 } });
    expect((await reconcileStatements(id2)).status).toBe("failed");
  });

  it("diferencias graves generan una sola alerta (aunque se reconcilie varias veces) y con ≥ aviso", async () => {
    const big = stmt({ transactions: [{ date: "2026-08-20", merchant: "COMPRA GRANDE", amount_cents: 900_000, type: "purchase" }] });
    const id = await makeDoc([big]);
    await reconcileStatements(id);
    await reconcileStatements(id);
    const a = (await alerts()).filter((x) => x.rule === "statement_diff");
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe("high");
  });

  it("estado totalmente conciliado: sin alertas ni diferencias", async () => {
    await wallet("TIENDA UNO", 120_000, "Nube Morada", "2026-08-20T18:00:00Z");
    await wallet("TIENDA DOS", 35_050, "Nube Morada", "2026-08-25T18:00:00Z");
    const o = await reconcileStatements(await makeDoc([stmt()]));
    expect(o).toMatchObject({ status: "processed", openFindings: 0 });
    expect(o.detail).toContain("todo cuadra");
    expect(await alerts()).toHaveLength(0);
  });
});
