import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as ingestEmail } from "@/app/api/ingest/email/route";
import { POST as ingestShortcut } from "@/app/api/ingest/route";
import { GET as listTx } from "@/app/api/transactions/route";
import { DELETE as dismiss } from "@/app/api/unparsed/[id]/route";
import { createCard } from "@/lib/repo/cards";
import { createPayee, deletePayee, listPayees } from "@/lib/repo/payees";
import { createCategory } from "@/lib/repo/categories";
import { createRule } from "@/lib/repo/rules";
import { listUnparsed } from "@/lib/repo/emails";
import { getOverview, getCategoryBreakdown } from "@/lib/repo/stats";
import { closePool, query } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import { emailFailures, emailPerIp, ingestFailures, ingestPerIp } from "@/lib/security/ingest-limiters";
import { A, AP, B, C, D, E } from "../fixtures/banamex-emails";
import { authed, ctx, EMAIL_TOKEN, req, resetDb, TOKEN } from "../helpers";

let n = 0;
const ip = () => ({ "x-forwarded-for": `203.0.113.${++n % 250}:4000` });
const bearer = { authorization: `Bearer ${EMAIL_TOKEN}` };
const FROM = "notificaciones@banamex.com";

type Fx = { subject: string; body: string; receivedAt: Date };
const mail = (f: Fx, id: string, over: Record<string, unknown> = {}) => ({
  messageId: id, from: FROM, subject: f.subject, receivedAt: f.receivedAt.toISOString(), bodyText: f.body, ...over,
});
const postMail = (body: unknown, headers: Record<string, string> = bearer, raw?: string) =>
  ingestEmail(req("/api/ingest/email", { method: "POST", body, raw, headers: { ...ip(), ...headers } }));
const send = async (f: Fx, id: string, over: Record<string, unknown> = {}) => {
  const res = await postMail(mail(f, id, over));
  return { res, json: (await res.json()) as Record<string, unknown> };
};
const wallet = (merchant: string, amount: string, card: string, date: string) =>
  ingestShortcut(req("/api/ingest", { method: "POST", body: { merchant, amount, card, date }, headers: { ...ip(), authorization: `Bearer ${TOKEN}` } }));

const rows = () => query<Record<string, unknown>>("SELECT * FROM dbo.transactions ORDER BY id");
const count = async () => (await rows()).length;

beforeEach(async () => {
  await resetDb();
  await query("DELETE FROM dbo.merged_hashes");
  for (const l of [emailFailures, emailPerIp, ingestFailures, ingestPerIp]) l.reset();
});
afterAll(closePool);

describe("autenticación del endpoint de correo", () => {
  it("sin token → 401 y no escribe", async () => {
    const res = await postMail(mail(A, "msg-1"), {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await count()).toBe(0);
  });
  it.each([["incorrecto", "Bearer " + "x".repeat(48)], ["esquema", `Basic ${EMAIL_TOKEN}`], ["casi correcto", `Bearer ${EMAIL_TOKEN}0`]])("token %s → 401", async (_n, h) => {
    expect((await postMail(mail(A, "msg-1"), { authorization: h })).status).toBe(401);
  });
  it("el token del Atajo NO sirve aquí y el del correo NO sirve en /api/ingest", async () => {
    expect((await postMail(mail(A, "msg-1"), { authorization: `Bearer ${TOKEN}` })).status).toBe(401);
    const r = await ingestShortcut(req("/api/ingest", { method: "POST", body: { merchant: "X", amount: "1", card: "c" }, headers: { ...ip(), ...bearer } }));
    expect(r.status).toBe(401);
  });
  it("la sesión de Easy Auth no sustituye al token", async () => {
    expect((await postMail(mail(A, "msg-1"), authed())).status).toBe(401);
  });
  it("acepta varios tokens con nombre (revocables por separado)", async () => {
    expect((await postMail(mail(A, "msg-1"), { authorization: "Bearer old-email-token-0123456789-abcdefghijklmnopqrstuvwx" })).status).toBe(200);
    expect((await postMail(mail(A, "msg-1"), bearer)).status).toBe(200);
  });
  it("sin EMAIL_INGEST_TOKENS configurado falla cerrado", async () => {
    const saved = process.env.EMAIL_INGEST_TOKENS;
    delete process.env.EMAIL_INGEST_TOKENS;
    resetEnvCache();
    try {
      expect((await postMail(mail(A, "msg-1"), bearer)).status).toBe(401);
      expect((await postMail(mail(A, "msg-1"), { authorization: "Bearer " })).status).toBe(401);
    } finally {
      process.env.EMAIL_INGEST_TOKENS = saved;
      resetEnvCache();
    }
  });
  it("10 tokens inválidos desde una IP → 429 aun con el token correcto", async () => {
    const same = { "x-forwarded-for": "198.51.100.77:1" };
    for (let i = 0; i < 10; i++) {
      await ingestEmail(req("/api/ingest/email", { method: "POST", body: mail(A, "msg-x"), headers: { ...same, authorization: `Bearer ${"y".repeat(40)}` } }));
    }
    const res = await ingestEmail(req("/api/ingest/email", { method: "POST", body: mail(A, "msg-x"), headers: { ...same, ...bearer } }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("validación", () => {
  it("remitente falso → 403, sin escribir", async () => {
    for (const from of ["fraude@banamex-seguridad.com", "marketingdir@email.banamex.com", "notificaciones@banamex.com.evil.io", "estadosdecuenta@banamex.com"]) {
      expect((await send(A, "msg-1", { from })).res.status).toBe(403);
    }
    expect(await count()).toBe(0);
  });
  it("el remitente no distingue mayúsculas", async () => expect((await send(A, "msg-1", { from: "Notificaciones@Banamex.com" })).res.status).toBe(200));
  it.each([
    ["falta messageId", { messageId: undefined }],
    ["messageId con caracteres raros", { messageId: "a b;DROP" }],
    ["fecha inválida", { receivedAt: "ayer" }],
    ["clave extra", { extra: 1 }],
    ["bodyText no es texto", { bodyText: 5 }],
  ])("%s → 400", async (_n, over) => expect((await send(A, "msg-1", over)).res.status).toBe(400));
  it("JSON malformado → 400; Content-Type distinto → 415; cuerpo > 64 KB → 413", async () => {
    expect((await postMail(undefined, bearer, "{no json")).status).toBe(400);
    expect((await postMail(undefined, { ...bearer, "content-type": "text/plain" }, "x")).status).toBe(415);
    expect((await postMail(mail(A, "msg-1", { bodyText: "x".repeat(70_000) }))).status).toBe(413);
  });
  it("X-Dry-Run no escribe y reporta el parseo sin datos del correo", async () => {
    const res = await postMail(mail(A, "msg-1"), { ...bearer, "x-dry-run": "1" });
    expect(await res.json()).toEqual({ status: "parsed", kind: "expense", type: "A", dryRun: true });
    expect(await count()).toBe(0);
  });
});

describe("compra con Apple Pay (correo sin nombre de producto)", () => {
  it("se asigna a la tarjeta Banamex propia con esos dígitos, sin crear otra", async () => {
    expect((await send(A, "msg-ap-base")).res.status).toBe(200); // crea "Explora Banamex ···000" por producto + dígitos
    const cards = async () => Number((await query<{ n: number }>("SELECT COUNT(*) n FROM dbo.cards"))[0].n);
    const before = await cards();
    const { json } = await send(AP, "msg-ap-pay");
    expect(json).toMatchObject({ status: "created", cardCreated: false });
    expect(await cards()).toBe(before);
    const r = await query<{ name: string; amount_cents: string }>("SELECT c.name, x.amount_cents FROM dbo.transactions x JOIN dbo.cards c ON c.id=x.card_id WHERE x.auth_code='000009'");
    expect(r).toEqual([{ name: expect.stringContaining("Explora Banamex"), amount_cents: "3900" }]);
  });
});

describe("crear, duplicar e ignorar", () => {
  it("crea la compra A y la tarjeta queda 'sin nombrar'", async () => {
    const { res, json } = await send(A, "msg-A");
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ status: "created", cardCreated: true });
    const [t] = await rows();
    expect(t).toMatchObject({ kind: "expense", source: "email", sources: "email", amount_cents: "142358", auth_code: "000000", email_message_id: "msg-A", is_recurring: false });
    expect(t.merchant_normalized).toBe("FERRETERIA EJEMPLO SA");
    const [card] = await query<Record<string, unknown>>("SELECT * FROM dbo.cards");
    expect(card).toMatchObject({ issuer: "banamex", last4: "000", needs_name: true, bank_key: "EXPLORA-BANAMEX|TIT|000" });
  });
  it("reenviar el mismo correo N veces no duplica", async () => {
    await send(A, "msg-A");
    for (let i = 0; i < 4; i++) expect((await send(A, "msg-A")).json).toEqual({ status: "duplicate" });
    expect(await count()).toBe(1);
  });
  it("mismo evento con otro messageId (misma autorización+monto+día) → duplicate", async () => {
    await send(A, "msg-A1");
    expect((await send(A, "msg-A2")).json).toEqual({ status: "duplicate" });
    expect(await count()).toBe(1);
  });
  it("tarjeta adicional es otra tarjeta (misma cuenta) y débito otra más", async () => {
    await send(A, "msg-A");
    await send(B, "msg-B");
    await send(C, "msg-C");
    const keys = (await query<{ bank_key: string }>("SELECT bank_key FROM dbo.cards ORDER BY bank_key")).map((c) => c.bank_key);
    expect(keys).toEqual(["DEBITO|TIT|000", "EXPLORA-BANAMEX|ADIC|000", "EXPLORA-BANAMEX|TIT|000"]);
    expect(await count()).toBe(3);
  });
  it("no crea tarjetas de más: la misma tarjeta se reutiliza", async () => {
    await send(A, "msg-A");
    await send({ ...A, body: A.body.replace("000000", "000009") }, "msg-A2");
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.cards"))[0].n)).toBe(1);
  });
  it("correos que no son gasto → ignored, no escribe nada", async () => {
    for (const subject of ["Alta de cuenta", "Superaste tu límite de transacción", "Rechazo de cargo a cuenta para Domiciliación"]) {
      expect((await send({ ...A, subject }, `msg-ign-${++n}`)).json).toMatchObject({ status: "ignored" });
    }
    expect((await send({ ...A, body: A.body.replace("Exitoso", "Rechazado") }, "msg-rej")).json).toMatchObject({ status: "ignored" });
    expect(await count()).toBe(0);
    expect(await listUnparsed()).toHaveLength(0);
  });
  it("D a un comercio normal → gasto recurrente en 'Domiciliación', con la cuenta como referencia y SIN crear tarjeta", async () => {
    await send(D("NETFLIX COM", "$229.00"), "msg-D");
    expect((await rows())[0]).toMatchObject({ kind: "expense", is_recurring: true, account_ref: "000" });
    const cards = await query<{ name: string; needs_name: boolean }>("SELECT name, needs_name FROM dbo.cards");
    expect(cards).toEqual([{ name: "Domiciliación", needs_name: false }]);
    const res = await (await listTx(req("/api/transactions", { headers: authed() }), ctx())).json();
    expect(res.rows[0]).toMatchObject({ card_name: "Domiciliación", account_ref: "000", is_recurring: true });
  });
  it("varias domiciliaciones de cuentas distintas reutilizan la misma tarjeta de sistema", async () => {
    await send(D("NETFLIX COM", "$229.00"), "msg-D1");
    await send({ ...D("SPOTIFY AB", "$129.00"), body: D("SPOTIFY AB", "$129.00").body.replace("Cuenta de cargo\n000", "Cuenta de cargo\n9876").replace("S000 0000000000", "S111 1111111111") }, "msg-D2");
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.cards"))[0].n)).toBe(1);
    expect((await rows()).map((r) => r.account_ref)).toEqual(["000", "9876"]);
  });
  it("la clave de tarjeta incluye producto: mismos dígitos y distinto producto → tarjetas distintas", async () => {
    await send(A, "msg-A");
    await send({ ...A, body: A.body.replace("EXPLORA BANAMEX**000", "ORO BANAMEX**000").replace("000000", "000555") }, "msg-A2");
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.cards"))[0].n)).toBe(2);
  });
});

describe("pagos de tarjeta (card_payment) fuera de los gastos", () => {
  it("D→Amex y E se guardan como card_payment y NO suman en totales, gráficas ni listado por defecto", async () => {
    await send(A, "msg-A");
    await send(D(), "msg-D");
    await send(E, "msg-E");
    const kinds = (await rows()).map((r) => r.kind);
    expect(kinds.sort()).toEqual(["card_payment", "card_payment", "expense"]);

    const ov = await getOverview("2026-10", new Date("2026-10-15T12:00:00Z"));
    expect(ov.total).toBe(142358);
    expect(ov.count).toBe(1);
    const jul = await getOverview("2026-07", new Date("2026-07-30T12:00:00Z"));
    expect(jul.total).toBe(0);
    expect((await getCategoryBreakdown("2026-10")).reduce((a, c) => a + c.cents, 0)).toBe(142358);

    const def = await (await listTx(req("/api/transactions?limit=50", { headers: authed() }), ctx())).json();
    expect(def.rows).toHaveLength(1);
    const pays = await (await listTx(req("/api/transactions?kind=card_payment", { headers: authed() }), ctx())).json();
    expect(pays.rows.map((r: { amount_cents: number }) => r.amount_cents).sort()).toEqual([32624, 3799972]);
  });
});

describe("pagos de tarjeta ligados por la referencia y pagadores configurables", () => {
  it("el pago D a Amex se liga a la tarjeta Amex cuya terminación coincide con la referencia", async () => {
    const amex = await createCard({ name: "Amex Platinum", issuer: "amex", last4: "0000", aliases: "Amex", color: "#999" });
    await send(D(), "msg-D");
    const [p] = await rows();
    expect(p).toMatchObject({ kind: "card_payment", account_ref: "000" });
    expect(p.card_id).toBe(amex.id);
    const cards = await query<{ name: string }>("SELECT name FROM dbo.cards");
    expect(cards.map((c) => c.name)).toEqual(["Amex Platinum"]); // no creó ninguna tarjeta
  });
  it("si ninguna tarjeta coincide, cuelga de 'Domiciliación' (sin inventar tarjetas)", async () => {
    await send(D(), "msg-D");
    expect((await query<{ name: string }>("SELECT c.name FROM dbo.transactions x JOIN dbo.cards c ON c.id=x.card_id"))[0].name).toBe("Domiciliación");
  });
  it("si dos tarjetas comparten terminación no adivina: usa 'Domiciliación'", async () => {
    await createCard({ name: "Amex A", issuer: "amex", last4: "0000", aliases: null, color: "#999" });
    await createCard({ name: "Amex B", issuer: "amex", last4: "0000", aliases: null, color: "#999" });
    await send(D(), "msg-D");
    expect((await query<{ name: string }>("SELECT c.name FROM dbo.transactions x JOIN dbo.cards c ON c.id=x.card_id"))[0].name).toBe("Domiciliación");
  });
  it("los pagadores se administran en la app: agregar uno nuevo cambia la clasificación", async () => {
    const mine = D("NU MEXICO FINANCIERA", "$500.00");
    await send(mine, "msg-D1");
    expect((await rows())[0].kind).toBe("expense");
    const p = await createPayee("nu mexico");
    try {
      expect(p.pattern).toBe("NU MEXICO");
      await send({ ...mine, body: mine.body.replace("S000 0000000000", "S222 2222222222") }, "msg-D2");
      expect((await rows())[1].kind).toBe("card_payment");
    } finally {
      await deletePayee(p.id);
    }
    expect((await listPayees()).map((x) => x.pattern)).toEqual(["AMERICAN EXPRESS", "AMEX"]);
  });
  it("API de pagadores exige sesión", async () => {
    const { GET, POST } = await import("@/app/api/payees/route");
    expect((await GET(req("/api/payees"), ctx())).status).toBe(401);
    expect((await POST(req("/api/payees", { body: { pattern: "X" } }), ctx())).status).toBe(401);
  });
});

describe("pendientes de revisión (no parseables)", () => {
  const bad = { ...A, body: A.body.replace("$1,423.58", "mucho dinero") };
  it("se guarda solo id, remitente, asunto, fecha y razón: nunca el cuerpo", async () => {
    const secret = { ...bad, body: bad.body + "\nSECRETO-NO-GUARDAR-9999" };
    const { json } = await send(secret, "msg-bad");
    expect(json).toMatchObject({ status: "unparsed" });
    const dump = JSON.stringify(await query("SELECT * FROM dbo.unparsed_emails"));
    expect(dump).not.toContain("SECRETO");
    expect(dump).not.toContain("FERRETERIA");
    expect(await listUnparsed()).toEqual([expect.objectContaining({ message_id: "msg-bad", sender: FROM, subject: A.subject })]);
    expect(await count()).toBe(0);
  });
  it("reenviarlo no crea otro pendiente; asunto desconocido también cae aquí", async () => {
    await send(bad, "msg-bad");
    await send(bad, "msg-bad");
    await send({ ...A, subject: "Algo nuevo" }, "msg-new");
    expect(await listUnparsed()).toHaveLength(2);
  });
  it("si luego el correo sí se entiende, deja de estar pendiente", async () => {
    await send(bad, "msg-1");
    expect((await send(A, "msg-1")).json).toMatchObject({ status: "created" });
    expect(await listUnparsed()).toHaveLength(0);
  });
  it("se puede descartar desde el dashboard (requiere sesión)", async () => {
    await send(bad, "msg-bad");
    expect((await dismiss(req("/api/unparsed/msg-bad", { method: "DELETE" }), ctx({ id: "msg-bad" }))).status).toBe(401);
    expect((await dismiss(req("/api/unparsed/msg-bad", { method: "DELETE", headers: authed() }), ctx({ id: "msg-bad" }))).status).toBe(200);
    expect(await listUnparsed()).toHaveLength(0);
  });
  it("moneda distinta de MXN → pendiente, sin convertir", async () => {
    expect((await send({ ...A, body: A.body.replace("$1,423.58", "$ 20.00 USD") }, "msg-usd")).json).toMatchObject({ status: "unparsed" });
    expect(await count()).toBe(0);
  });
});

describe("tarjetas existentes", () => {
  it("adopta una tarjeta Banamex tuya cuando coinciden los últimos dígitos", async () => {
    const mine = await createCard({ name: "Explora", issuer: "banamex", last4: "000", aliases: "Banamex Explora", color: "#2b6fff" });
    const { json } = await send(A, "msg-A");
    expect(json).toMatchObject({ status: "created", cardCreated: false });
    expect((await rows())[0].card_id).toBe(mine.id);
    expect(Number((await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.cards"))[0].n)).toBe(1);
  });
});

describe("fusión Atajo ↔ correo", () => {
  // Compra A: 2026-10-01 12:44:22 hora local = 18:44:22Z
  beforeEach(async () => {
    await createCard({ name: "Explora", issuer: "banamex", last4: "000", aliases: "Banamex Explora", color: "#2b6fff" });
  });
  const shortcut = (date: string, amount = "$1,423.58") => wallet("Ferreteria", amount, "Banamex Explora", date);

  it("atajo → correo: una sola transacción, el correo manda y se conservan ambas fuentes", async () => {
    expect((await (await shortcut("2026-10-01T12:44:00-06:00")).json()).status).toBe("inserted");
    const { json } = await send(A, "msg-A");
    expect(json).toMatchObject({ status: "merged" });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ source: "email", sources: "shortcut,email", auth_code: "000000", merchant_raw: "FERRETERIA EJEMPLO SA", email_message_id: "msg-A" });
    expect((all[0].occurred_at as Date).toISOString()).toBe("2026-10-01T18:44:22.000Z");
  });
  it("correo → atajo: una sola transacción", async () => {
    await send(A, "msg-A");
    const res = await (await shortcut("2026-10-01T12:45:30-06:00")).json();
    expect(res.status).toBe("merged");
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ sources: "email,shortcut", merchant_raw: "FERRETERIA EJEMPLO SA" });
  });
  it("reenvío del correo tras fusionar no duplica", async () => {
    await shortcut("2026-10-01T12:44:00-06:00");
    await send(A, "msg-A");
    expect((await send(A, "msg-A")).json).toEqual({ status: "duplicate" });
    expect(await count()).toBe(1);
  });
  it("reintento del Atajo (503 en arranque en frío) tras fusionar no duplica, en ambos órdenes", async () => {
    const at = "2026-10-01T12:44:00-06:00";
    await shortcut(at);
    await send(A, "msg-A");
    expect((await (await shortcut(at)).json()).status).toBe("duplicate");
    expect(await count()).toBe(1);

    await resetDb();
    await query("DELETE FROM dbo.merged_hashes");
    await createCard({ name: "Explora", issuer: "banamex", last4: "000", aliases: "Banamex Explora", color: "#2b6fff" });
    await send(A, "msg-A");
    expect((await (await shortcut(at)).json()).status).toBe("merged");
    expect((await (await shortcut(at)).json()).status).toBe("duplicate");
    expect(await count()).toBe(1);
  });
  it("mismo monto pero más de 15 min de diferencia → NO se fusionan", async () => {
    await shortcut("2026-10-01T12:00:00-06:00"); // 44 min antes
    expect((await send(A, "msg-A")).json).toMatchObject({ status: "created" });
    expect(await count()).toBe(2);
  });
  it("justo en el borde: 15 min sí, 16 min no", async () => {
    await shortcut("2026-10-01T12:29:22-06:00"); // 15:00 antes
    expect((await send(A, "msg-A")).json).toMatchObject({ status: "merged" });
    await resetDb();
    await query("DELETE FROM dbo.merged_hashes");
    await createCard({ name: "Explora", issuer: "banamex", last4: "000", aliases: "Banamex Explora", color: "#2b6fff" });
    await shortcut("2026-10-01T12:28:22-06:00"); // 16:00 antes
    expect((await send(A, "msg-A")).json).toMatchObject({ status: "created" });
  });
  it("mismo tiempo pero distinto monto → NO se fusionan", async () => {
    await shortcut("2026-10-01T12:44:00-06:00", "$1,423.59");
    expect((await send(A, "msg-A")).json).toMatchObject({ status: "created" });
    expect(await count()).toBe(2);
  });
  it("otra tarjeta → NO se fusionan", async () => {
    await createCard({ name: "Amex", issuer: "amex", last4: "1005", aliases: "Amex", color: "#fff" });
    await wallet("Ferreteria", "$1,423.58", "Amex", "2026-10-01T12:44:00-06:00");
    expect((await send(A, "msg-A")).json).toMatchObject({ status: "created" });
    expect(await count()).toBe(2);
  });
  it("dos compras iguales con minutos de diferencia: cada correo se fusiona con su Atajo", async () => {
    await shortcut("2026-10-01T12:44:00-06:00");
    await shortcut("2026-10-01T12:49:00-06:00");
    const second = { ...A, body: A.body.replace("2026/10/1 12:44:22 PM", "2026/10/1 12:49:10 PM").replace("000000", "000777") };
    expect((await send(A, "msg-1")).json).toMatchObject({ status: "merged" });
    expect((await send(second, "msg-2")).json).toMatchObject({ status: "merged" });
    const all = await rows();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.sources === "shortcut,email")).toBe(true);
    expect(new Set(all.map((r) => r.auth_code))).toEqual(new Set(["000000", "000777"]));
  });
  it("dos compras iguales por correo (minutos distintos) no se fusionan entre sí", async () => {
    await send(A, "msg-1");
    await send({ ...A, body: A.body.replace("2026/10/1 12:44:22 PM", "2026/10/1 12:49:10 PM").replace("000000", "000777") }, "msg-2");
    expect(await count()).toBe(2);
  });
  it("un pago de tarjeta (card_payment) nunca se fusiona con el Atajo", async () => {
    await createCard({ name: "Clasica", issuer: "banamex", last4: "000", aliases: "Banamex Clasica", color: "#fff" });
    await wallet("Pago", "$326.24", "Banamex Clasica", "2026-07-22T10:28:00-06:00");
    expect((await send(E, "msg-E")).json).toMatchObject({ status: "created" });
    expect(await count()).toBe(2);
  });
  it("se recategoriza con el comercio normalizado si la transacción no tenía categoría", async () => {
    const cat = await createCategory({ name: "Hogar", color: "#0f0" });
    await createRule({ pattern: "FERRETERIA", match_type: "contains", category_id: cat.id, priority: 0 });
    await shortcut("2026-10-01T12:44:00-06:00");
    await query("UPDATE dbo.transactions SET category_id = NULL");
    await send(A, "msg-A");
    expect((await rows())[0].category_id).toBe(cat.id);
  });
});

describe("Atajo en tarjeta Banamex sin correo", () => {
  it("pasadas 24 h queda 'sin confirmación bancaria'; la Amex nunca", async () => {
    await createCard({ name: "Explora", issuer: "banamex", last4: "000", aliases: "Banamex Explora", color: "#2b6fff" });
    await createCard({ name: "Amex", issuer: "amex", last4: "1005", aliases: "Amex", color: "#fff" });
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    const fresh = new Date(Date.now() - 3600_000).toISOString();
    await wallet("Viejo", "$10", "Banamex Explora", old);
    await wallet("Reciente", "$11", "Banamex Explora", fresh);
    await wallet("Amex vieja", "$12", "Amex", old);
    const res = await (await listTx(req("/api/transactions?limit=50", { headers: authed() }), ctx())).json();
    const by = Object.fromEntries(res.rows.map((r: { merchant_raw: string; unconfirmed: boolean }) => [r.merchant_raw, r.unconfirmed]));
    expect(by).toEqual({ Viejo: true, Reciente: false, "Amex vieja": false });
  });
});
