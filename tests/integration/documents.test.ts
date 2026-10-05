import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as upload, GET as listDocs } from "@/app/api/documents/route";
import { POST as confirm } from "@/app/api/documents/[id]/confirm/route";
import { RulesCategorizer } from "@/lib/categorizer/rules";
import { IntakeError, processDocument } from "@/lib/docs/intake";
import { closePool, query, t } from "@/lib/db/pool";
import { OcrError, type OcrResult } from "@/lib/pdf/ocr";
import { createCard } from "@/lib/repo/cards";
import { createCategory } from "@/lib/repo/categories";
import { getAccountCardMap } from "@/lib/repo/transfers";
import { authed, ctx, resetDb } from "../helpers";
import { imagePdf, receiptPdf, recentDate, textPdf } from "../pdf-fixtures";

const deps = () => ({ categorizer: new RulesCategorizer() });
const run = (bytes: Uint8Array, d: Parameters<typeof processDocument>[1] = deps()) => processDocument({ bytes, origin: "app" }, d);
const txs = () => query<{ id: number; cents: number; merchant_raw: string; card: string; kind: string; tracking_key: string | null }>(
  "SELECT x.id, CAST(x.amount_cents AS float) AS cents, x.merchant_raw, c.name AS card, x.kind, x.tracking_key FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id ORDER BY x.id",
);
const docs = () => query<{ id: number; status: string; kind: string; tx_id: number | null }>("SELECT id, status, kind, tx_id FROM dbo.documents ORDER BY id");

// Lecturas de OCR inventadas (para simular desacuerdos y fallos sin depender del motor).
const ocrPass = (amount: string, o: { key?: string } = {}) => ({
  scale: 2.5,
  pages: [
    { page: 1, confidence: 95, text: `Comprobante de transferencia\nBanamex\nTransferencia exitosa\n${amount}\nCuenta origen\nMiCuenta Banamex **456\nCuenta destino\nCasero **789\nBbva - Juan Perez *\nNúmero de autorización 123456\nClave de rastreo ${o.key ?? "012345678901234567"}` },
    { page: 2, confidence: 95, text: `Tipo de cuenta Débito\nConcepto Renta depa\nReferencia numérica 4321\nFecha y hora ${recentDate()} 09:05 h` },
  ],
});
const fakeOcr = (passes: ReturnType<typeof ocrPass>[]) => async (): Promise<OcrResult> => ({ passes, numPages: 2 });
const same = () => fakeOcr([ocrPass("$1,234.56 MXN"), ocrPass("$1,234.56 MXN")]);

beforeEach(async () => {
  await resetDb();
  await createCard({ name: "Débito ···296", issuer: "banamex", last4: "296", aliases: null, color: "#38bdf8" });
  await createCategory({ name: "Transferencias", color: "#123456" });
});
afterAll(closePool);

describe("comprobante de transferencia (PDF de imagen → OCR local)", () => {
  it("lo lee, registra el gasto en el débito y es idempotente al volver a subirlo", async () => {
    const pdf = receiptPdf();
    const r = await run(pdf, { ...deps(), ocr: same() });
    expect(r).toMatchObject({ kind: "transfer_receipt", status: "processed", already: false, registered: "inserted" });
    expect(await txs()).toMatchObject([{ cents: 123_456, merchant_raw: "Renta depa", card: "Débito ···296", kind: "expense", tracking_key: "012345678901234567" }]);

    const again = await run(pdf, { ...deps(), ocr: same() });
    expect(again).toMatchObject({ already: true, status: "processed", documentId: r.documentId });
    expect(await txs()).toHaveLength(1);
    expect(await docs()).toHaveLength(1);
  }, 60_000);

  it("transferencia entre cuentas Banamex (sin clave de rastreo): se registra por autorización y no se duplica", async () => {
    const internal = () => {
      const p = ocrPass("$750.00 MXN");
      p.pages[0].text = p.pages[0].text.replace(/\nClave de rastreo .*/, "");
      return p;
    };
    const ocr = fakeOcr([internal(), internal()]);
    const r = await run(receiptPdf(), { ...deps(), ocr });
    expect(r).toMatchObject({ kind: "transfer_receipt", status: "processed", registered: "inserted" });
    const rows = await txs();
    expect(rows).toMatchObject([{ cents: 75_000, kind: "expense" }]);
    expect(rows[0].tracking_key).toMatch(/^AUT123456\d{8}$/);
    // otro PDF de la misma operación → duplicado
    const again = await run(receiptPdf({ concept: "Otra copia" }), { ...deps(), ocr });
    expect(again).toMatchObject({ status: "processed", registered: "duplicate" });
    expect(await txs()).toHaveLength(1);
  }, 90_000);

  it("el mismo envío en un PDF distinto (otra huella) no duplica el gasto: manda la clave de rastreo", async () => {
    await run(receiptPdf(), { ...deps(), ocr: same() });
    const r = await run(receiptPdf({ concept: "Renta depa otra vez" }), { ...deps(), ocr: same() }); // otro archivo, mismo rastreo
    expect(r).toMatchObject({ status: "processed", registered: "duplicate", already: false });
    expect(await txs()).toHaveLength(1);
    expect(await docs()).toHaveLength(2);
  }, 90_000);

  it("transferencia rechazada: no se registra", async () => {
    const rej = ocrPass("$1,234.56 MXN");
    rej.pages[0].text = rej.pages[0].text.replace("Transferencia exitosa", "Transferencia rechazada");
    const r = await run(receiptPdf({ status: "Transferencia rechazada" }), { ...deps(), ocr: fakeOcr([rej, rej]) });
    expect(r).toMatchObject({ status: "rejected", kind: "transfer_receipt" });
    expect(await txs()).toHaveLength(0);
  }, 60_000);

  it("dos lecturas que no coinciden → revisión, sin registrar nada", async () => {
    const r = await run(new Uint8Array(imagePdf([["x"]])), { ...deps(), ocr: fakeOcr([ocrPass("$1,234.56 MXN"), ocrPass("$1,284.56 MXN")]) });
    expect(r.status).toBe("needs_review");
    expect(r.detail).toContain("monto");
    expect(await txs()).toHaveLength(0);
  });

  it("monto leído a medias (sin centavos completos) → no se registra", async () => {
    const r = await run(new Uint8Array(imagePdf([["y"]])), { ...deps(), ocr: fakeOcr([ocrPass("$1,23456 MXN"), ocrPass("$123456 MXN")]) });
    expect(r.status).toBe("failed");
    expect(await txs()).toHaveLength(0);
  });

  it("OCR caído → failed; al volver a subir el mismo archivo se reprocesa", async () => {
    const pdf = new Uint8Array(imagePdf([["z"]]));
    const bad = await run(pdf, { ...deps(), ocr: async () => { throw new OcrError("El OCR tardó demasiado"); } });
    expect(bad.status).toBe("failed");
    const ok = await run(pdf, { ...deps(), ocr: fakeOcr([ocrPass("$1,234.56 MXN"), ocrPass("$1,234.56 MXN")]) });
    expect(ok).toMatchObject({ status: "processed", already: false, documentId: bad.documentId });
    expect(await docs()).toHaveLength(1);
    expect(await txs()).toHaveLength(1);
  });

  it("fecha futura o monto altísimo → revisión humana", async () => {
    const future = ocrPass("$1,234.56 MXN");
    future.pages[1].text = future.pages[1].text.replace(/Fecha y hora .*/, "Fecha y hora 14 nov 2031 09:05 h");
    expect((await run(new Uint8Array(imagePdf([["f"]])), { ...deps(), ocr: fakeOcr([future, future]) })).status).toBe("needs_review");
    const big = ocrPass("$2,500,000.00 MXN");
    expect((await run(new Uint8Array(imagePdf([["g"]])), { ...deps(), ocr: fakeOcr([big, big]) })).detail).toContain("muy alto");
    expect(await txs()).toHaveLength(0);
  });
});

describe("protecciones contra registros dudosos", () => {
  const withKey = (key: string) => fakeOcr([ocrPass("$1,234.56 MXN", { key }), ocrPass("$1,234.56 MXN", { key })]);
  const confirmPost = (id: number, body: unknown) =>
    confirm(new Request("http://localhost:3000/x", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...authed() }, body: JSON.stringify(body) }), ctx({ id: String(id) }));
  const debitoId = async () => (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE last4='296'"))[0].id;

  it("misma transferencia con OTRA clave de rastreo (OCR leyó distinto en otro PDF) → revisión, no un segundo gasto", async () => {
    expect((await run(new Uint8Array(imagePdf([["p1"]])), { ...deps(), ocr: withKey("012345678901234567") })).status).toBe("processed");
    const r = await run(new Uint8Array(imagePdf([["p2"]])), { ...deps(), ocr: withKey("012345678901234568") });
    expect(r.status).toBe("needs_review");
    expect(r.detail).toContain("repetida");
    expect(await txs()).toHaveLength(1);
    // si el usuario confirma que es otra, se registra
    expect((await confirmPost(r.documentId, { card_id: await debitoId() })).status).toBe(200);
    expect(await txs()).toHaveLength(2);
  });

  it("OCR con poca confianza → revisión aunque las dos lecturas coincidan", async () => {
    const low = (o: ReturnType<typeof ocrPass>) => ({ ...o, pages: o.pages.map((p) => ({ ...p, confidence: 60 })) });
    const r = await run(new Uint8Array(imagePdf([["q"]])), { ...deps(), ocr: fakeOcr([low(ocrPass("$1,234.56 MXN")), low(ocrPass("$1,234.56 MXN"))]) });
    expect(r.status).toBe("needs_review");
    expect(r.detail).toContain("poca confianza");
    expect(await txs()).toHaveLength(0);
  });

  it("al confirmar: no acepta tarjetas inactivas ni de sistema, ni una fecha imposible aunque no se haya editado", async () => {
    const future = ocrPass("$1,234.56 MXN");
    future.pages[1].text = future.pages[1].text.replace(/Fecha y hora .*/, "Fecha y hora 14 nov 2031 09:05 h");
    const r = await run(new Uint8Array(imagePdf([["r"]])), { ...deps(), ocr: fakeOcr([future, future]) });
    expect(r.status).toBe("needs_review");
    expect((await confirmPost(r.documentId, { card_id: await debitoId() })).status).toBe(400); // fecha en el futuro sin corregir
    expect(await txs()).toHaveLength(0);
    const sistema = await createCard({ name: "Domiciliación", issuer: "banamex", last4: null, aliases: null, color: "#6b7280" });
    const inactiva = await createCard({ name: "Vieja", issuer: "banamex", last4: "999", aliases: null, color: "#6b7280", active: false });
    const ok = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect((await confirmPost(r.documentId, { card_id: sistema.id, occurred_at: ok })).status).toBe(400);
    expect((await confirmPost(r.documentId, { card_id: inactiva.id, occurred_at: ok })).status).toBe(400);
    expect((await confirmPost(r.documentId, { card_id: await debitoId(), occurred_at: ok })).status).toBe(200);
  });

  it("al confirmar con una clave de rastreo corregida que ya existe en otro movimiento → 409 y el documento sigue en revisión", async () => {
    await run(new Uint8Array(imagePdf([["s1"]])), { ...deps(), ocr: withKey("012345678901234567") });
    await createCard({ name: "Débito segundo", issuer: "banamex", last4: "111", aliases: null, color: "#38bdf8" }); // origen ambiguo → revisión
    const r = await run(new Uint8Array(imagePdf([["s2"]])), { ...deps(), ocr: withKey("555555555555555555") });
    expect(r.status).toBe("needs_review");
    const res = await confirmPost(r.documentId, { card_id: await debitoId(), tracking_key: "012345678901234567" });
    expect(res.status).toBe(409);
    expect((await docs()).find((d) => d.id === r.documentId)?.status).toBe("needs_review");
    expect(await txs()).toHaveLength(1);
  });
});

describe("tarjeta de origen ambigua → confirmar", () => {
  beforeEach(async () => {
    await createCard({ name: "Débito segundo", issuer: "banamex", last4: "111", aliases: null, color: "#38bdf8" });
  });

  it("queda en revisión; al confirmar registra, y con 'recordar' la próxima vez ya no pregunta", async () => {
    const pdf = new Uint8Array(imagePdf([["h"]]));
    const same = fakeOcr([ocrPass("$1,234.56 MXN"), ocrPass("$1,234.56 MXN")]);
    const r = await run(pdf, { ...deps(), ocr: same });
    expect(r).toMatchObject({ status: "needs_review" });
    expect(r.detail).toContain("tarjeta");
    expect(await txs()).toHaveLength(0);

    const card = (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE last4='296'"))[0].id;
    const res = await confirm(
      new Request("http://localhost:3000/api/documents/1/confirm", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...authed() }, body: JSON.stringify({ card_id: card, remember: true, merchant: "Renta octubre" }) }),
      ctx({ id: String(r.documentId) }),
    );
    expect(res.status).toBe(200);
    expect(await txs()).toMatchObject([{ card: "Débito ···296", merchant_raw: "Renta octubre" }]);
    expect(await docs()).toMatchObject([{ status: "processed" }]);
    expect(await getAccountCardMap()).toEqual({ "456": card });

    // otro comprobante de la misma cuenta: ya sabe de qué tarjeta es
    const next = await run(new Uint8Array(imagePdf([["i"]])), { ...deps(), ocr: fakeOcr([ocrPass("$900.00 MXN", { key: "999999999999999999" }), ocrPass("$900.00 MXN", { key: "999999999999999999" })]) });
    expect(next.status).toBe("processed");
  });

  it("confirmar con correcciones al OCR; no se puede confirmar dos veces ni algo que no está en revisión", async () => {
    const r = await run(new Uint8Array(imagePdf([["j"]])), { ...deps(), ocr: fakeOcr([ocrPass("$1,234.56 MXN"), ocrPass("$1,284.56 MXN")]) });
    const card = (await query<{ id: number }>("SELECT id FROM dbo.cards WHERE last4='296'"))[0].id;
    const post = (id: number | string, body: unknown, headers: Record<string, string> = authed()) =>
      confirm(new Request("http://localhost:3000/x", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx({ id: String(id) }));
    expect((await post(r.documentId, { card_id: card, amount_cents: 123_456 })).status).toBe(200);
    expect((await txs())[0].cents).toBe(123_456);
    expect((await post(r.documentId, { card_id: card })).status).toBe(409);
    expect((await post(9999, { card_id: card })).status).toBe(404);
    expect((await post(r.documentId, { card_id: 999_999 })).status).toBe(409); // ya procesado gana
  });

  it("valida el cuerpo y exige sesión y mismo origen", async () => {
    const mk = (headers: Record<string, string>, body: unknown) =>
      confirm(new Request("http://localhost:3000/x", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx({ id: "1" }));
    expect((await mk({}, { card_id: 1 })).status).toBe(401);
    expect((await mk({ ...authed(), origin: "https://evil.example" }, { card_id: 1 })).status).toBe(403);
    expect((await mk(authed(), { card_id: "uno" })).status).toBe(400);
    expect((await mk(authed(), { card_id: 1, extra: true })).status).toBe(400);
    expect((await mk(authed(), { card_id: 1, tracking_key: "no valida!" })).status).toBe(400);
  });
});

describe("avisos", () => {
  const alerts = () => query<{ rule: string; severity: string; tx_id: number | null; document_id: number | null }>("SELECT [rule], severity, tx_id, document_id FROM dbo.alerts ORDER BY id");

  it("una transferencia registrada deja su aviso (una sola vez, aunque se vuelva a subir)", async () => {
    const pdf = new Uint8Array(imagePdf([["k"]]));
    const r = await run(pdf, { ...deps(), ocr: same() });
    await run(pdf, { ...deps(), ocr: same() });
    await run(new Uint8Array(imagePdf([["k2"]])), { ...deps(), ocr: same() }); // otro archivo, mismo rastreo → duplicado
    const a = (await alerts()).filter((x) => x.rule === "transfer_registered");
    expect(a).toHaveLength(1);
    expect(Number(a[0].tx_id)).toBe(r.txId);
  });

  it("un documento en revisión avisa para que lo revises; uno rechazado no", async () => {
    await createCard({ name: "Débito segundo", issuer: "banamex", last4: "111", aliases: null, color: "#38bdf8" });
    const r = await run(new Uint8Array(imagePdf([["m"]])), { ...deps(), ocr: same() });
    expect(r.status).toBe("needs_review");
    expect(await alerts()).toMatchObject([{ rule: "document_review", severity: "info", document_id: r.documentId }]);
    await run(textPdf([["Factura 1", "Total $1.00"]]));
    expect((await alerts()).filter((x) => x.rule === "document_review")).toHaveLength(1);
  });

  it("si la tabla de alertas falla, el documento igual se registra", async () => {
    await query("EXEC sp_rename 'dbo.alerts', 'alerts_x'");
    try {
      const r = await run(new Uint8Array(imagePdf([["n"]])), { ...deps(), ocr: same() });
      expect(r.status).toBe("processed");
      expect(await txs()).toHaveLength(1);
    } finally {
      await query("EXEC sp_rename 'dbo.alerts_x', 'alerts'");
    }
  });
});

describe("documentos que no se entienden", () => {
  it("PDF con texto que no es estado ni comprobante → rechazado con motivo", async () => {
    const r = await run(textPdf([["Factura 123", "Total $500.00 MXN", "Gracias por su compra"]]));
    expect(r).toMatchObject({ status: "rejected", kind: "unknown" });
    expect(r.detail).toContain("No es un comprobante");
    expect(await txs()).toHaveLength(0);
  });

  it("PDF de imagen que no es comprobante → rechazado (OCR real)", async () => {
    const r = await run(imagePdf([["Factura 123", "Total $500.00 MXN", "Gracias por su compra"]]));
    expect(r).toMatchObject({ status: "rejected", kind: "unknown" });
  }, 60_000);

  it("humo con OCR real: un comprobante dibujado se procesa o se manda a revisión, y nunca se registra un monto distinto", async () => {
    const r = await run(receiptPdf());
    expect(["processed", "needs_review", "failed"]).toContain(r.status);
    if (r.status === "processed") expect((await txs())[0].cents).toBe(123_456);
    else expect(await txs()).toHaveLength(0);
  }, 60_000);

  it("archivos que no son PDF, vacíos o enormes se rechazan antes de guardar nada", async () => {
    await expect(run(new TextEncoder().encode("hola"))).rejects.toMatchObject({ status: 415 });
    await expect(run(new Uint8Array())).rejects.toMatchObject({ status: 400 });
    await expect(run(new Uint8Array(13 * 1024 * 1024).fill(0x25))).rejects.toBeInstanceOf(IntakeError);
    expect(await docs()).toHaveLength(0);
  });

  it("PDF corrupto: queda como fallido (reintentable), no se rompe", async () => {
    const r = await run(new TextEncoder().encode("%PDF-1.4\nesto no es un pdf valido de verdad"));
    expect(r.status).toBe("failed");
  });
});

describe("POST /api/documents", () => {
  const form = (file: Uint8Array | null, extra: Record<string, string> = {}) => {
    const f = new FormData();
    if (file) f.set("file", new File([file as BlobPart], "comprobante.pdf", { type: "application/pdf" }));
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };
  const post = (body: BodyInit | null, headers: Record<string, string> = authed(), ct?: string) =>
    upload(new Request("http://localhost:3000/api/documents", { method: "POST", headers: { host: "localhost:3000", ...(ct ? { "content-type": ct } : {}), ...headers }, body }), ctx());

  it("sube el PDF, lo procesa y aparece en el listado (sin datos extraídos)", async () => {
    const res = await post(form(receiptPdf()));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { status: string; registered?: string };
    // El OCR real sobre una imagen dibujada puede variar según el sistema: procesado, en revisión o ilegible; nunca un error.
    expect(["processed", "needs_review", "failed"]).toContain(j.status);
    if (j.status === "processed") expect(j.registered).toBe("inserted");
    const list = (await (await listDocs(new Request("http://localhost:3000/api/documents", { headers: { host: "localhost:3000", ...authed() } }), ctx())).json()) as { documents: Record<string, unknown>[] };
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0]).not.toHaveProperty("extracted");
    expect(list.documents[0]).not.toHaveProperty("sha256");
  }, 60_000);

  it("exige sesión, mismo origen, multipart y archivo", async () => {
    expect((await post(form(receiptPdf()), {})).status).toBe(401);
    expect((await post(form(receiptPdf()), { ...authed(), origin: "https://evil.example" })).status).toBe(403);
    expect((await post(JSON.stringify({ a: 1 }), authed(), "application/json")).status).toBe(415);
    expect((await post(form(null))).status).toBe(400);
    expect((await post(form(new TextEncoder().encode("no soy pdf")))).status).toBe(415);
  });

  it("tope de tamaño del cuerpo → 413", async () => {
    // Con Content-Length declarado se corta sin leer el cuerpo (es lo que manda un navegador real).
    const big = new Response(form(new Uint8Array(13 * 1024 * 1024)));
    const ct = big.headers.get("content-type")!;
    const bytes = new Uint8Array(await big.arrayBuffer());
    const res = await post(bytes, { ...authed(), "content-length": String(bytes.length) }, ct);
    expect(res.status).toBe(413);
  });
});

describe("migración 010: origen 'telegram' y marca real de deshecho", () => {
  it("un PDF recibido por Telegram se guarda con origin 'telegram'; un origen desconocido lo rechaza la base", async () => {
    const r = await processDocument({ bytes: receiptPdf(), origin: "telegram" }, { ...deps(), ocr: same() });
    expect(r.documentId).toBeGreaterThan(0);
    expect((await query<{ origin: string }>("SELECT origin FROM dbo.documents WHERE id=@id", { id: t.int(r.documentId) }))[0].origin).toBe("telegram");
    await expect(query("UPDATE dbo.documents SET origin='sms'")).rejects.toThrow();
    for (const o of ["app", "whatsapp", "telegram"]) await query(`UPDATE dbo.documents SET origin='${o}'`);
  });
  it("whatsapp_messages.undone nace en 0 y seq crece con la llegada", async () => {
    await query("INSERT dbo.whatsapp_messages (msg_id, wa_id, kind) VALUES ('m1','tg1','text'), ('m2','tg1','text')");
    const rows = await query<{ msg_id: string; undone: boolean; seq: number }>("SELECT msg_id, undone, seq FROM dbo.whatsapp_messages ORDER BY msg_id");
    expect(rows.map((x) => x.undone)).toEqual([false, false]);
    expect(Number(rows[1].seq)).toBeGreaterThan(Number(rows[0].seq));
  });
});
