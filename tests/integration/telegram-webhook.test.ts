import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as routeGet, POST as routePost } from "@/app/api/telegram/route";
import { closePool, query } from "@/lib/db/pool";
import { claimMessage, finishMessage } from "@/lib/repo/whatsapp";
import { NOT_UNDERSTOOD, OUT_OF_CONTEXT } from "@/lib/whatsapp/replies";
import { proxy } from "@/proxy";
import { RateLimiter } from "@/lib/security/ratelimit";
import { telegramFailures, telegramIdPerUser, telegramPerIp } from "@/lib/security/ingest-limiters";
import { getTelegramConfig, type TelegramConfig } from "@/lib/telegram/config";
import { BUSY_ERROR, createTelegramWebhook, flushTelegramWork, GENERIC_ERROR, groupQuietIO, idReply, MAX_BODY, resetTelegramConfigWarning, type TelegramWebhookDeps } from "@/lib/telegram/webhook";
import type { HandleDeps, InboundMessage, Sender, WhatsAppIO } from "@/lib/whatsapp/types";
import { authed, req, resetDb } from "../helpers";
import { botUser, groupChat, groupReply, groupText, privateChat, secretHeader, TG, TG_ENV, textUpdate, update, user } from "../tg-webhook-fixtures";

const APP_HOST = "uz-inventada.azurewebsites.net";
const CFG = getTelegramConfig({ ...TG_ENV, WEBSITE_HOSTNAME: APP_HOST })!;
/** Con el grupo permitido y el usuario del bot conocido (modo grupo). */
const GCFG = getTelegramConfig({ ...TG_ENV, WEBSITE_HOSTNAME: APP_HOST, TELEGRAM_BOT_USERNAME: TG.botUsername, TELEGRAM_ALLOWED_CHATS: String(TG.group) })!;

let n = 0;
/** Cada prueba usa una IP distinta (la que agrega el proxy va al FINAL de X-Forwarded-For). */
const ipHeader = () => ({ "x-forwarded-for": `198.51.100.${(++n % 250) + 1}:5000` });

type Handled = { msg: InboundMessage; sender: Sender; deps: HandleDeps & { appUrl?: string } };

function harness(over: Partial<TelegramWebhookDeps> = {}, cfg: TelegramConfig | null = CFG) {
  const queue: (() => Promise<void>)[] = [];
  const sent: { to: string; body: string }[] = [];
  const handled: Handled[] = [];
  const events: string[] = [];
  const io: WhatsAppIO = {
    sendText: async (to, body) => void sent.push({ to, body }),
    downloadMedia: async () => {
      throw new Error("sin red en pruebas");
    },
  };
  const handle = vi.fn(async (msg: InboundMessage, sender: Sender, _io: WhatsAppIO, deps: Handled["deps"]) => {
    events.push(`handle:${msg.id}`);
    handled.push({ msg, sender, deps });
  });
  const after = vi.fn((fn: () => Promise<void>) => void queue.push(fn));
  const h = createTelegramWebhook({ config: () => cfg, io: () => io, handle, after, ...over });
  const flush = async () => {
    while (queue.length) await queue.shift()!();
  };

  /** POST con el secreto correcto (salvo que se pida otra cosa). */
  const post = (body: unknown, opts: { raw?: string; headers?: Record<string, string>; secret?: string | null } = {}) => {
    const raw = opts.raw ?? (typeof body === "string" ? body : JSON.stringify(body));
    const headers = { ...ipHeader(), ...(opts.secret === null ? {} : secretHeader(opts.secret)), ...opts.headers };
    return h.POST(new Request("http://localhost:3000/api/telegram", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }));
  };
  return { h, queue, sent, handled, events, handle, after, post, flush, io };
}

const rows = () => query<{ msg_id: string; wa_id: string; kind: string; status: string }>("SELECT msg_id, wa_id, kind, status FROM dbo.whatsapp_messages ORDER BY msg_id");

let logs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of [...Object.keys(TG_ENV), "TELEGRAM_BOT_USERNAME", "WEBSITE_HOSTNAME", "APP_URL"]) savedEnv[k] = process.env[k];
  Object.assign(process.env, TG_ENV, { WEBSITE_HOSTNAME: APP_HOST });
  delete process.env.APP_URL;
  delete process.env.TELEGRAM_BOT_USERNAME;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closePool();
});
beforeEach(async () => {
  await resetDb();
  telegramPerIp.reset();
  telegramFailures.reset();
  telegramIdPerUser.reset();
  resetTelegramConfigWarning();
  logs = [];
  const grab = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

describe("solo POST", () => {
  it("GET → 405 con Allow: POST (Telegram no verifica por GET)", async () => {
    const res = await harness().h.GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST: el secreto es obligatorio y se comprueba primero", () => {
  const body = textUpdate(1001, "hola");

  it("secreto válido → se procesa ANTES de responder: auth → claim → handle → 200", async () => {
    const events: string[] = [];
    const t = harness({
      claim: async (id, w, k) => {
        events.push("claim");
        return (await import("@/lib/repo/whatsapp")).claimMessage(id, w, k);
      },
    });
    t.handle.mockImplementation(async () => {
      events.push("handle");
    });
    const res = await t.post(body);
    events.push("200");
    expect(res.status).toBe(200);
    expect(events).toEqual(["claim", "handle", "200"]);
    expect(t.after).not.toHaveBeenCalled(); // no hizo falta after(): terminó dentro del presupuesto
    expect(await rows()).toEqual([{ msg_id: "tg:1001", wa_id: "tg111111111", kind: "text", status: "received" }]);
  });

  it("claim falso: el handler solo corre si claim devolvió true", async () => {
    const claim = vi.fn(async () => true);
    const t = harness({ claim });
    await t.post(body);
    expect(claim).toHaveBeenCalledWith("tg:1001", "tg111111111", "text");
    expect(t.handle).toHaveBeenCalledTimes(1);
    const t2 = harness({ claim: async () => false });
    await t2.post(body);
    expect(t2.handle).not.toHaveBeenCalled();
  });

  it("claim devolviendo true de nuevo (fila `received` vencida → reintento de Telegram) reprocesa el update", async () => {
    let calls = 0;
    const t = harness({ claim: async () => ++calls >= 1 });
    await t.post(body);
    await t.post(body);
    expect(t.handle).toHaveBeenCalledTimes(2);
  });

  it("el handler recibe mensaje, remitente autorizado, now = hora REAL de proceso (no la date del update) y appUrl", async () => {
    const t = harness();
    const before = Date.now();
    await t.post(update(1002, { text: "350 starbucks", from: user(TG.ana), chat: privateChat(TG.ana), date: 1790000123 }));
    expect(t.handled).toHaveLength(1);
    const h = t.handled[0];
    expect(h.msg).toEqual({ id: "tg:1002", from: "tg222222222", replyTo: "222222222", timestamp: 1790000123, channel: "telegram", type: "text", text: "350 starbucks" });
    expect(h.sender).toEqual({ waId: "tg222222222", name: "Ana" });
    // La guarda de 48 h del handler depende de que `now` NO sea la hora del mensaje.
    expect(h.deps.now).toBeInstanceOf(Date);
    expect(h.deps.now!.getTime()).toBeGreaterThanOrEqual(before);
    expect(h.deps.now!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.deps.now!.getTime()).not.toBe(1790000123 * 1000);
    expect(h.deps.appUrl).toBe(`https://${APP_HOST}`);
    expect(t.sent).toEqual([]); // la respuesta es asunto del handler
  });
  it("sin appUrl configurada no se pasa appUrl", async () => {
    const t = harness({}, getTelegramConfig(TG_ENV));
    await t.post(body);
    expect(t.handled[0].deps).not.toHaveProperty("appUrl");
  });

  it.each([
    ["ausente", { secret: null }],
    ["vacío", { secret: "" }],
    ["incorrecto", { secret: "otro-secreto-inventado-0123456789abcdef" }],
    ["casi correcto", { secret: TG.secret + "0" }],
    ["prefijo del correcto", { secret: TG.secret.slice(0, -1) }],
    ["en mayúsculas", { secret: TG.secret.toUpperCase() }],
    ["en otro encabezado", { secret: null, headers: { "x-secret": TG.secret, authorization: `Bearer ${TG.secret}` } }],
    ["en la URL en lugar del encabezado", { secret: null, headers: {} }],
  ] as [string, Parameters<ReturnType<typeof harness>["post"]>[1]][])("secreto %s → 401 y NO se procesa", async (_n, opts) => {
    const t = harness();
    const res = await t.post(body, opts);
    expect(res.status).toBe(401);
    expect(t.after).not.toHaveBeenCalled();
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    const text = await res.text();
    expect(text).not.toContain("tg:");
    expect(text).not.toContain(TG.secret);
  });

  it("con secreto malo el cuerpo NO se lee ni se parsea (ni siquiera uno gigantesco)", async () => {
    const t = harness();
    const r = new Request("http://localhost:3000/api/telegram", { method: "POST", headers: { ...ipHeader(), ...secretHeader("malo-malo-malo-malo-malo-malo-malo-0") }, body: "x".repeat(MAX_BODY + 10) });
    expect((await t.h.POST(r)).status).toBe(401); // no 413: ni siquiera se midió
    expect(r.bodyUsed).toBe(false);
  });
  it("con secreto bueno el cuerpo sí se consume", async () => {
    const t = harness();
    const r = new Request("http://localhost:3000/api/telegram", { method: "POST", headers: { ...ipHeader(), ...secretHeader() }, body: JSON.stringify(body) });
    await t.h.POST(r);
    expect(r.bodyUsed).toBe(true);
  });

  it("cuerpo demasiado grande → 413 sin procesar (por Content-Length o por bytes leídos)", async () => {
    const t = harness();
    const big = "x".repeat(MAX_BODY + 1);
    expect((await t.post(null, { raw: big })).status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await t.h.POST(new Request("http://localhost:3000/api/telegram", { method: "POST", headers: { ...ipHeader(), ...secretHeader() }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(t.handle).not.toHaveBeenCalled();
  });
  it("cuerpo justo en el tope se acepta", async () => {
    const t = harness();
    const raw = JSON.stringify({ update_id: 1, pad: "x".repeat(MAX_BODY - 40) });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_BODY);
    expect((await t.post(null, { raw })).status).toBe(200);
  });

  it("sin configuración → 503 sin detalles ni secretos, aunque el secreto sea el correcto; no cuenta como fallo", async () => {
    const t = harness({}, null);
    const headers = { "x-forwarded-for": "198.51.100.150" };
    for (let i = 0; i < 12; i++) {
      const res = await t.post(body, { headers });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).not.toContain("TELEGRAM");
      expect(text).not.toContain(TG.secret);
    }
    expect(t.after).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(logs.join("\n")).toContain("sin configuración válida");
    expect(logs.join("\n")).not.toContain(TG.secret);
    expect(logs.join("\n")).not.toContain(TG.token);
  });
});

describe("límites por IP: nunca antes de autenticar", () => {
  const body = textUpdate(2001, "hola");
  const fail = (t: ReturnType<typeof harness>, headers: Record<string, string>) => t.post(body, { headers, secret: "mal-secreto-inventado-0123456789abcdef" });

  it("10 secretos inválidos desde una IP → esa IP queda bloqueada (429 con Retry-After) para peticiones SIN secreto válido", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.200" };
    for (let i = 0; i < 10; i++) expect((await fail(t, headers)).status).toBe(401);
    const res = await fail(t, headers);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await t.post(body, { headers, secret: null })).status).toBe(429);
    expect((await fail(t, { "x-forwarded-for": "198.51.100.201" })).status).toBe(401); // otra IP no se ve afectada
  });

  it("una petición con el secreto VÁLIDO se procesa SIEMPRE, aunque su IP esté bloqueada o agotada (la IP de Telegram no se puede bloquear)", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(2, 60_000), failures: new RateLimiter(3, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.202" };
    for (let i = 0; i < 5; i++) await fail(t, headers);
    expect((await fail(t, headers)).status).toBe(429);
    const res = await t.post(textUpdate(2002, "hola"), { headers });
    expect(res.status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });

  it("anti-suplantación: se usa la ÚLTIMA entrada de X-Forwarded-For; poner la IP de Telegram al principio no bloquea a Telegram", async () => {
    const t = harness();
    const telegramIp = "149.154.167.10";
    // El atacante manda 10 peticiones falsas diciendo (al principio) que es Telegram; el proxy agrega su IP real al final.
    for (let i = 0; i < 10; i++) expect((await fail(t, { "x-forwarded-for": `${telegramIp}, 203.0.113.99` })).status).toBe(401);
    expect((await fail(t, { "x-forwarded-for": `${telegramIp}, 203.0.113.99` })).status).toBe(429); // el atacante sí queda bloqueado…
    expect((await fail(t, { "x-forwarded-for": telegramIp })).status).toBe(401); // …pero la IP de Telegram NO (ni siquiera sin secreto)
    expect((await t.post(body, { headers: { "x-forwarded-for": telegramIp } })).status).toBe(200);
  });

  it("el rate limit por IP no se aplica a peticiones autenticadas", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(3, 60_000), failures: new RateLimiter(10, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.203" };
    for (let i = 0; i < 12; i++) expect((await t.post(update(2100 + i, { text: undefined, sticker: { file_id: "x" } }), { headers })).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(12);
  });
  it("sí se aplica a las no autenticadas: tras el cupo, 429", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(3, 60_000), failures: new RateLimiter(100, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.204" };
    for (let i = 0; i < 3; i++) expect((await fail(t, headers)).status).toBe(401);
    expect((await fail(t, headers)).status).toBe(429);
  });
  it("los secretos válidos no cuentan como fallos", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.205" };
    for (let i = 0; i < 15; i++) expect((await t.post(update(2200 + i, { sticker: { file_id: "x" } }), { headers })).status).toBe(200);
    expect((await fail(t, headers)).status).toBe(401);
  });
});

describe("presupuesto de tiempo y after()", () => {
  const gate = () => {
    let release!: () => void;
    const p = new Promise<void>((r) => (release = r));
    return { p, release };
  };

  it("presupuesto agotado → responde 200 SIN esperar al handler y el trabajo termina en after()", async () => {
    const g = gate();
    const t = harness({ budgetMs: 30 });
    t.handle.mockImplementation(async (msg) => {
      t.events.push(`start:${msg.id}`);
      await g.p;
      t.events.push(`end:${msg.id}`);
    });
    const res = await t.post(textUpdate(3001, "pdf grande"));
    expect(res.status).toBe(200);
    expect(t.events).toEqual(["start:tg:3001"]); // el handler sigue corriendo
    expect(t.after).toHaveBeenCalledTimes(1);
    g.release();
    await t.flush(); // after(): espera a que termine
    expect(t.events).toEqual(["start:tg:3001", "end:tg:3001"]);
    expect(logs.join("\n")).toContain("presupuesto");
  });
  it("presupuesto agotado y after() lanza → igual 200 y el handler termina", async () => {
    const g = gate();
    const t = harness({ budgetMs: 20, after: () => { throw new Error("fuera de solicitud"); } });
    t.handle.mockImplementation(async () => {
      await g.p;
      t.events.push("fin");
    });
    const res = await t.post(textUpdate(3002, "x"));
    expect(res.status).toBe(200);
    g.release();
    await vi.waitFor(() => expect(t.events).toEqual(["fin"]));
  });
  it("dentro del presupuesto no se llama a after()", async () => {
    const t = harness({ budgetMs: 5000 });
    await t.post(textUpdate(3003, "x"));
    expect(t.after).not.toHaveBeenCalled();
  });
  it("un fallo del handler tras agotar el presupuesto nunca queda sin atrapar", async () => {
    const g = gate();
    const t = harness({ budgetMs: 20 });
    t.handle.mockImplementation(async () => {
      await g.p;
      throw new Error("x");
    });
    await t.post(textUpdate(3004, "x"));
    g.release();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.sent).toEqual([{ to: "111111111", body: GENERIC_ERROR }]);
  });
  it("si el proceso muere antes de responder, Telegram reintenta: el claim vuelve a decidir (no depende de after)", async () => {
    // Primera entrega: el handler nunca termina (proceso muerto). Segunda: llega el reintento y se reprocesa.
    let claims = 0;
    const t = harness({ budgetMs: 10, claim: async () => ++claims > 0 });
    t.handle.mockImplementationOnce(() => new Promise<void>(() => {})); // nunca resuelve
    expect((await t.post(textUpdate(3005, "x"))).status).toBe(200); // (aquí el presupuesto lo libera; en un crash real no habría respuesta)
    await t.post(textUpdate(3005, "x"));
    expect(t.handle).toHaveBeenCalledTimes(2);
  });
});

describe("remitentes y tipos de contenido", () => {
  it("NO autorizado → ignorado SIN responder, sin fila, sin claim y con id enmascarado en el log", async () => {
    const claim = vi.fn(async () => true);
    const t = harness({ claim });
    const res = await t.post(update(4001, { text: "dame tus datos", from: user(TG.intruso), chat: privateChat(TG.intruso) }));
    expect(res.status).toBe(200);
    expect(t.handle).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
    const all = logs.join("\n");
    expect(all).toContain("***9999");
    expect(all).not.toContain(String(TG.intruso));
    expect(all).not.toContain("dame tus datos");
  });
  it("un intruso en un GRUPO con un comando que no es /id tampoco recibe respuesta", async () => {
    const t = harness();
    await t.post(groupText(4002, "/resumen", TG.intruso));
    await t.post(groupText(4003, "350 starbucks", TG.intruso));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });
  it("no se puede suplantar con un id parecido (prefijo/sufijo)", async () => {
    const t = harness();
    for (const id of [11111111, 1111111111, 111111112]) await t.post(update(4010 + id % 7, { text: "hola", from: user(id), chat: privateChat(id) }));
    expect(t.handle).not.toHaveBeenCalled();
  });
  it("documento, foto, voz y otros tipos llegan al handler con su tipo y se registran con su kind", async () => {
    const t = harness();
    await t.post(update(4101, { document: { file_id: "BQACAgQAAxkBAAIB-doc", mime_type: "application/pdf", file_name: "estado.pdf", file_size: 2000 } }));
    await t.post(update(4102, { photo: [{ file_id: "foto-chica-0123", file_size: 10 }, { file_id: "foto-grande-0123", file_size: 100 }] }));
    await t.post(update(4103, { voice: { file_id: "voz-0123456789", mime_type: "audio/ogg" } }));
    await t.post(update(4104, { sticker: { file_id: "sticker-01234" } }));
    expect(t.handled.map((h) => [h.msg.id, h.msg.type, h.msg.media?.id])).toEqual([
      ["tg:4101", "document", "BQACAgQAAxkBAAIB-doc"], ["tg:4102", "image", "foto-grande-0123"], ["tg:4103", "audio", "voz-0123456789"], ["tg:4104", "other", undefined],
    ]);
    expect((await rows()).map((r) => [r.msg_id, r.kind])).toEqual([["tg:4101", "document"], ["tg:4102", "image"], ["tg:4103", "audio"], ["tg:4104", "other"]]);
  });
  it.each([
    ["edited_message", { update_id: 4201, edited_message: { message_id: 1, from: user(TG.uziel), chat: privateChat(TG.uziel), date: 1, text: "x" } }],
    ["channel_post", { update_id: 4202, channel_post: { message_id: 1, chat: { id: -1009, type: "channel" }, date: 1, text: "x" } }],
    ["callback_query", { update_id: 4203, callback_query: { id: "1", from: user(TG.uziel), data: "x" } }],
    ["my_chat_member", { update_id: 4204, my_chat_member: { chat: groupChat(), from: user(TG.uziel) } }],
    ["mensaje de un bot", update(4205, { text: "hola", from: user(777, { is_bot: true }) })],
    ["mensaje de canal", update(4206, { text: "hola", chat: { id: -1009, type: "channel" } })],
    ["sin from", update(4207, { text: "hola", from: undefined })],
  ])("%s → 200 y nada se procesa ni se responde", async (_n, body) => {
    const t = harness();
    expect((await t.post(body)).status).toBe(200);
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });
  it("comandos: /ayuda y /resumen llegan al handler como palabra; /resumen@OtroBot en un grupo se ignora si el bot es conocido", async () => {
    const t = harness({}, getTelegramConfig({ ...TG_ENV, TELEGRAM_BOT_USERNAME: TG.botUsername }));
    await t.post(textUpdate(4301, "/ayuda"));
    await t.post(textUpdate(4302, `/resumen@${TG.botUsername}`));
    await t.post(update(4303, { text: "/resumen@OtroBot", chat: groupChat() }));
    expect(t.handled.map((h) => h.msg.text)).toEqual(["ayuda", "resumen"]);
  });
});

describe("/id y modo descubrimiento", () => {
  it("un NO autorizado que pide /id recibe SOLO su id; no pasa por el handler y no deja fila", async () => {
    const t = harness();
    const res = await t.post(update(5001, { text: "/id", from: user(TG.intruso), chat: privateChat(TG.intruso) }));
    expect(res.status).toBe(200);
    expect(t.sent).toEqual([{ to: "999999999", body: "Tu ID de Telegram es 999999999." }]);
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(logs.join("\n")).not.toContain("999999999");
    expect(logs.join("\n")).toContain("***9999");
  });
  it("en un grupo responde en el grupo con el id del usuario Y el del chat (negativo)", async () => {
    const t = harness();
    await t.post(groupText(5002, "/id", TG.intruso));
    expect(t.sent).toEqual([{ to: String(TG.group), body: `Tu ID de Telegram es 999999999.\nEl ID de este chat es ${TG.group}.` }]);
    expect(idReply("1", "-5", "group")).toContain("-5");
  });
  it("un autorizado que pide /id también recibe solo el id (no llega al handler)", async () => {
    const t = harness();
    await t.post(textUpdate(5003, "/id"));
    await t.post(textUpdate(5004, "/ID@UnBot extra"));
    expect(t.sent.map((s) => s.body)).toEqual(["Tu ID de Telegram es 111111111.", "Tu ID de Telegram es 111111111."]);
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it("/id@OtroBot con el usuario del bot conocido se ignora; el propio responde", async () => {
    const t = harness({}, getTelegramConfig({ ...TG_ENV, TELEGRAM_BOT_USERNAME: TG.botUsername }));
    await t.post(groupText(5005, "/id@OtroBot", TG.intruso));
    expect(t.sent).toEqual([]);
    await t.post(groupText(5006, `/id@${TG.botUsername}`, TG.intruso));
    expect(t.sent).toHaveLength(1);
  });
  it("las respuestas a /id tienen tope por usuario (no se usa al bot como amplificador)", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(600, 60_000), failures: new RateLimiter(10, 600_000), idPerUser: new RateLimiter(2, 60_000) } });
    for (let i = 0; i < 5; i++) await t.post(update(5100 + i, { text: "/id", from: user(TG.intruso), chat: privateChat(TG.intruso) }));
    expect(t.sent).toHaveLength(2);
    await t.post(update(5110, { text: "/id", from: user(888888888), chat: privateChat(888888888) }));
    expect(t.sent).toHaveLength(3); // otro usuario no se ve afectado
  });
  it("modo descubrimiento (TELEGRAM_ALLOWED vacía): solo /id responde; todo lo demás se ignora sin filas", async () => {
    const t = harness({}, getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED: "" }));
    await t.post(textUpdate(5201, "ayuda"));
    await t.post(textUpdate(5202, "/ayuda"));
    await t.post(textUpdate(5203, "350 starbucks"));
    await t.post(update(5204, { document: { file_id: "BQACAgQAAxkBAAIB-doc" } }));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    await t.post(textUpdate(5205, "/id"));
    expect(t.sent).toEqual([{ to: "111111111", body: "Tu ID de Telegram es 111111111." }]);
    expect(await rows()).toEqual([]);
  });
});

describe("grupos", () => {
  it("el handler recibe replyTo = chat del grupo, el estado va por remitente y los errores se responden al grupo", async () => {
    const t = harness({}, GCFG);
    await t.post(groupText(6001, "/hoy", TG.uziel));
    await t.post(groupReply(6002, "120 oxxo", TG.ana));
    expect(t.handled.map((h) => [h.msg.from, h.msg.replyTo, h.sender.name])).toEqual([
      ["tg111111111", String(TG.group), "Uziel"], ["tg222222222", String(TG.group), "Ana"],
    ]);
    expect((await rows()).map((r) => r.wa_id)).toEqual(["tg111111111", "tg222222222"]); // llave de estado por persona, no por grupo
    t.handle.mockRejectedValueOnce(new Error("x"));
    await t.post(groupText(6003, "/hoy"));
    expect(t.sent).toEqual([{ to: String(TG.group), body: GENERIC_ERROR }]);
  });
  it("el mismo usuario en dos chats conserva su llave de remitente", async () => {
    const t = harness({}, GCFG);
    await t.post(textUpdate(6010, "a"));
    await t.post(groupText(6011, "/hoy"));
    expect(t.handled.map((h) => h.msg.from)).toEqual(["tg111111111", "tg111111111"]);
  });
  it("sin TELEGRAM_ALLOWED_CHATS (por omisión) el grupo se ignora por completo: ni comandos, ni respuestas, ni filas; /id sí responde", async () => {
    const t = harness(); // CFG: sin chats permitidos
    for (const [i, text] of ["/resumen", "/hoy", "/tarjetas", "350 starbucks", "nos vemos a las 8"].entries()) await t.post(groupText(6100 + i, text));
    await t.post(groupReply(6110, "amex"));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
    await t.post(groupText(6111, "/id", TG.intruso));
    expect(t.sent).toEqual([{ to: String(TG.group), body: `Tu ID de Telegram es 999999999.\nEl ID de este chat es ${TG.group}.` }]);
  });
  it("otro grupo que no es el permitido tampoco se atiende", async () => {
    const t = harness({}, GCFG);
    await t.post(groupText(6120, "/resumen", TG.uziel, -1009999999));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });
  it("chat permitido: la plática ('nos vemos a las 8', montos sueltos, 'sí') se ignora SIN responder ni dejar fila", async () => {
    const t = harness({}, GCFG);
    for (const [i, text] of ["nos vemos a las 8", "350 starbucks amex", "sí", "jajaja", "hola a todos"].entries()) await t.post(groupText(6200 + i, text));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
  });
  it("chat permitido: comando, mención y respuesta al bot sí se procesan; la mención se quita del texto", async () => {
    const t = harness({}, GCFG);
    await t.post(groupText(6300, "/resumen"));
    await t.post(groupText(6301, `@${TG.botUsername} 350 starbucks amex`));
    await t.post(groupReply(6302, "amex"));
    expect(t.handled.map((h) => h.msg.text)).toEqual(["resumen", "350 starbucks amex", "amex"]);
  });
  it("una mención o respuesta de un NO autorizado dentro del grupo permitido se ignora sin responder", async () => {
    const t = harness({}, GCFG);
    await t.post(groupText(6310, `@${TG.botUsername} resumen`, TG.intruso));
    await t.post(groupReply(6311, "resumen", TG.intruso));
    await t.post(groupText(6312, "/resumen", TG.intruso));
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
  });
  it("en grupo, 'no entendí' y 'no tengo nada pendiente' se descartan; en privado sí se contestan; otras respuestas pasan", async () => {
    const t = harness({}, GCFG);
    t.handle.mockImplementation(async (msg, _s, io) => {
      const to = msg.replyTo!;
      if (msg.text === "x1") await io.sendText(to, NOT_UNDERSTOOD);
      else if (msg.text === "x2") await io.sendText(to, OUT_OF_CONTEXT);
      else await io.sendText(to, "Registrado ✅");
    });
    await t.post(groupText(6400, "/x1"));
    await t.post(groupText(6401, "/x2"));
    expect(t.sent).toEqual([]);
    await t.post(groupText(6402, "/x3"));
    expect(t.sent).toEqual([{ to: String(TG.group), body: "Registrado ✅" }]);
    t.sent.length = 0;
    await t.post(textUpdate(6403, "x1")); // privado: igual que siempre
    expect(t.sent).toEqual([{ to: "111111111", body: NOT_UNDERSTOOD }]);
  });
  it("groupQuietIO delega downloadMedia y el resto de sendText", async () => {
    const sent: string[] = [];
    const io = groupQuietIO({ sendText: async (_to, b) => void sent.push(b), downloadMedia: async () => ({ bytes: new Uint8Array([1]), mimeType: "application/pdf" }) });
    await io.sendText("1", "hola");
    await io.sendText("1", NOT_UNDERSTOOD);
    expect(sent).toEqual(["hola"]);
    expect((await io.downloadMedia("f", 10)).mimeType).toBe("application/pdf");
  });
  it("mensajes privados: no cambian (sin comando ni mención se procesan)", async () => {
    const t = harness();
    await t.post(textUpdate(6500, "350 starbucks amex"));
    expect(t.handled.map((h) => h.msg.text)).toEqual(["350 starbucks amex"]);
  });
  it("un PDF en el grupo solo se atiende si responde al bot o lo menciona en el pie", async () => {
    const t = harness({}, GCFG);
    const doc = { file_id: "BQACAgQAAxkBAAIB-doc", file_name: "e.pdf", mime_type: "application/pdf" };
    await t.post(update(6600, { document: doc, chat: groupChat() }));
    expect(t.handle).not.toHaveBeenCalled();
    await t.post(update(6601, { document: doc, chat: groupChat(), reply_to_message: { message_id: 1, from: botUser() } }));
    await t.post(update(6602, { document: doc, chat: groupChat(), caption: `@${TG.botUsername}` }));
    expect(t.handled.map((h) => h.msg.type)).toEqual(["document", "document"]);
  });
});

describe("mensaje en vuelo (reintento de Telegram dentro de la ventana de 120 s)", () => {
  const body = () => textUpdate(8001, "350 starbucks");

  it("fila `received` RECIENTE (el proceso murió a media ejecución) → 503 con Retry-After: 5, sin procesar ni responder al usuario", async () => {
    const t = harness();
    await claimMessage("tg:8001", "tg111111111", "text"); // el primer intento lo reclamó y murió sin cerrar
    const res = await t.post(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await res.json())).not.toMatch(/8001|350|starbucks/);
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect((await rows())[0].status).toBe("received");
  });
  it("el reintento posterior a la ventana (stale) sí se procesa → 200; el siguiente ya es duplicado", async () => {
    const t = harness();
    await claimMessage("tg:8001", "tg111111111", "text");
    expect((await t.post(body())).status).toBe(503);
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(SECOND, -121, SYSUTCDATETIME()) WHERE msg_id = 'tg:8001'");
    t.handle.mockImplementation(async (msg) => void (await finishMessage(msg.id, "done")));
    expect((await t.post(body())).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
    expect((await t.post(body())).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it.each(["done", "failed", "ignored"] as const)("fila '%s' → 200 duplicado sin procesar", async (status) => {
    const t = harness();
    await claimMessage("tg:8001", "tg111111111", "text");
    await finishMessage("tg:8001", status);
    const res = await t.post(body());
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(t.handle).not.toHaveBeenCalled();
  });
  it("carrera de dos reintentos simultáneos sobre una fila vencida: uno procesa (200), el otro 503", async () => {
    const t = harness();
    await claimMessage("tg:8001", "tg111111111", "text");
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(MINUTE, -3, SYSUTCDATETIME()) WHERE msg_id = 'tg:8001'");
    t.handle.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 50)));
    const res = await Promise.all([t.post(body()), t.post(body())]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("carrera de dos entregas simultáneas de un update NUEVO: uno procesa (200), el otro 503", async () => {
    const t = harness();
    t.handle.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 50)));
    const res = await Promise.all([t.post(body()), t.post(body())]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("con claim falso: 'inflight' → 503; 'done' → 200; 'new'/'stale' → se procesa", async () => {
    for (const [state, status, handled] of [["inflight", 503, 0], ["done", 200, 0], ["new", 200, 1], ["stale", 200, 1]] as const) {
      const t = harness({ claimState: async () => state });
      expect((await t.post(body())).status).toBe(status);
      expect(t.handle).toHaveBeenCalledTimes(handled);
    }
  });
  it("varios updates en un POST: los demás se procesan y, si alguno está en vuelo, el POST responde 503", async () => {
    const t = harness({ claimState: async (id) => (id === "tg:8102" ? "inflight" : "new") });
    const res = await t.post([textUpdate(8101, "a"), textUpdate(8102, "b"), textUpdate(8103, "c")]);
    expect(res.status).toBe(503);
    expect(t.handled.map((h) => h.msg.id)).toEqual(["tg:8101", "tg:8103"]);
  });
  it("si el presupuesto se agota antes de ver el en vuelo, ya se respondió 200", async () => {
    const t = harness({ budgetMs: 10, claimState: async () => new Promise((r) => setTimeout(() => r("inflight"), 80)) });
    expect((await t.post(body())).status).toBe(200);
    await t.flush();
  });
  it("el 503 por update en vuelo no cuenta contra los límites por IP (secreto válido)", async () => {
    const t = harness({ claimState: async () => "inflight", limiters: { perIp: new RateLimiter(1, 60_000), failures: new RateLimiter(1, 60_000) } });
    for (let i = 0; i < 4; i++) expect((await t.post(body())).status).toBe(503);
  });
});

describe("idempotencia y errores", () => {
  it("el mismo update dos veces (reintento de Telegram) → una sola ejecución", async () => {
    const t = harness();
    t.handle.mockImplementation(async (msg) => void (await finishMessage(msg.id, "done"))); // como el handler real: cierra el mensaje
    const b = textUpdate(7001, "350 starbucks");
    expect((await t.post(b)).status).toBe(200);
    expect((await t.post(b)).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });
  it("el mismo update repetido dentro de un POST (arreglo) → una sola ejecución", async () => {
    const t = harness();
    await t.post([textUpdate(7002, "a"), textUpdate(7002, "a")]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("POST concurrentes con el mismo update → una sola ejecución", async () => {
    const t = harness();
    const b = textUpdate(7003, "a");
    await Promise.all([t.post(b), t.post(b), t.post(b)]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("si el handler lanza → mensaje genérico al usuario, fila en failed; luego el reintento no se reprocesa", async () => {
    const t = harness();
    t.handle.mockImplementationOnce(async () => {
      throw new Error("detalle interno con datos 350 starbucks");
    });
    const res = await t.post(textUpdate(7004, "350 starbucks"));
    expect(res.status).toBe(200);
    expect(t.sent).toEqual([{ to: "111111111", body: GENERIC_ERROR }]);
    expect(t.sent[0].body).not.toContain("starbucks");
    expect(await rows()).toEqual([{ msg_id: "tg:7004", wa_id: "tg111111111", kind: "text", status: "failed" }]);
    await t.post(textUpdate(7004, "350 starbucks"));
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("si finishMessage también falla, igual responde el error genérico", async () => {
    const t = harness({ finish: async () => { throw new Error("db caída"); } });
    t.handle.mockRejectedValueOnce(new Error("x"));
    await t.post(textUpdate(7005, "a"));
    expect(t.sent).toEqual([{ to: "111111111", body: GENERIC_ERROR }]);
  });
  it("si no se puede registrar el mensaje (base caída) → avisa que reenvíe; no procesa; el intruso no recibe nada", async () => {
    const t = harness({ claim: async () => { throw new Error("Failed to connect"); } });
    const res = await t.post([textUpdate(7006, "a"), update(7007, { text: "b", from: user(TG.intruso), chat: privateChat(TG.intruso) })]);
    expect(res.status).toBe(200);
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([{ to: "111111111", body: BUSY_ERROR }]);
  });
  it("sendText que lanza no tumba el procesamiento ni la respuesta 200", async () => {
    const t = harness({ io: () => ({ sendText: async () => { throw new Error("red"); }, downloadMedia: async () => { throw new Error("x"); } }) });
    t.handle.mockRejectedValueOnce(new Error("x"));
    const res = await t.post(textUpdate(7008, "a"));
    expect(res.status).toBe(200);
  });
  it("varios updates en un POST se procesan en SERIE y en orden", async () => {
    const t = harness();
    let running = 0, maxRunning = 0;
    const order: string[] = [];
    t.handle.mockImplementation(async (msg) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${msg.id}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${msg.id}`);
      running--;
    });
    await t.post([textUpdate(7101, "a"), textUpdate(7102, "b"), textUpdate(7103, "c")]);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start:tg:7101", "end:tg:7101", "start:tg:7102", "end:tg:7102", "start:tg:7103", "end:tg:7103"]);
  });
  it("tope de 50 updates por POST", async () => {
    const t = harness();
    await t.post(Array.from({ length: 60 }, (_, i) => textUpdate(7200 + i, "a")));
    expect(t.handle).toHaveBeenCalledTimes(50);
  });
  it("después de un update que revienta, los demás del mismo POST siguen", async () => {
    const t = harness();
    t.handle.mockRejectedValueOnce(new Error("x"));
    await t.post([textUpdate(7301, "a"), textUpdate(7302, "b")]);
    expect(t.handled.map((h) => h.msg.id)).toEqual(["tg:7302"]);
  });
});

describe("payload raro con el secreto válido → siempre 200", () => {
  it.each([
    ["JSON inválido", "{no json"],
    ["cuerpo vacío", ""],
    ["null", "null"],
    ["arreglo vacío", "[]"],
    ["texto", '"hola"'],
    ["número", "42"],
    ["objeto vacío", "{}"],
    ["update_id de tipo erróneo", '{"update_id":"1","message":{"text":"x"}}'],
    ["message de tipo erróneo", '{"update_id":1,"message":"x"}'],
    ["chat sin tipo", '{"update_id":1,"message":{"from":{"id":111111111},"chat":{"id":5},"text":"x"}}'],
    ["UTF-8 inválido", "\u0000\u0001�"],
  ])("%s", async (_n, raw) => {
    const t = harness();
    const res = await t.post(null, { raw });
    expect(res.status).toBe(200);
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});

describe("higiene de logs", () => {
  it("nada de textos, ids completos, secretos, tokens ni nombres en los logs, en ningún escenario", async () => {
    const t = harness();
    const text = "gasto secreto 777 farmacia-inventada";
    await t.post(textUpdate(8001, text));
    await t.post(update(8002, { text, from: user(TG.intruso), chat: privateChat(TG.intruso) }));
    await t.post(update(8003, { text: "/id", from: user(TG.intruso, { first_name: "Nombre Hostil" }), chat: privateChat(TG.intruso) }));
    await t.post(textUpdate(8004, text), { secret: "intento-falso-inventado-0123456789abcdefgh" });
    await t.post("{no json " + text);
    t.handle.mockRejectedValueOnce(new Error("falla controlada"));
    await t.post(update(8005, { text, from: user(TG.ana), chat: privateChat(TG.ana) }));
    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [text, "farmacia-inventada", String(TG.uziel), String(TG.ana), String(TG.intruso), TG.secret, TG.token, TG.token.split(":")[1], "Nombre Inventado", "Nombre Hostil", "Uziel", "Ana", "intento-falso"]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("rutas reales (/api/telegram) y Easy Auth", () => {
  const url = "/api/telegram";
  const stubFetch = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("¡red real en pruebas!"); }));
  afterEach(() => vi.unstubAllGlobals());
  const post = (body: unknown, headers: Record<string, string> = {}) => routePost(req(url, { method: "POST", body, headers: { ...ipHeader(), ...headers } }));

  it("GET → 405 (la ruta existe pero solo acepta POST), sin sesión de Easy Auth", async () => {
    const res = await routeGet();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
  it("POST sin el secreto → 401 aunque venga con sesión válida de Easy Auth (la sesión no sustituye al secreto)", async () => {
    stubFetch();
    const res = await post(textUpdate(9001, "hola"), authed());
    expect(res.status).toBe(401);
    expect(await rows()).toEqual([]);
  });
  it("POST con el secreto bueno SIN sesión → 200; un remitente no autorizado se ignora: sin red y sin filas", async () => {
    stubFetch();
    const res = await post(update(9002, { text: "hola", from: user(TG.intruso), chat: privateChat(TG.intruso) }), secretHeader());
    expect(res.status).toBe(200);
    await flushTelegramWork();
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it("POST con el secreto bueno y un update ignorable → 200 y nada pasa", async () => {
    stubFetch();
    const res = await post({ update_id: 9003, edited_message: { text: "x" } }, secretHeader());
    expect(res.status).toBe(200);
    await flushTelegramWork();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sin configuración en el entorno la ruta real falla cerrado (503) y solo nombra la variable", async () => {
    const saved = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    try {
      expect((await post(textUpdate(9004, "a"), secretHeader())).status).toBe(503);
      expect(logs.join("\n")).toContain("TELEGRAM_WEBHOOK_SECRET");
      expect(logs.join("\n")).not.toContain(TG.secret);
    } finally {
      process.env.TELEGRAM_WEBHOOK_SECRET = saved;
    }
  });
  it("un solo secreto vale para esta ruta: el de WhatsApp o el token del bot no sirven", async () => {
    stubFetch();
    for (const s of [TG.token, "x".repeat(40)]) expect((await post(textUpdate(9005, "a"), secretHeader(s))).status).toBe(401);
  });

  const px = (path: string, headers: Record<string, string> = {}, method = "POST") => proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers }));
  it("el proxy NO exige Easy Auth en /api/telegram (ni reemite la cookie) pero sí en el resto de /api", () => {
    const tg = px("/api/telegram");
    expect(tg.status).toBe(200);
    expect(tg.headers.get("x-middleware-next")).toBe("1");
    expect(tg.headers.get("set-cookie")).toBeNull();
    expect(px("/api/telegram", {}, "GET").status).toBe(200);
    expect(px("/api/transactions", {}, "GET").status).toBe(401);
    expect(px("/api/telegram/otra").status).toBe(401); // solo la ruta exacta queda fuera
    expect(px("/api/telegram/").status).toBe(401);
    expect(px("/api/telegramx").status).toBe(401);
    expect(px("/api/whatsapp").status).toBe(200);
    expect(px("/api/ingest").status).toBe(200);
  });
});
