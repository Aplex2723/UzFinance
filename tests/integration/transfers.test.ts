import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { closePool, query } from "@/lib/db/pool";
import type { ParsedTransfer } from "@/lib/pdf/receipts/banamex-transfer";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { ingestBankEmail } from "@/lib/repo/emails";
import { createRule } from "@/lib/repo/rules";
import { getAccountCardMap, registerTransfer, rememberAccountCard, resolveOriginCard } from "@/lib/repo/transfers";
import { resetDb } from "../helpers";

// Todo inventado: cuentas, nombres, autorizaciones y rastreos.
const base: ParsedTransfer = {
  template: "banamex_app", amountCents: 250_000, occurredAt: new Date("2026-10-04T00:50:00Z"), originLabel: "MiCuenta Banamex", originTail: "456",
  destAlias: "Casero Ejemplo", destTail: "789", destBank: "Bbva Mexico", destName: "Juan Perez Lopez", concept: "Transferencia interbancaria", reference: "4321",
  trackingKey: "012345678901234567", authCode: "414294", accountType: "Débito",
};
const tr = (o: Partial<ParsedTransfer> = {}): ParsedTransfer => ({ ...base, ...o });
let deps = { categorizer: new RulesCategorizer() };

const rows = () =>
  query<{ id: number; merchant_raw: string; cents: number; kind: string; source: string; sources: string; cat: string | null; auth_code: string | null; tracking_key: string | null; email_message_id: string | null; notes: string | null; card: string }>(
    `SELECT x.id, x.merchant_raw, CAST(x.amount_cents AS float) AS cents, x.kind, x.source, x.sources, k.name AS cat, x.auth_code, x.tracking_key, x.email_message_id, x.notes, c.name AS card
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id LEFT JOIN dbo.categories k ON k.id = x.category_id ORDER BY x.id`,
  );

const mailBody = (amount: string, when: string, auth: string) => `Se realizó la siguiente operación: Retiro / Compra
Tarjeta M.N. ***296
Monto\n${amount}\nEstablecimiento\nSPEI ENVIADO CASERO EJEMPLO\nFecha y hora\n${when}\nEstatus\nExitoso${auth ? `\nNo. Autorización\n${auth}` : ""}`;
const email = (id: string, o: { amount?: string; when?: string; auth?: string; at?: string } = {}) =>
  ingestBankEmail({
    messageId: id, from: "notificaciones@banamex.com", subject: "Retiro/Compra con cuenta Banamex", receivedAt: new Date(o.at ?? "2026-10-04T00:52:00Z"),
    bodyText: mailBody(o.amount ?? "$ 2,500.00 M.N.", o.when ?? "3 Octubre 2026 / 18:50:41", o.auth ?? "414294"),
  }, deps);

let debito = 0;
beforeEach(async () => {
  await resetDb();
  deps = { categorizer: new RulesCategorizer() }; // las reglas se leen una vez por instancia
  debito = (await createCard({ name: "Débito ···296", issuer: "banamex", last4: "296", aliases: null, color: "#38bdf8" })).id;
  await createCard({ name: "Explora Banamex ···046", issuer: "banamex", last4: "046", aliases: null, color: "#2b6fff" });
  for (const n of ["Transferencias", "Vivienda"]) await createCategory({ name: n, color: "#123456" });
});
afterAll(closePool);

describe("registro de una transferencia", () => {
  it("guarda gasto, categoría Transferencias, rastreo y autorización", async () => {
    const r = await registerTransfer(tr(), debito, deps);
    expect(r).toMatchObject({ status: "inserted", kind: "expense" });
    const [row] = await rows();
    expect(row).toMatchObject({ merchant_raw: "Transferencia a Casero Ejemplo", cents: 250_000, source: "receipt", sources: "receipt", cat: "Transferencias", auth_code: "414294", tracking_key: "012345678901234567", card: "Débito ···296" });
    expect(row.notes).toContain("Rastreo 012345678901234567");
    expect(row.notes).toContain("Juan Perez Lopez");
  });

  it("el concepto del usuario es el comercio y pasa por el categorizador", async () => {
    const vivienda = (await query<{ id: number }>("SELECT id FROM dbo.categories WHERE name = N'Vivienda'"))[0].id;
    await createRule({ pattern: "RENTA", match_type: "contains", category_id: vivienda, priority: 0 });
    await registerTransfer(tr({ concept: "Renta depa" }), debito, deps);
    expect(await rows()).toMatchObject([{ merchant_raw: "Renta depa", cat: "Vivienda" }]);
  });

  it("concepto con significado que no categoriza → Transferencias (nunca sin categoría)", async () => {
    await registerTransfer(tr({ concept: "Boleto de rifa" }), debito, deps);
    expect(await rows()).toMatchObject([{ merchant_raw: "Boleto de rifa", cat: "Transferencias" }]);
  });

  it("es idempotente por clave de rastreo (incluso en carrera)", async () => {
    const rs = await Promise.all([registerTransfer(tr(), debito, deps), registerTransfer(tr(), debito, deps), registerTransfer(tr(), debito, deps)]);
    expect(rs.filter((r) => r.status === "inserted")).toHaveLength(1);
    expect(rs.filter((r) => r.status === "duplicate")).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect((await registerTransfer(tr(), debito, deps)).status).toBe("duplicate");
  });

  it("dos transferencias iguales con distinto rastreo y horas distintas son dos gastos (no se pierden)", async () => {
    await registerTransfer(tr(), debito, deps);
    const later = await registerTransfer(tr({ trackingKey: "999999999999999999", authCode: "555555", occurredAt: new Date("2026-10-04T03:10:00Z") }), debito, deps);
    expect(later.status).toBe("inserted");
    expect(await rows()).toHaveLength(2);
  });

  it("mismo monto, tarjeta y minuto con otra clave de rastreo parece la misma transferencia mal leída: no se inserta sola", async () => {
    await registerTransfer(tr(), debito, deps);
    const twin = await registerTransfer(tr({ trackingKey: "999999999999999999", authCode: "555555" }), debito, deps);
    expect(twin.status).toBe("suspect");
    expect(await rows()).toHaveLength(1);
    // el usuario puede confirmar que sí es otra
    expect((await registerTransfer(tr({ trackingKey: "999999999999999999", authCode: "555555" }), debito, deps, { allowSuspect: true })).status).toBe("inserted");
    expect(await rows()).toHaveLength(2);
  });

  it("a una tarjeta propia (Configuración) es pago de tarjeta, fuera del gasto, sin categoría", async () => {
    // "AMERICAN EXPRESS" ya viene sembrado en own_payees (migración 004).
    const r = await registerTransfer(tr({ destAlias: "American Express", destName: "AMERICAN EXPRESS COMPANY" }), debito, deps);
    expect(r.kind).toBe("card_payment");
    expect(await rows()).toMatchObject([{ kind: "card_payment", cat: null }]);
  });

  it("monto y fecha: guarda el día local de Ciudad de México (3 oct 18:50, no 4 oct UTC)", async () => {
    await registerTransfer(tr(), debito, deps);
    const d = await query<{ d: string }>("SELECT CONVERT(char(10), occurred_date, 23) AS d FROM dbo.transactions");
    expect(d[0].d).toBe("2026-10-03");
  });

  it("correcciones del usuario al confirmar: comercio, categoría y nota", async () => {
    const vivienda = (await query<{ id: number }>("SELECT id FROM dbo.categories WHERE name = N'Vivienda'"))[0].id;
    await registerTransfer(tr(), debito, deps, { merchant: "Renta octubre", categoryId: vivienda, notes: "pagada por adelantado" });
    const [row] = await rows();
    expect(row).toMatchObject({ merchant_raw: "Renta octubre", cat: "Vivienda" });
    expect(row.notes).toMatch(/^pagada por adelantado · A Juan/);
  });
});

describe("fusión con el correo del banco", () => {
  it("correo primero, comprobante después: completa la misma fila", async () => {
    expect((await email("m1")).status).toBe("created");
    const r = await registerTransfer(tr(), debito, deps);
    expect(r.status).toBe("merged");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sources: "email,receipt", tracking_key: "012345678901234567", email_message_id: "m1", cents: 250_000 });
  });

  it("comprobante primero, correo después: el correo solo confirma (misma autorización)", async () => {
    await registerTransfer(tr(), debito, deps);
    expect((await email("m1")).status).toBe("merged");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sources: "receipt,email", email_message_id: "m1" });
    // reenviar el mismo correo no duplica
    expect((await email("m1")).status).toBe("duplicate");
    expect(await rows()).toHaveLength(1);
  });

  it("autorizaciones distintas son operaciones distintas, aunque el monto y la hora coincidan", async () => {
    await registerTransfer(tr(), debito, deps);
    expect((await email("m1", { auth: "777777", when: "3 Octubre 2026 / 18:51:00" })).status).toBe("created"); // otra autorización a 1 min
    expect(await rows()).toHaveLength(2);
  });

  it("si el correo no trae autorización, funde por monto + misma tarjeta a ≤15 min; fuera de la ventana no", async () => {
    await registerTransfer(tr(), debito, deps);
    await email("m1", { auth: "", when: "3 Octubre 2026 / 18:58:00" }); // +8 min, sin autorización
    expect(await rows()).toHaveLength(1);
    await email("m2", { auth: "", when: "3 Octubre 2026 / 19:30:00", at: "2026-10-04T01:31:00Z" }); // +40 min: otro cargo igual
    expect(await rows()).toHaveLength(2);
  });

  it("otra tarjeta con el mismo monto y hora NO se funde (compra con crédito + transferencia desde débito)", async () => {
    const explora = (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE last4='046'"))[0].id;
    // compra de $2,500.00 con la Explora registrada por el Atajo/correo, y a los 5 minutos la transferencia desde el débito
    await query("INSERT dbo.transactions (occurred_at, occurred_date, amount_cents, merchant_raw, merchant_normalized, card_id, source, sources, dedupe_hash, email_message_id, auth_code) VALUES ('2026-10-04T00:47:00', '2026-10-03', 250000, 'TIENDA', 'TIENDA', @c, 'email', 'email', REPLICATE('a', 64), 'mx', '555555')", { c: { type: (await import("mssql")).default.Int, value: explora } });
    expect((await registerTransfer(tr(), debito, deps)).status).toBe("inserted");
    expect(await rows()).toHaveLength(2);
    // y a la inversa: un comprobante ya registrado no se come el correo de una compra con otra tarjeta
    const other = await ingestBankEmail({
      messageId: "m9", from: "notificaciones@banamex.com", subject: "Retiro/Compra con tarjeta Banamex", receivedAt: new Date("2026-10-04T00:53:00Z"),
      bodyText: "Se realizó la siguiente operación: Retiro / Compra\nJUAN EJEMPLO\nEXPLORA BANAMEX**046\nMonto\n$2,500.00\nEstablecimiento\nOTRA TIENDA\nFecha y hora\n3 Octubre 2026 / 18:52:00\nEstatus\nExitoso",
    }, deps);
    expect(other.status).toBe("created");
  });

  it("un monto distinto nunca se funde", async () => {
    await registerTransfer(tr(), debito, deps);
    await email("m1", { amount: "$ 2,500.50 M.N.", auth: "111111" });
    expect(await rows()).toHaveLength(2);
  });

  it("la fila del banco manda: conserva su comercio si el concepto es el genérico", async () => {
    await email("m1");
    await registerTransfer(tr(), debito, deps);
    expect((await rows())[0].merchant_raw).toContain("SPEI ENVIADO");
  });

  it("si el usuario puso concepto, ese concepto reemplaza al del correo", async () => {
    await email("m1");
    await registerTransfer(tr({ concept: "Renta depa" }), debito, deps);
    expect((await rows())[0].merchant_raw).toBe("Renta depa");
  });
});

describe("de qué tarjeta salió", () => {
  it("la cuenta aprendida gana; luego la terminación; luego el único débito", async () => {
    // 456 no es terminación de ninguna tarjeta: cae al único débito
    expect(await resolveOriginCard(tr())).toMatchObject({ how: "único débito", card: { name: "Débito ···296" } });
    // terminación exacta
    expect(await resolveOriginCard(tr({ originTail: "046", originLabel: "Otra cuenta", accountType: "Crédito" }))).toMatchObject({ how: "terminación", card: { name: "Explora Banamex ···046" } });
    // aprendida
    const explora = (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE last4='046'"))[0].id;
    await rememberAccountCard("456", explora);
    expect(await getAccountCardMap()).toEqual({ "456": explora });
    expect(await resolveOriginCard(tr())).toMatchObject({ how: "aprendida", card: { name: "Explora Banamex ···046" } });
  });

  it("ambigua → null (el usuario elige): dos débitos, o cuenta que no es débito y sin terminación", async () => {
    await createCard({ name: "Débito segundo", issuer: "banamex", last4: "111", aliases: null, color: "#38bdf8" });
    expect(await resolveOriginCard(tr())).toBeNull();
    expect(await resolveOriginCard(tr({ originLabel: "Cuenta X", accountType: "Crédito" }))).toBeNull();
  });

  it("ignora tarjetas inactivas y las de sistema; terminación repetida no adivina", async () => {
    await createCard({ name: "Domiciliación", issuer: "banamex", last4: null, aliases: null, color: "#6b7280" });
    await createCard({ name: "Gemela ···296", issuer: "banamex", last4: "296", aliases: null, color: "#6b7280" });
    expect(await resolveOriginCard(tr({ originTail: "296" }))).toBeNull();
  });

  it("rememberAccountCard valida la terminación", async () => {
    await expect(rememberAccountCard("12", 1)).rejects.toThrow(RangeError);
    await expect(rememberAccountCard("abcd", 1)).rejects.toThrow(RangeError);
  });
});
