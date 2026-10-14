import { describe, expect, it } from "vitest";
import { extractMessages, MAX_MESSAGES_PER_POST } from "@/lib/whatsapp/payload";
import { textMsg, webhookBody, WA } from "../wa-webhook-fixtures";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const run = (body: unknown) => extractMessages(body, WA.phoneNumberId, NOW);
const one = (m: Record<string, unknown>) => run(webhookBody([m])).messages;

describe("payload de Meta → InboundMessage", () => {
  it("texto", () => {
    expect(one(textMsg("wamid.T1", "350 starbucks"))).toEqual([{ id: "wamid.T1", from: WA.alex, timestamp: 1790000000, type: "text", text: "350 starbucks" }]);
  });
  it("texto con espacios y emojis se conserva tal cual; se acota a 4096", () => {
    expect(one(textMsg("wamid.T2", "  café ☕  "))[0].text).toBe("  café ☕  ");
    expect(one(textMsg("wamid.T3", "x".repeat(5000)))[0].text).toHaveLength(4096);
  });
  it("documento (PDF) con filename y mime", () => {
    const [m] = one({ from: WA.alex, id: "wamid.D1", timestamp: "1790000001", type: "document", document: { id: "55501", mime_type: "application/pdf", filename: "ticket.pdf", sha256: "abc" } });
    expect(m).toEqual({ id: "wamid.D1", from: WA.alex, timestamp: 1790000001, type: "document", media: { id: "55501", mimeType: "application/pdf", filename: "ticket.pdf" } });
  });
  it("imagen con caption (se ignora el caption) y sin filename", () => {
    const [m] = one({ from: WA.alex, id: "wamid.I1", timestamp: "1790000002", type: "image", image: { id: "55502", mime_type: "image/jpeg", caption: "ticket" } });
    expect(m.type).toBe("image");
    expect(m.media).toEqual({ id: "55502", mimeType: "image/jpeg" });
  });
  it("audio (nota de voz)", () => {
    const [m] = one({ from: WA.alex, id: "wamid.A1", timestamp: "1790000003", type: "audio", audio: { id: "55503", mime_type: "audio/ogg; codecs=opus", voice: true } });
    expect(m).toMatchObject({ type: "audio", media: { id: "55503", mimeType: "audio/ogg; codecs=opus" } });
  });
  it.each([
    ["reaction", { reaction: { message_id: "wamid.X", emoji: "👍" } }],
    ["button", { button: { text: "Sí", payload: "yes" } }],
    ["interactive", { interactive: { type: "button_reply", button_reply: { id: "1", title: "Sí" } } }],
    ["location", { location: { latitude: 19.4, longitude: -99.1 } }],
    ["contacts", { contacts: [{ name: { formatted_name: "Fulano" } }] }],
    ["sticker", { sticker: { id: "55504", mime_type: "image/webp" } }],
    ["system", { system: { body: "cambió de número", type: "user_changed_number" } }],
    ["order", { order: { catalog_id: "1" } }],
    ["unsupported", { errors: [{ code: 131051, title: "Unsupported message type" }] }],
  ])("%s → type other, sin texto ni media", (type, extra) => {
    const [m] = one({ from: WA.alex, id: `wamid.${type}`, timestamp: "1790000004", type, ...extra });
    expect(m).toEqual({ id: `wamid.${type}`, from: WA.alex, timestamp: 1790000004, type: "other" });
  });
  it("tipo de texto sin cuerpo o documento sin media → other (no se pierde el mensaje)", () => {
    expect(one({ from: WA.alex, id: "w1", timestamp: "1", type: "text" })[0].type).toBe("other");
    expect(one({ from: WA.alex, id: "w2", timestamp: "1", type: "document" })[0].type).toBe("other");
    expect(one({ from: WA.alex, id: "w3", timestamp: "1", type: "image", image: {} })).toEqual([]); // media sin id: inválido
  });
  it("timestamp ausente o inválido → ahora; numérico también vale", () => {
    expect(one({ from: WA.alex, id: "w4", type: "text", text: { body: "a" } })[0].timestamp).toBe(Math.floor(NOW / 1000));
    expect(one({ from: WA.alex, id: "w5", timestamp: "ayer", type: "text", text: { body: "a" } })[0].timestamp).toBe(Math.floor(NOW / 1000));
    expect(one({ from: WA.alex, id: "w6", timestamp: 1790000009, type: "text", text: { body: "a" } })[0].timestamp).toBe(1790000009);
  });

  it("solo statuses (acuses de entrega) → nada y se cuentan", () => {
    const r = run(webhookBody([], { statuses: [{ id: "wamid.S", status: "delivered", recipient_id: WA.alex }, { id: "wamid.S2", status: "read" }] }));
    expect(r.messages).toEqual([]);
    expect(r.stats.statuses).toBe(2);
    expect(r.notWhatsApp).toBe(false);
  });
  it("mensajes + statuses en el mismo value: solo se toman los mensajes", () => {
    const r = run(webhookBody([textMsg("wamid.M", "hola")], { statuses: [{ id: "s", status: "sent" }] }));
    expect(r.messages.map((m) => m.id)).toEqual(["wamid.M"]);
  });
  it("varios mensajes y varias entradas/cambios, en orden", () => {
    const b = webhookBody([textMsg("wamid.1", "uno"), textMsg("wamid.2", "dos", WA.sam)]);
    const second = webhookBody([textMsg("wamid.3", "tres")]);
    (b.entry as unknown[]).push(...(second.entry as unknown[]));
    (b.entry[0].changes as unknown[]).push(...(webhookBody([textMsg("wamid.4", "cuatro")]).entry[0].changes as unknown[]));
    const r = run(b);
    expect(r.messages.map((m) => m.id)).toEqual(["wamid.1", "wamid.2", "wamid.4", "wamid.3"]);
    expect(r.stats.entries).toBe(2);
  });
  it("metadata de OTRO número → ignorado y contado", () => {
    const r = run(webhookBody([textMsg("wamid.F", "hola")], { phoneNumberId: "999999999" }));
    expect(r.messages).toEqual([]);
    expect(r.stats.foreignNumber).toBe(1);
  });
  it("phone_number_id numérico o ausente: numérico igual vale, ausente se ignora", () => {
    const b = webhookBody([textMsg("wamid.N", "hola")]) as { entry: { changes: { value: { metadata: Record<string, unknown> } }[] }[] };
    b.entry[0].changes[0].value.metadata.phone_number_id = Number(WA.phoneNumberId);
    expect(run(b).messages).toHaveLength(1);
    delete b.entry[0].changes[0].value.metadata.phone_number_id;
    expect(run(b).messages).toEqual([]);
    delete (b.entry[0].changes[0].value as { metadata?: unknown }).metadata;
    expect(run(b).messages).toEqual([]);
  });
  it("un value del número correcto y otro de otro número en el mismo POST: solo el correcto", () => {
    const b = webhookBody([textMsg("wamid.OK", "a")]);
    b.entry[0].changes.push(webhookBody([textMsg("wamid.NO", "b")], { phoneNumberId: "1" }).entry[0].changes[0]);
    expect(run(b).messages.map((m) => m.id)).toEqual(["wamid.OK"]);
  });
  it("changes con otro `field` se ignoran", () => {
    const b = webhookBody([textMsg("wamid.X", "a")]);
    (b.entry[0].changes[0] as { field: string }).field = "message_template_status_update";
    expect(run(b).messages).toEqual([]);
  });
  it("campos extra desconocidos no estorban", () => {
    const b = webhookBody([{ ...textMsg("wamid.E", "hola"), nuevo_campo: { a: [1, 2] }, context: { from: "x", id: "y" }, referral: {} }]);
    (b as Record<string, unknown>).otro = true;
    expect(run(b).messages).toHaveLength(1);
  });

  describe("forma rara: nunca lanza", () => {
    it.each([
      ["null", null], ["undefined", undefined], ["número", 5], ["texto", "hola"], ["arreglo", []], ["objeto vacío", {}],
      ["object distinto", { object: "page", entry: [] }], ["object de tipo erróneo", { object: 7 }],
      ["entry no arreglo", { object: "whatsapp_business_account", entry: "x" }],
      ["entry vacío", { object: "whatsapp_business_account", entry: [] }],
      ["entry con basura", { object: "whatsapp_business_account", entry: [null, 1, "x", [], { changes: "x" }, { changes: [null, 3, { value: "x" }, { value: null }, { value: { messages: "x" } }] }] }],
      ["messages con basura", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: WA.phoneNumberId }, messages: [null, 1, "x", [], {}, { id: 5 }, { id: "a", from: "abc" }, { id: "a", from: WA.alex, type: 9 }, { id: "a", from: WA.alex, text: { body: 5 }, type: "text" }] } }] }] }],
      ["metadata de tipo erróneo", { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: "x", messages: [] } }] }] }],
    ])("%s", (_n, body) => {
      const r = run(body);
      expect(r.messages).toEqual([]);
    });
    it("id vacío o demasiado largo, from sin dígitos → descartado y contado", () => {
      const r = run(webhookBody([
        { from: WA.alex, id: "", timestamp: "1", type: "text", text: { body: "a" } },
        { from: WA.alex, id: "x".repeat(121), timestamp: "1", type: "text", text: { body: "a" } },
        { from: "no-es-numero", id: "w1", timestamp: "1", type: "text", text: { body: "a" } },
        textMsg("wamid.BUENO", "ok"),
      ]));
      expect(r.messages.map((m) => m.id)).toEqual(["wamid.BUENO"]);
      expect(r.stats.skipped).toBe(3);
    });
    it("un getter hostil no se propaga", () => {
      const evil = { object: "whatsapp_business_account", get entry(): never { throw new Error("boom"); } };
      expect(() => run(evil)).not.toThrow();
      expect(run(evil).messages).toEqual([]);
    });
    it("tope de mensajes por POST", () => {
      const many = Array.from({ length: MAX_MESSAGES_PER_POST + 5 }, (_, i) => textMsg(`wamid.${i}`, "a"));
      const r = run(webhookBody(many));
      expect(r.messages).toHaveLength(MAX_MESSAGES_PER_POST);
      expect(r.stats.truncated).toBe(5);
    });
  });
});
