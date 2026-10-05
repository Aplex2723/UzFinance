import sql from "mssql";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postEmail } from "@/app/api/ingest/email/route";
import { POST as postIngest } from "@/app/api/ingest/route";
import { POST as postTx } from "@/app/api/transactions/route";
import { flushAlertWork } from "@/lib/alerts/schedule";
import { closePool, query } from "@/lib/db/pool";
import {
  createAlert, dismissAlert, evaluatePeriodicAlerts, evaluateTransactionAlerts, getAlertConfig, HOURLY_ALERT_CAP, listAlerts, markAlertRead, markAllRead,
  maybeRunPeriodicAlerts, setAlertConfig, unreadAlertCount, type AlertCandidate,
} from "@/lib/repo/alerts";
import { localDate } from "@/lib/time";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { setGoal } from "@/lib/repo/goals";
import { setMonthlyIncome } from "@/lib/repo/settings";
import { getChangeRevision, ingestTransaction } from "@/lib/repo/transactions";
import { getCategorizer } from "@/lib/categorizer";
import { emailFailures, emailPerIp, ingestFailures, ingestPerIp } from "@/lib/security/ingest-limiters";
import { A } from "../fixtures/banamex-emails";
import { authed, EMAIL_TOKEN, req, resetDb, TOKEN } from "../helpers";

// Permite probar "si la alerta falla, la ingesta sigue bien" sin tocar el código de producción.
const fail = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/repo/alerts", async (orig) => {
  const m = await orig<typeof import("@/lib/repo/alerts")>();
  return {
    ...m,
    evaluateTransactionAlerts: async (...a: Parameters<typeof m.evaluateTransactionAlerts>) => {
      if (fail.on) throw new Error("boom simulado");
      return m.evaluateTransactionAlerts(...a);
    },
  };
});

const NOW = new Date("2026-10-04T18:00:00Z"); // domingo 4 de octubre, 12:00 CDMX
const DAY = (d: string) => `${d}T18:00:00Z`;
let card: number, banamex: number, cat: number, seq = 0;

type Mk = { date?: string; at?: string; cents: number; merchant?: string; cat?: number | null; kind?: string; rec?: boolean; sources?: string; card?: number };
async function mk(o: Mk): Promise<number> {
  const date = o.date ?? "2026-10-04";
  const m = o.merchant ?? "LIVERPOOL";
  const r = await query<{ id: number }>(
    `INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, category_id, source, sources, dedupe_hash, kind, is_recurring)
     OUTPUT INSERTED.id VALUES (@at, @d, @c, @m, @m, @card, @cat, 'manual', @src, @h, @kind, @rec)`,
    {
      at: { type: sql.DateTime2, value: new Date(o.at ?? DAY(date)) },
      d: { type: sql.Date, value: new Date(`${date}T00:00:00Z`) },
      c: { type: sql.BigInt, value: o.cents }, m: { type: sql.NVarChar, value: m },
      card: { type: sql.Int, value: o.card ?? card }, cat: { type: sql.Int, value: o.cat ?? null },
      src: { type: sql.VarChar, value: o.sources ?? "manual" }, h: { type: sql.Char, value: String(++seq).padStart(64, "0") },
      kind: { type: sql.VarChar, value: o.kind ?? "expense" }, rec: { type: sql.Bit, value: !!o.rec },
    },
  );
  return Number(r[0].id);
}
const alerts = (includeDismissed = true) => listAlerts({ includeDismissed, limit: 200 });
const ev = (id: number, now = NOW) => evaluateTransactionAlerts(id, now);
const candidate = (o: Partial<AlertCandidate> = {}): AlertCandidate => ({ rule: "large_purchase", severity: "warn", title: "t", body: "b", dedupeKey: `k:${++seq}`, ...o });

beforeEach(async () => {
  fail.on = false;
  await resetDb();
  await query("DELETE FROM dbo.merged_hashes; DELETE FROM dbo.savings_goals");
  for (const l of [emailFailures, emailPerIp, ingestFailures, ingestPerIp]) l.reset();
  card = (await createCard({ name: "Tarjeta Prueba", issuer: "other", last4: null, aliases: null, color: "#f00" })).id;
  banamex = (await createCard({ name: "Banamex Oro", issuer: "banamex", last4: "4412", aliases: "Oro Visa", color: "#ef4444" })).id;
  cat = (await createCategory({ name: "Compras", color: "#0af" })).id;
});
afterAll(async () => {
  await setMonthlyIncome(35_000_000);
  await closePool();
});

describe("compra fuerte por transacción", () => {
  it("monto sobre el umbral → una alerta con título, cuerpo, severidad y vínculo a la transacción", async () => {
    const id = await mk({ cents: 6_000_00 });
    expect(await ev(id)).toBe(1);
    const [a] = await alerts();
    expect(a).toMatchObject({ rule: "large_purchase", severity: "warn", txId: id, readAt: null, dismissedAt: null, dedupeKey: `large:${id}:warn` });
    expect(a.title).toContain("$6,000.00");
    expect(a.data).toMatchObject({ cents: 6_000_00 });
  });
  it("evaluar dos veces la misma transacción = una alerta", async () => {
    const id = await mk({ cents: 6_000_00 });
    expect(await ev(id)).toBe(1);
    expect(await ev(id)).toBe(0);
    expect((await alerts()).length).toBe(1);
  });
  it("carrera: varias evaluaciones simultáneas de la misma transacción → una sola alerta", async () => {
    const id = await mk({ cents: 6_000_00 });
    const r = await Promise.all(Array.from({ length: 8 }, () => ev(id)));
    expect(r.reduce((a, b) => a + b, 0)).toBe(1);
    expect((await alerts()).length).toBe(1);
  });
  it("arranque en frío: compra común sin historial no alerta (sin NaN ni errores)", async () => {
    expect(await ev(await mk({ cents: 1_200_00 }))).toBe(0);
    expect(await ev(await mk({ cents: 4_999_99 }))).toBe(0);
    expect(await alerts()).toEqual([]);
  });
  it("relativa: 3× lo habitual del comercio con ≥5 muestras", async () => {
    for (let i = 0; i < 6; i++) await mk({ date: `2026-09-${String(10 + i).padStart(2, "0")}`, cents: 300_00, merchant: "CAFE LOCAL" });
    const id = await mk({ cents: 1_000_00, merchant: "CAFE LOCAL" });
    expect(await ev(id)).toBe(1);
    const [a] = await alerts();
    expect(a.body).toContain("veces lo habitual");
    expect(a.severity).toBe("warn");
  });
  it("la mediana también puede ser de la categoría", async () => {
    for (let i = 0; i < 6; i++) await mk({ date: `2026-09-${String(10 + i).padStart(2, "0")}`, cents: 400_00, merchant: `TIENDA ${i}`, cat });
    const id = await mk({ cents: 1_500_00, merchant: "TIENDA NUEVA", cat });
    expect(await ev(id)).toBe(1);
    expect((await alerts())[0].body).toContain("en esta categoría");
  });
  it("comercio nuevo con monto alto (hay historial) y comercio ya conocido sin alerta", async () => {
    for (let i = 0; i < 25; i++) await mk({ date: `2026-09-${String(1 + (i % 25)).padStart(2, "0")}`, cents: 150_00, merchant: `COMERCIO ${i % 5}` });
    const nuevo = await mk({ cents: 2_500_00, merchant: "JOYERIA RARA" });
    expect(await ev(nuevo)).toBe(1);
    const [a] = await alerts();
    expect(a).toMatchObject({ rule: "new_merchant_large", severity: "warn" });
    await mk({ date: "2026-09-20", cents: 2_500_00, merchant: "FERRETERIA" });
    await ev(await mk({ cents: 2_600_00, merchant: "FERRETERIA" }));
    expect((await alerts()).filter((x) => x.rule === "new_merchant_large")).toHaveLength(1); // solo la de JOYERIA RARA
  });
  it("compra fuerte en comercio nuevo con historial: una sola alerta que menciona ambas cosas", async () => {
    for (let i = 0; i < 25; i++) await mk({ date: `2026-09-${String(1 + (i % 25)).padStart(2, "0")}`, cents: 150_00, merchant: `COMERCIO ${i % 5}` });
    expect(await ev(await mk({ cents: 7_000_00, merchant: "RELOJERIA" }))).toBe(1);
    const all = await alerts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ rule: "large_purchase", severity: "high" });
    expect(all[0].body).toContain("primera vez");
  });
  it("severidad high desde 2× el umbral", async () => {
    await ev(await mk({ cents: 10_000_00 }));
    expect((await alerts())[0].severity).toBe("high");
  });
});

describe("lo que NUNCA alerta como gasto", () => {
  it("reembolsos y pagos de tarjeta", async () => {
    expect(await ev(await mk({ cents: -9_000_00, merchant: "REEMBOLSO" }))).toBe(0);
    expect(await ev(await mk({ cents: 50_000_00, merchant: "PAGO TARJETA", kind: "card_payment" }))).toBe(0);
    expect(await alerts()).toEqual([]);
  });
  it("transacción inexistente, id inválido o basura: 0 y sin lanzar", async () => {
    expect(await ev(999_999)).toBe(0);
    expect(await ev(0)).toBe(0);
    expect(await ev(NaN)).toBe(0);
    expect(await ev(-5)).toBe(0);
  });
  it("categoría silenciada (p. ej. Transferencias) y comercio silenciado", async () => {
    await setAlertConfig({ mutedCategoryIds: [cat], mutedMerchants: ["Renta Depa"] });
    expect(await ev(await mk({ cents: 20_000_00, merchant: "SPEI", cat }))).toBe(0);
    expect(await ev(await mk({ cents: 12_000_00, merchant: "PAGO RENTA DEPA 3B" }))).toBe(0);
    expect(await alerts()).toEqual([]);
    expect(await ev(await mk({ cents: 12_000_00, merchant: "OTRA COSA" }))).toBe(1);
  });
  it("regla apagada", async () => {
    await setAlertConfig({ enabled: { large_purchase: false, new_merchant_large: false } });
    expect(await ev(await mk({ cents: 20_000_00 }))).toBe(0);
  });
  it("cargo recurrente (mismo comercio y monto ±5 % el mes anterior) baja a info y no se encola en WhatsApp", async () => {
    await setAlertConfig({ whatsapp: { enabled: true } });
    await mk({ date: "2026-09-04", cents: 12_000_00, merchant: "RENTA DEPTO" });
    const id = await mk({ cents: 12_300_00, merchant: "RENTA DEPTO" });
    expect(await ev(id)).toBe(1);
    expect((await alerts())[0].severity).toBe("info");
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.alert_outbox"))[0].n)).toBe(0);
  });
  it("con la bandera is_recurring también", async () => {
    expect(await ev(await mk({ cents: 15_000_00, merchant: "DOMICILIACION", rec: true }))).toBe(1);
    expect((await alerts())[0].severity).toBe("info");
  });
});

describe("importación masiva y correos tardíos", () => {
  it("movimientos con más de 3 días de antigüedad no generan alertas (ni por transacción ni por pico)", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 40; i++) ids.push(await mk({ date: "2026-09-20", cents: 8_000_00, merchant: `IMPORTADO ${i}` }));
    let n = 0;
    for (const id of ids) n += await ev(id);
    expect(n).toBe(0);
    expect(await alerts()).toEqual([]);
  });
  it("el límite es de 3 días, con cambio de mes y febrero de 28 días", async () => {
    const a = await mk({ date: "2026-02-28", cents: 6_000_00, merchant: "A" });
    const b = await mk({ date: "2026-02-28", cents: 6_100_00, merchant: "B" });
    expect(await ev(a, new Date("2026-03-03T18:00:00Z"))).toBe(1); // 3 días
    expect(await ev(b, new Date("2026-03-04T18:00:00Z"))).toBe(0); // 4 días
  });
  it("zona horaria: 23:30 en CDMX del 28-feb ya es 1-mar en UTC y sigue siendo 'hoy' local", async () => {
    const id = await mk({ date: "2026-02-28", at: "2026-03-01T05:30:00Z", cents: 9_000_00, merchant: "CENA TARDE" });
    // 05:45Z = 23:45 del 28-feb en CDMX: el movimiento es de "hoy" y el pico del día corresponde al 28.
    expect(await ev(id, new Date("2026-03-01T05:45:00Z"))).toBe(1);
  });
});

describe("ediciones y descartes", () => {
  it("editar el monto no re-alerta salvo que cruce a un nivel mayor", async () => {
    const id = await mk({ cents: 6_000_00 });
    expect(await ev(id)).toBe(1);
    await query("UPDATE dbo.transactions SET amount_cents = 520000 WHERE id=@id", { id: { type: sql.BigInt, value: id } });
    expect(await ev(id)).toBe(0);
    await query("UPDATE dbo.transactions SET amount_cents = 1100000 WHERE id=@id", { id: { type: sql.BigInt, value: id } });
    expect(await ev(id)).toBe(1); // cruzó a "high"
    expect(await ev(id)).toBe(0);
    await query("UPDATE dbo.transactions SET amount_cents = 600000 WHERE id=@id", { id: { type: sql.BigInt, value: id } });
    expect(await ev(id)).toBe(0); // bajar no re-alerta
    expect((await alerts()).map((a) => a.severity).sort()).toEqual(["high", "warn"]);
  });
  it("una alerta descartada no reaparece con la misma clave", async () => {
    const id = await mk({ cents: 6_000_00 });
    await ev(id);
    const [a] = await alerts();
    expect(await dismissAlert(a.id)).toBe(true);
    expect(await ev(id)).toBe(0);
    expect(await alerts(false)).toEqual([]);
    expect((await alerts(true)).length).toBe(1);
  });
  it("Atajo + correo fusionados (misma fila) no duplican la alerta", async () => {
    const raw = { merchant: "TIENDA GRANDE", amountCents: 6_500_00, cardRef: "Banamex Oro", occurredAt: new Date("2026-10-04T17:00:00Z") };
    const r = await ingestTransaction(raw, "shortcut", { categorizer: await getCategorizer() });
    if (r.status !== "inserted") throw new Error("esperaba inserted");
    expect(await ev(r.id)).toBe(1);
    await query("UPDATE dbo.transactions SET sources = 'shortcut,email' WHERE id=@id", { id: { type: sql.BigInt, value: r.id } });
    expect(await ev(r.id)).toBe(0);
    expect((await alerts()).length).toBe(1);
  });
});

describe("posible duplicado", () => {
  it("misma tarjeta+monto+comercio a ≤10 min, aunque sean fuentes distintas → aviso; ninguna fila se borra", async () => {
    const a = await mk({ at: "2026-10-04T17:00:00Z", cents: 850_00, merchant: "UBER EATS" });
    const b = await mk({ at: "2026-10-04T17:07:00Z", cents: 850_00, merchant: "UBER EATS", sources: "email" });
    expect(await ev(b)).toBe(1);
    expect(await ev(a)).toBe(0); // misma pareja: misma clave
    const [x] = await alerts();
    expect(x).toMatchObject({ rule: "duplicate_suspect", severity: "warn", dedupeKey: `dup:${a}:${b}` });
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.transactions"))[0].n)).toBe(2);
  });
  it("11 min, otra tarjeta, otro monto u otro comercio → no", async () => {
    const a = await mk({ at: "2026-10-04T17:00:00Z", cents: 850_00, merchant: "UBER EATS" });
    await mk({ at: "2026-10-04T17:11:00Z", cents: 850_00, merchant: "UBER EATS" });
    await mk({ at: "2026-10-04T17:02:00Z", cents: 850_00, merchant: "UBER EATS", card: banamex });
    await mk({ at: "2026-10-04T17:02:00Z", cents: 851_00, merchant: "UBER EATS" });
    await mk({ at: "2026-10-04T17:02:00Z", cents: 850_00, merchant: "RAPPI" });
    expect(await ev(a)).toBe(0);
  });
});

describe("pico del día", () => {
  const history = async () => {
    for (let i = 1; i <= 12; i++) await mk({ date: `2026-09-${String(10 + i).padStart(2, "0")}`, cents: 500_00, merchant: `COMERCIO ${i}` });
  };
  it("gasto de hoy ≥ 3× el promedio de 30 días y ≥ mínimo → aviso (una vez)", async () => {
    await history(); // 12 × $500 / 30 = $200 por día
    await mk({ cents: 900_00, merchant: "A" });
    await mk({ cents: 900_00, merchant: "B" });
    const last = await mk({ cents: 900_00, merchant: "C" });
    expect(await ev(last)).toBe(1);
    const a = (await alerts()).find((x) => x.rule === "daily_spike")!;
    expect(a).toMatchObject({ severity: "warn", dedupeKey: "spike:2026-10-04:warn" }); // 13× el promedio pero < 2× el mínimo ($3,000)
    expect(await ev(last)).toBe(0);
    expect(await evaluatePeriodicAlerts(NOW)).toBe(0);
  });
  it("arranque en frío (sin historial): no hay pico", async () => {
    await mk({ cents: 1_500_00, merchant: "A" });
    await mk({ cents: 1_400_00, merchant: "B" });
    expect(await ev(await mk({ cents: 1_300_00, merchant: "C" }))).toBe(0);
  });
  it("lo recurrente y lo silenciado no cuentan como gasto del día", async () => {
    await history();
    await setAlertConfig({ mutedMerchants: ["renta"] });
    await mk({ cents: 8_000_00, merchant: "RENTA", rec: true });
    expect(await ev(await mk({ cents: 100_00, merchant: "CAFE" }))).toBe(0);
  });
  it("si una sola compra explica el pico y ya tiene su alerta, no se repite", async () => {
    await history();
    const big = await mk({ cents: 6_000_00, merchant: "JOYERIA" });
    expect(await ev(big)).toBe(1);
    expect((await alerts()).map((a) => a.rule)).toEqual(["large_purchase"]);
  });
});

describe("evaluación periódica", () => {
  const N12 = new Date("2026-10-12T18:00:00Z");
  it("ritmo del mes: una alerta por mes por nivel; no antes del día 5", async () => {
    await mk({ date: "2026-09-05", cents: 10_000_00, merchant: "SEPT" });
    await mk({ date: "2026-10-03", cents: 15_000_00, merchant: "OCT" });
    expect(await evaluatePeriodicAlerts(new Date("2026-10-04T18:00:00Z"))).toBe(0); // día 4
    expect(await evaluatePeriodicAlerts(N12)).toBe(1);
    const a = (await alerts())[0];
    expect(a).toMatchObject({ rule: "spending_pace", severity: "high", dedupeKey: "pace:2026-10:high" });
    expect(a.body).toContain("50%");
    expect(await evaluatePeriodicAlerts(N12)).toBe(0);
    expect(await evaluatePeriodicAlerts(new Date("2026-10-20T18:00:00Z"))).toBe(0); // mismo mes y nivel
  });
  it("ritmo: proyección contra el ingreso", async () => {
    await setMonthlyIncome(20_000_00);
    await mk({ date: "2026-10-03", cents: 15_000_00, merchant: "OCT" }); // 15,000/12 × 31 = 38,750 > ingreso
    expect(await evaluatePeriodicAlerts(N12)).toBe(1);
    const a = (await alerts())[0];
    expect(a).toMatchObject({ rule: "spending_pace", severity: "high" });
    expect(a.body).toContain("de tu ingreso");
  });
  it("sin ingreso y sin mes anterior: nada, sin NaN", async () => {
    await setMonthlyIncome(0);
    await mk({ date: "2026-10-03", cents: 15_000_00, merchant: "OCT" });
    expect(await evaluatePeriodicAlerts(N12)).toBe(0);
  });
  it("meta de ahorro: se aleja del ritmo → aviso; máximo uno por semana ISO", async () => {
    await setMonthlyIncome(20_000_00);
    await setGoal({ name: "Viaje", targetCents: 100_000_00, targetDate: "2027-04-01", savedCents: 0, savedAsOf: "2026-10-01" });
    await mk({ date: "2026-10-03", cents: 15_000_00, merchant: "OCT" });
    await evaluatePeriodicAlerts(N12); // lunes 12 → semana 42
    const g = () => alerts().then((x) => x.filter((a) => a.rule === "goal_off_track"));
    expect(await g()).toHaveLength(1);
    expect((await g())[0]).toMatchObject({ severity: "high", dedupeKey: "goal:2026-W42" });
    await evaluatePeriodicAlerts(new Date("2026-10-14T18:00:00Z"));
    expect(await g()).toHaveLength(1);
    await evaluatePeriodicAlerts(new Date("2026-10-19T18:00:00Z")); // semana 43
    expect(await g()).toHaveLength(2);
  });
  it("meta ya lograda: nada", async () => {
    await setMonthlyIncome(20_000_00);
    await setGoal({ name: "Listo", targetCents: 1_000_00, targetDate: "2027-04-01", savedCents: 1_000_00, savedAsOf: "2026-10-01" });
    await mk({ date: "2026-10-03", cents: 15_000_00, merchant: "OCT" });
    await evaluatePeriodicAlerts(N12);
    expect((await alerts()).filter((a) => a.rule === "goal_off_track")).toEqual([]);
  });
  it("sin confirmar: un resumen de compras Banamex solo-Atajo con más de 24 h", async () => {
    await mk({ date: "2026-10-02", cents: 300_00, merchant: "OXXO", sources: "shortcut", card: banamex });
    await mk({ date: "2026-10-02", cents: 400_00, merchant: "SORIANA", sources: "shortcut", card: banamex });
    await mk({ date: "2026-10-02", cents: 999_00, merchant: "OTRA TARJETA", sources: "shortcut", card }); // no es Banamex
    await mk({ date: "2026-10-02", cents: 500_00, merchant: "YA CONFIRMADA", sources: "shortcut,email", card: banamex });
    await mk({ date: "2026-10-04", at: "2026-10-04T17:00:00Z", cents: 100_00, merchant: "RECIENTE", sources: "shortcut", card: banamex }); // <24 h
    expect(await evaluatePeriodicAlerts(NOW)).toBe(1);
    const a = (await alerts())[0];
    expect(a).toMatchObject({ rule: "unconfirmed", severity: "info" });
    expect(a.title).toBe("2 compras sin confirmar por el banco");
    expect(await evaluatePeriodicAlerts(NOW)).toBe(0);
  });
  it("maybeRunPeriodicAlerts: estrangulado a 15 min", async () => {
    await mk({ date: "2026-10-02", cents: 300_00, merchant: "OXXO", sources: "shortcut", card: banamex });
    await maybeRunPeriodicAlerts(NOW);
    expect((await alerts()).length).toBe(1);
    await query("DELETE FROM dbo.alerts");
    await maybeRunPeriodicAlerts(new Date(NOW.getTime() + 14 * 60_000));
    expect((await alerts()).length).toBe(0); // todavía no
    await maybeRunPeriodicAlerts(new Date(NOW.getTime() + 15 * 60_000));
    expect((await alerts()).length).toBe(1);
    const v = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key]='alerts_last_run'");
    expect(v).toHaveLength(1);
    expect(Number(v[0].value)).toBe(NOW.getTime() + 15 * 60_000);
  });
  it("maybeRunPeriodicAlerts: llamadas simultáneas no lanzan ni duplican", async () => {
    await mk({ date: "2026-10-02", cents: 300_00, merchant: "OXXO", sources: "shortcut", card: banamex });
    await Promise.all(Array.from({ length: 10 }, () => maybeRunPeriodicAlerts(NOW)));
    expect((await alerts()).length).toBe(1);
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.app_settings WHERE [key]='alerts_last_run'"))[0].n)).toBe(1);
  });
  it("maybeRunPeriodicAlerts: un valor corrupto en alerts_last_run no bloquea", async () => {
    await query("INSERT dbo.app_settings ([key], value) VALUES ('alerts_last_run', 'basura')");
    await mk({ date: "2026-10-02", cents: 300_00, merchant: "OXXO", sources: "shortcut", card: banamex });
    await maybeRunPeriodicAlerts(NOW);
    expect((await alerts()).length).toBe(1);
  });
  it("reglas periódicas apagadas no corren", async () => {
    await setAlertConfig({ enabled: { unconfirmed: false, spending_pace: false, goal_off_track: false, daily_spike: false } });
    await mk({ date: "2026-10-02", cents: 300_00, merchant: "OXXO", sources: "shortcut", card: banamex });
    expect(await evaluatePeriodicAlerts(NOW)).toBe(0);
  });
});

describe("createAlert", () => {
  it("idempotente por dedupe_key", async () => {
    const c = candidate();
    const a = await createAlert(c);
    expect(a.created).toBe(true);
    expect(typeof a.id).toBe("number");
    expect(await createAlert(c)).toEqual({ created: false });
    expect((await alerts()).length).toBe(1);
  });
  it("carrera de dos inserciones con la misma clave: una crea, la otra 'ya existe' (sin lanzar)", async () => {
    const c = candidate();
    const r = await Promise.all(Array.from({ length: 6 }, () => createAlert(c)));
    expect(r.filter((x) => x.created)).toHaveLength(1);
  });
  it("una descartada con la misma clave no reaparece", async () => {
    const c = candidate();
    const { id } = await createAlert(c);
    await dismissAlert(id!);
    expect((await createAlert(c)).created).toBe(false);
    expect(await alerts(false)).toEqual([]);
  });
  it("texto hostil: texto plano, título ≤120, cuerpo ≤500, sin controles, emoji enteros", async () => {
    const { id } = await createAlert(candidate({ title: `<img src=x onerror=alert(1)>\u0000\n${"T".repeat(400)}`, body: `${"😀".repeat(900)}‮`, data: { x: "'; DROP TABLE alerts;--" } }));
    const a = (await alerts()).find((x) => x.id === id)!;
    expect(a.title.length).toBeLessThanOrEqual(120);
    expect(a.body.length).toBeLessThanOrEqual(500);
    expect(a.title.startsWith("<img src=x onerror=alert(1)>")).toBe(true);
    expect(a.title).not.toMatch(/[\u0000\n‮]/);
    expect(a.body).not.toMatch(/[‮�]/);
    expect(a.data).toEqual({ x: "'; DROP TABLE alerts;--" });
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.alerts"))[0].n)).toBe(1);
  });
  it("clave de más de 120 caracteres: se acorta de forma determinística", async () => {
    const key = `k:${"x".repeat(300)}`;
    expect((await createAlert(candidate({ dedupeKey: key }))).created).toBe(true);
    expect((await createAlert(candidate({ dedupeKey: key }))).created).toBe(false);
    expect((await alerts())[0].dedupeKey.length).toBeLessThanOrEqual(120);
  });
  it("datos inválidos: regla o severidad desconocidas y clave vacía lanzan RangeError", async () => {
    await expect(createAlert(candidate({ rule: "Mala Regla!" }))).rejects.toThrow(RangeError);
    await expect(createAlert(candidate({ severity: "urgente" as never }))).rejects.toThrow(RangeError);
    await expect(createAlert(candidate({ dedupeKey: "  " }))).rejects.toThrow(RangeError);
  });
  it("regla apagada, transacción inexistente o silenciada: no crea", async () => {
    await setAlertConfig({ enabled: { statement_diff: false }, mutedMerchants: ["silenciado"] });
    expect((await createAlert(candidate({ rule: "statement_diff" }))).created).toBe(false);
    expect((await createAlert(candidate({ txId: 987_654 }))).created).toBe(false);
    const tx = await mk({ cents: 100_00, merchant: "COMERCIO SILENCIADO" });
    expect((await createAlert(candidate({ txId: tx }))).created).toBe(false);
    const ok = await mk({ cents: 100_00, merchant: "OTRO" });
    expect((await createAlert(candidate({ txId: ok }))).created).toBe(true);
  });
  it("vincula documento (statement_diff) y respeta la FK", async () => {
    const d = await query<{ id: number }>("INSERT dbo.documents (sha256, kind, origin, status, size_bytes) OUTPUT INSERTED.id VALUES (REPLICATE('a',64), 'statement', 'app', 'processed', 10)");
    const r = await createAlert(candidate({ rule: "statement_diff", documentId: Number(d[0].id) }));
    expect(r.created).toBe(true);
    expect((await alerts())[0].documentId).toBe(Number(d[0].id));
  });
  it("borrar la transacción deja la alerta (tx_id queda en null)", async () => {
    const tx = await mk({ cents: 6_000_00 });
    await ev(tx);
    await query("DELETE dbo.transactions WHERE id=@id", { id: { type: sql.BigInt, value: tx } });
    expect((await alerts())[0].txId).toBeNull();
  });
});

describe("cola de WhatsApp (alert_outbox)", () => {
  const outbox = () => query<{ alert_id: number; channel: string; status: string; attempts: number }>("SELECT alert_id, channel, status, attempts FROM dbo.alert_outbox");
  it("apagado por defecto: no se encola nada", async () => {
    await createAlert(candidate({ severity: "high" }));
    expect(await outbox()).toEqual([]);
  });
  it("encendido: encola solo severidad ≥ minSeverity, en estado pending", async () => {
    await setAlertConfig({ whatsapp: { enabled: true, minSeverity: "warn" } });
    await createAlert(candidate({ severity: "info" }));
    const w = await createAlert(candidate({ severity: "warn" }));
    const h = await createAlert(candidate({ severity: "high" }));
    const rows = await outbox();
    expect(rows.map((r) => Number(r.alert_id)).sort()).toEqual([w.id, h.id].sort());
    expect(rows.every((r) => r.channel === "whatsapp" && r.status === "pending" && r.attempts === 0)).toBe(true);
  });
  it("minSeverity high filtra warn", async () => {
    await setAlertConfig({ whatsapp: { enabled: true, minSeverity: "high" } });
    await createAlert(candidate({ severity: "warn" }));
    expect(await outbox()).toEqual([]);
    await createAlert(candidate({ severity: "high" }));
    expect(await outbox()).toHaveLength(1);
  });
  it("idempotente: repetir la alerta no duplica la fila; UNIQUE(alert_id, channel)", async () => {
    await setAlertConfig({ whatsapp: { enabled: true } });
    const c = candidate({ severity: "high" });
    const { id } = await createAlert(c);
    await createAlert(c);
    expect(await outbox()).toHaveLength(1);
    await expect(query("INSERT dbo.alert_outbox (alert_id, channel) VALUES (@id, 'whatsapp')", { id: { type: sql.BigInt, value: id! } })).rejects.toThrow();
  });
  it("una compra fuerte real se encola; la evaluación repetida no duplica", async () => {
    await setAlertConfig({ whatsapp: { enabled: true } });
    const id = await mk({ cents: 6_000_00 });
    await ev(id);
    await ev(id);
    expect(await outbox()).toHaveLength(1);
  });
});

describe("estado: leer, descartar, contar", () => {
  it("unreadAlertCount / markAlertRead / markAllRead / dismissAlert", async () => {
    const ids = [(await createAlert(candidate())).id!, (await createAlert(candidate())).id!, (await createAlert(candidate())).id!];
    expect(await unreadAlertCount()).toBe(3);
    expect(await markAlertRead(ids[0])).toBe(true);
    expect(await markAlertRead(ids[0])).toBe(true); // idempotente
    expect(await markAlertRead(123_456)).toBe(false);
    expect(await unreadAlertCount()).toBe(2);
    expect(await dismissAlert(ids[1])).toBe(true);
    expect(await dismissAlert(123_456)).toBe(false);
    expect(await unreadAlertCount()).toBe(1);
    expect(await markAllRead()).toBe(1);
    expect(await markAllRead()).toBe(0);
    expect(await unreadAlertCount()).toBe(0);
    expect(await markAlertRead(NaN)).toBe(false);
    expect(await dismissAlert(-1)).toBe(false);
  });
  it("listAlerts: más recientes primero, sin descartadas por defecto, con límite", async () => {
    const a = (await createAlert(candidate({ title: "primera" }))).id!;
    await createAlert(candidate({ title: "segunda" }));
    await dismissAlert(a);
    expect((await listAlerts()).map((x) => x.title)).toEqual(["segunda"]);
    expect((await listAlerts({ includeDismissed: true })).map((x) => x.title)).toEqual(["segunda", "primera"]);
    expect(await listAlerts({ includeDismissed: true, limit: 1 })).toHaveLength(1);
    expect((await listAlerts({ limit: 0 })).length).toBeGreaterThanOrEqual(0);
    const row = (await listAlerts({ includeDismissed: true }))[1];
    expect(row.dismissedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(row.readAt).not.toBeNull();
  });
});

describe("configuración", () => {
  it("sin nada guardado: valores por defecto", async () => {
    const c = await getAlertConfig();
    expect(c.largePurchaseCents).toBe(500_000);
    expect(c.whatsapp.enabled).toBe(false);
  });
  it("round trip y parche parcial", async () => {
    await setAlertConfig({ largePurchaseCents: 800_000 });
    const c = await setAlertConfig({ mutedMerchants: ["Spei"], enabled: { daily_spike: false } });
    expect(c).toMatchObject({ largePurchaseCents: 800_000, mutedMerchants: ["SPEI"] });
    expect(await getAlertConfig()).toEqual(c);
  });
  it("un parche inválido lanza y no cambia lo guardado", async () => {
    await setAlertConfig({ largePurchaseCents: 800_000 });
    await expect(setAlertConfig({ largePurchaseCents: -1 })).rejects.toThrow();
    await expect(setAlertConfig({ nope: 1 })).rejects.toThrow();
    expect((await getAlertConfig()).largePurchaseCents).toBe(800_000);
  });
  it.each([["JSON roto", "{no es json"], ["tipos equivocados", '{"largePurchaseCents":"mucho","enabled":7,"whatsapp":null}'], ["arreglo", "[1,2]"], ["vacío", ""]])(
    "configuración corrupta (%s) cae a defaults y las alertas siguen funcionando",
    async (_n, raw) => {
      await query("INSERT dbo.app_settings ([key], value) VALUES ('alerts_config', @v)", { v: { type: sql.NVarChar, value: raw } });
      const c = await getAlertConfig();
      expect(c.largePurchaseCents).toBe(500_000);
      expect(c.enabled.large_purchase).toBe(true);
      expect(await ev(await mk({ cents: 6_000_00 }))).toBe(1);
    },
  );
});

describe("tope de alertas", () => {
  it(`las evaluaciones automáticas no pasan de ${HOURLY_ALERT_CAP} por hora`, async () => {
    let created = 0;
    for (let i = 0; i < HOURLY_ALERT_CAP + 6; i++) created += await ev(await mk({ cents: 6_000_00 + i, merchant: `TIENDA ${i}` }));
    expect(created).toBe(HOURLY_ALERT_CAP);
    expect((await alerts()).length).toBe(HOURLY_ALERT_CAP);
  });
});

describe("huella de cambios (getChangeRevision)", () => {
  it("cambia al llegar una alerta, al leerla y al descartarla; ignora alerts_last_run", async () => {
    const r0 = await getChangeRevision();
    const { id } = await createAlert(candidate());
    const r1 = await getChangeRevision();
    expect(r1).not.toBe(r0);
    await markAlertRead(id!);
    const r2 = await getChangeRevision();
    expect(r2).not.toBe(r1);
    await maybeRunPeriodicAlerts(NOW);
    await query("UPDATE dbo.app_settings SET value='1' WHERE [key]='alerts_last_run'");
    const r3 = await getChangeRevision();
    await query("UPDATE dbo.app_settings SET value='2' WHERE [key]='alerts_last_run'");
    expect(await getChangeRevision()).toBe(r3);
  });
  it("cambia con documentos y con hallazgos de conciliación abiertos", async () => {
    const r0 = await getChangeRevision();
    const d = await query<{ id: number }>("INSERT dbo.documents (sha256, kind, origin, status, size_bytes) OUTPUT INSERTED.id VALUES (REPLICATE('b',64), 'statement', 'app', 'processed', 10)");
    const r1 = await getChangeRevision();
    expect(r1).not.toBe(r0);
    await query("UPDATE dbo.documents SET status='needs_review', updated_at = DATEADD(second, 5, updated_at)");
    const r2 = await getChangeRevision();
    expect(r2).not.toBe(r1);
    const run = await query<{ id: number }>(
      "INSERT dbo.recon_runs (document_id, label, period_start, period_end, statement_cents, app_cents, statement_count, app_count, matched) OUTPUT INSERTED.id VALUES (@d, 'x', '2026-09-01', '2026-09-30', 1, 1, 1, 1, 1)",
      { d: { type: sql.Int, value: Number(d[0].id) } },
    );
    await query("INSERT dbo.recon_findings (run_id, fingerprint, kind, severity, message) VALUES (@r, 'f1', 'missing_in_app', 'warn', 'm')", { r: { type: sql.Int, value: Number(run[0].id) } });
    const r3 = await getChangeRevision();
    expect(r3).not.toBe(r2);
    await query("UPDATE dbo.recon_findings SET status='resolved'");
    expect(await getChangeRevision()).not.toBe(r3);
  });
});

describe("hooks de ingesta", () => {
  let n = 0;
  const ip = () => ({ "x-forwarded-for": `198.51.100.${++n % 250}:4000` });
  const shortcut = (body: unknown) => postIngest(req("/api/ingest", { method: "POST", body, headers: { ...ip(), authorization: `Bearer ${TOKEN}` } }));
  const big = () => ({ merchant: "TIENDA GRANDE", amount: "$6,500.00", card: "Banamex Oro", date: new Date().toISOString() });

  it("/api/ingest responde igual y una compra fuerte genera su alerta", async () => {
    const res = await shortcut(big());
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ status: "inserted", id: expect.any(Number), cardMatched: true });
    await flushAlertWork();
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ rule: "large_purchase", txId: j.id });
  });
  it("un duplicado no vuelve a alertar y la respuesta no cambia", async () => {
    const body = big();
    await shortcut(body);
    await flushAlertWork();
    const res = await shortcut(body);
    expect(await res.json()).toEqual({ status: "duplicate", cardMatched: true });
    await flushAlertWork();
    expect(await alerts()).toHaveLength(1);
  });
  it("compra normal: ingesta igual y cero alertas", async () => {
    const res = await shortcut({ ...big(), amount: "$85.50" });
    expect(res.status).toBe(200);
    await flushAlertWork();
    expect(await alerts()).toEqual([]);
  });
  it("si la alerta falla, la ingesta responde exactamente igual y la transacción queda guardada", async () => {
    fail.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await shortcut(big());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "inserted", id: expect.any(Number), cardMatched: true });
      await flushAlertWork();
      expect(Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.transactions"))[0].n)).toBe(1);
      expect(await alerts()).toEqual([]);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });
  it("si la base de alertas está rota, evaluateTransactionAlerts devuelve 0 sin lanzar", async () => {
    await query("EXEC sp_rename 'dbo.alerts', 'alerts_x'");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const id = await mk({ cents: 6_000_00 });
      expect(await ev(id)).toBe(0);
      expect(await evaluatePeriodicAlerts(NOW)).toBe(0);
      await maybeRunPeriodicAlerts(new Date(NOW.getTime() + 3_600_000));
    } finally {
      await query("EXEC sp_rename 'dbo.alerts_x', 'alerts'");
      errors.mockRestore();
    }
  });
  it("POST /api/transactions (manual): 201 igual y alerta de compra fuerte", async () => {
    const res = await postTx(req("/api/transactions", { method: "POST", body: { date: new Date().toISOString(), amount: "7000", merchant: "MUEBLERIA", card_id: card, category_id: null, notes: null }, headers: authed() }), { params: Promise.resolve({}) });
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j).toMatchObject({ status: "inserted" });
    await flushAlertWork();
    expect((await alerts())[0]).toMatchObject({ rule: "large_purchase", txId: j.id });
  });
  it("POST /api/transactions: un duplicado 409 no genera nada y fallar la alerta no cambia el 201", async () => {
    fail.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = { date: new Date().toISOString(), amount: "7000", merchant: "MUEBLERIA", card_id: card, category_id: null, notes: null };
      const r1 = await postTx(req("/api/transactions", { method: "POST", body, headers: authed() }), { params: Promise.resolve({}) });
      expect(r1.status).toBe(201);
      const r2 = await postTx(req("/api/transactions", { method: "POST", body, headers: authed() }), { params: Promise.resolve({}) });
      expect(r2.status).toBe(409);
      await flushAlertWork();
    } finally {
      errors.mockRestore();
    }
  });
  it("/api/ingest/email: el correo se registra igual y una compra fuerte reciente genera su alerta", async () => {
    const [y, m, d] = localDate(new Date()).split("-").map(Number);
    const mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][m - 1];
    const bodyText = A.body.replace("1 oct 2026, 12:44 h.", `${d} ${mon} ${y}, 12:44 h.`).replace("2026/10/1 12:44:22 PM", `${y}/${m}/${d} 12:44:22 PM`).replace("$1,423.58", "$9,423.58");
    const body = { messageId: "msg-alert-1", from: "notificaciones@banamex.com", subject: A.subject, receivedAt: new Date().toISOString(), bodyText };
    const res = await postEmail(req("/api/ingest/email", { method: "POST", body, headers: { ...ip(), authorization: `Bearer ${EMAIL_TOKEN}` } }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ status: "created", id: expect.any(Number) });
    await flushAlertWork();
    const a = await alerts();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ rule: "large_purchase", severity: "warn", txId: j.id });
    // Reenviar el mismo correo: duplicate, sin alertas nuevas.
    expect(await (await postEmail(req("/api/ingest/email", { method: "POST", body, headers: { ...ip(), authorization: `Bearer ${EMAIL_TOKEN}` } }))).json()).toEqual({ status: "duplicate" });
    await flushAlertWork();
    expect(await alerts()).toHaveLength(1);
  });
  it("/api/ingest/email: si la alerta falla, el correo igual se registra", async () => {
    fail.on = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const [y, m, d] = localDate(new Date()).split("-").map(Number);
      const mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][m - 1];
      const bodyText = A.body.replace("1 oct 2026, 12:44 h.", `${d} ${mon} ${y}, 12:44 h.`).replace("2026/10/1 12:44:22 PM", `${y}/${m}/${d} 12:44:22 PM`).replace("$1,423.58", "$9,423.58");
      const res = await postEmail(req("/api/ingest/email", { method: "POST", body: { messageId: "msg-alert-2", from: "notificaciones@banamex.com", subject: A.subject, receivedAt: new Date().toISOString(), bodyText }, headers: { ...ip(), authorization: `Bearer ${EMAIL_TOKEN}` } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "created" });
      await flushAlertWork();
      expect(await alerts()).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
