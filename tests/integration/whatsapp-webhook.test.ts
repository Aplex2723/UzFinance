import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as routeGet, POST as routePost } from "@/app/api/whatsapp/route";
import { closePool, query } from "@/lib/db/pool";
import { proxy } from "@/proxy";
import { RateLimiter } from "@/lib/security/ratelimit";
import { whatsappFailures, whatsappPerIp } from "@/lib/security/ingest-limiters";
import { getWhatsAppConfig, type WhatsAppConfig } from "@/lib/whatsapp/config";
import { claimMessage, claimMessageState, finishMessage } from "@/lib/repo/whatsapp";
import { handleInbound } from "@/lib/whatsapp/handler";
import { TOO_OLD } from "@/lib/whatsapp/replies";
import { BUSY_ERROR, createWebhookHandlers, flushWebhookWork, GENERIC_ERROR, MAX_BODY, resetConfigWarning, type WebhookDeps } from "@/lib/whatsapp/webhook";
import type { HandleDeps, InboundMessage, Sender, WhatsAppIO } from "@/lib/whatsapp/types";
import { authed, req, resetDb } from "../helpers";
import { signed, textMsg, WA, WA_ENV, webhookBody } from "../wa-webhook-fixtures";

const APP_HOST = "uz-inventada.azurewebsites.net";
const CFG = getWhatsAppConfig({ ...WA_ENV, WEBSITE_HOSTNAME: APP_HOST })!;

let n = 0;
const ipHeader = () => ({ "x-forwarded-for": `198.51.100.${(++n % 250) + 1}:5000` });

type Handled = { msg: InboundMessage; sender: Sender; deps: HandleDeps & { appUrl?: string } };

function harness(over: Partial<WebhookDeps> = {}, cfg: WhatsAppConfig | null = CFG) {
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
  const h = createWebhookHandlers({ config: () => cfg, io: () => io, handle, after, ...over });
  const flush = async () => {
    while (queue.length) await queue.shift()!();
  };

  /** POST firmado correctamente (salvo que se pida otra cosa). */
  const post = (body: unknown, opts: { raw?: string; headers?: Record<string, string>; sign?: boolean; secret?: string } = {}) => {
    const raw = opts.raw ?? (typeof body === "string" ? body : JSON.stringify(body));
    const headers = { ...ipHeader(), ...(opts.sign === false ? {} : signed(raw, opts.secret)), ...opts.headers };
    return h.POST(new Request("http://localhost:3000/api/whatsapp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }));
  };
  const get = (params: Record<string, string>, headers: Record<string, string> = ipHeader()) =>
    h.GET(new Request(`http://localhost:3000/api/whatsapp?${new URLSearchParams(params)}`, { headers }));
  return { h, queue, sent, handled, events, handle, after, post, get, flush, io };
}

const verifyParams = (over: Record<string, string> = {}) => ({ "hub.mode": "subscribe", "hub.verify_token": WA.verifyToken, "hub.challenge": "1158201444", ...over });
const rows = () => query<{ msg_id: string; wa_id: string; kind: string; status: string }>("SELECT msg_id, wa_id, kind, status FROM dbo.whatsapp_messages ORDER BY msg_id");

let logs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of [...Object.keys(WA_ENV), "WEBSITE_HOSTNAME", "APP_URL", "WHATSAPP_GRAPH_VERSION"]) savedEnv[k] = process.env[k];
  Object.assign(process.env, WA_ENV, { WEBSITE_HOSTNAME: APP_HOST });
  delete process.env.APP_URL;
  delete process.env.WHATSAPP_GRAPH_VERSION;
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
  whatsappPerIp.reset();
  whatsappFailures.reset();
  resetConfigWarning();
  logs = [];
  const grab = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

describe("GET: verificación del webhook por Meta", () => {
  it("modo y token correctos → 200 con el challenge como text/plain", async () => {
    const { get } = harness();
    const res = await get(verifyParams());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("1158201444");
  });
  it.each([
    ["token incorrecto", { "hub.verify_token": "otro-token-inventado-0123456789" }],
    ["token casi correcto", { "hub.verify_token": WA.verifyToken + "0" }],
    ["token vacío", { "hub.verify_token": "" }],
    ["modo distinto", { "hub.mode": "unsubscribe" }],
    ["modo ausente", { "hub.mode": "" }],
    ["challenge ausente", { "hub.challenge": "" }],
    ["challenge con HTML", { "hub.challenge": "<script>alert(1)</script>" }],
  ])("%s → 403 sin eco", async (_n, over) => {
    const { get } = harness();
    const res = await get(verifyParams(over));
    expect(res.status).toBe(403);
    const t = await res.text();
    expect(t).not.toContain("script");
    expect(t).not.toContain(WA.verifyToken);
  });
  it("sin parámetros → 403", async () => {
    expect((await harness().get({})).status).toBe(403);
  });
  it("sin configuración → 503 sin detalles", async () => {
    const res = await harness({}, null).get(verifyParams());
    expect(res.status).toBe(503);
    const t = await res.text();
    expect(t).not.toContain("WHATSAPP");
    expect(t).not.toContain(WA.verifyToken);
  });
  it("verificaciones fallidas repetidas bloquean la IP (429) para quien siga con el token malo; otra IP no se ve afectada", async () => {
    const { get } = harness();
    const headers = { "x-forwarded-for": "198.51.100.200" };
    for (let i = 0; i < 10; i++) expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), headers)).status).toBe(403);
    expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), headers)).status).toBe(429);
    expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), { "x-forwarded-for": "198.51.100.201" })).status).toBe(403);
  });
  it("un verify token CORRECTO nunca se bloquea por IP (la IP de Meta no se puede bloquear con intentos falsos)", async () => {
    const { get } = harness({ limiters: { perIp: new RateLimiter(2, 60_000), failures: new RateLimiter(3, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.202" };
    for (let i = 0; i < 6; i++) await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), headers);
    expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), headers)).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await get(verifyParams(), headers)).status).toBe(200);
  });
  it("anti-suplantación en GET: se usa la ÚLTIMA entrada de X-Forwarded-For", async () => {
    const { get } = harness();
    const metaIp = "173.252.88.10";
    for (let i = 0; i < 10; i++) expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), { "x-forwarded-for": `${metaIp}, 203.0.113.99` })).status).toBe(403);
    expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), { "x-forwarded-for": `${metaIp}, 203.0.113.99` })).status).toBe(429); // el atacante
    expect((await get(verifyParams({ "hub.verify_token": "x".repeat(20) }), { "x-forwarded-for": metaIp })).status).toBe(403); // Meta: no bloqueada
    expect((await get(verifyParams(), { "x-forwarded-for": metaIp })).status).toBe(200);
  });
  it("token correcto pero modo o challenge inválidos → 403 sin contar como fallo de IP", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(100, 60_000), failures: new RateLimiter(2, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.203" };
    for (let i = 0; i < 5; i++) expect((await t.get(verifyParams({ "hub.mode": "unsubscribe" }), headers)).status).toBe(403);
    expect((await t.get(verifyParams(), headers)).status).toBe(200);
  });
});

describe("POST: firma obligatoria", () => {
  const body = webhookBody([textMsg("wamid.SIG1", "hola")]);

  it("firma válida → se procesa ANTES de responder: auth → claim → handle → 200", async () => {
    const events: string[] = [];
    const t = harness({
      claim: async (id, w, k) => {
        events.push("claim");
        return claimMessage(id, w, k);
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
    expect(await rows()).toEqual([{ msg_id: "wamid.SIG1", wa_id: WA.alex, kind: "text", status: "received" }]);
  });
  it("claim falso: el handler solo corre si claim devolvió true", async () => {
    const claim = vi.fn(async () => true);
    const t = harness({ claim });
    await t.post(body);
    expect(claim).toHaveBeenCalledWith("wamid.SIG1", WA.alex, "text");
    expect(t.handle).toHaveBeenCalledTimes(1);
    const t2 = harness({ claim: async () => false });
    await t2.post(body);
    expect(t2.handle).not.toHaveBeenCalled();
  });
  it("claim devolviendo true de nuevo (fila `received` vencida → reintento de Meta) reprocesa el mensaje", async () => {
    const t = harness({ claim: async () => true });
    await t.post(body);
    await t.post(body);
    expect(t.handle).toHaveBeenCalledTimes(2);
  });
  it("el handler recibe el mensaje, el remitente autorizado, now = hora REAL de proceso (no la del mensaje) + appUrl", async () => {
    const t = harness();
    const before = Date.now();
    await t.post(webhookBody([textMsg("wamid.CTX", "350 starbucks", WA.sam, 1790000123)]));
    expect(t.handled).toHaveLength(1);
    const h = t.handled[0];
    expect(h.msg).toEqual({ id: "wamid.CTX", from: WA.sam, timestamp: 1790000123, type: "text", text: "350 starbucks" });
    expect(h.sender).toEqual({ waId: WA.sam, name: "Sam" });
    // La guarda de 48 h del handler depende de que `now` NO sea la hora del mensaje.
    expect(h.deps.now).toBeInstanceOf(Date);
    expect(h.deps.now!.getTime()).toBeGreaterThanOrEqual(before);
    expect(h.deps.now!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(h.deps.now!.getTime()).not.toBe(1790000123 * 1000);
    expect(h.deps.appUrl).toBe(`https://${APP_HOST}`);
    expect(t.sent).toEqual([]); // la respuesta es asunto del handler
  });
  it("con el handler REAL, un mensaje de hace más de 48 h se rechaza (la guarda de 48 h funciona porque `now` es la hora real)", async () => {
    const t = harness({ handle: handleInbound });
    const old = Math.floor(Date.now() / 1000) - 3 * 24 * 3600;
    const res = await t.post(webhookBody([textMsg("wamid.OLD", "350 starbucks", WA.alex, old)]));
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].body).toBe(TOO_OLD);
  });
  it("sin appUrl configurada no se pasa appUrl", async () => {
    const t = harness({}, getWhatsAppConfig(WA_ENV));
    await t.post(body);
    await t.flush();
    expect(t.handled[0].deps).not.toHaveProperty("appUrl");
  });
  it.each([
    ["ausente", { sign: false }],
    ["secreto equivocado", { secret: "otro-secreto-inventado-0123456789abc" }],
    ["sin prefijo", { sign: false, headers: { "x-hub-signature-256": "a".repeat(64) } }],
    ["prefijo sha1", { sign: false, headers: { "x-hub-signature-256": "sha1=" + "a".repeat(40) } }],
    ["vacía", { sign: false, headers: { "x-hub-signature-256": "" } }],
    ["longitud distinta", { sign: false, headers: { "x-hub-signature-256": "sha256=abcd" } }],
  ] as [string, Parameters<ReturnType<typeof harness>["post"]>[1]][])("firma %s → 401 y NO se procesa", async (_n, opts) => {
    const t = harness();
    const res = await t.post(body, opts);
    expect(res.status).toBe(401);
    expect(t.after).not.toHaveBeenCalled();
    await t.flush();
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(await res.text()).not.toContain("wamid");
  });
  it("cuerpo alterado después de firmar → 401", async () => {
    const t = harness();
    const raw = JSON.stringify(body);
    const res = await t.post(null, { raw: raw.replace("hola", "holo"), headers: signed(raw), sign: false });
    expect(res.status).toBe(401);
    expect(t.after).not.toHaveBeenCalled();
  });
  it("la firma cubre bytes crudos: el mismo JSON con otros espacios no vale", async () => {
    const t = harness();
    const compact = JSON.stringify(body);
    const res = await t.post(null, { raw: JSON.stringify(body, null, 2), headers: signed(compact), sign: false });
    expect(res.status).toBe(401);
  });
  it("la firma se valida ANTES de parsear: JSON inválido con firma mala es 401, no 400", async () => {
    const t = harness();
    expect((await t.post("{no json", { sign: false, headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } })).status).toBe(401);
  });
  it("sin cabecera de firma el cuerpo NO se lee ni se mide (ni siquiera uno gigantesco)", async () => {
    const t = harness();
    const r = new Request("http://localhost:3000/api/whatsapp", { method: "POST", headers: ipHeader(), body: "x".repeat(MAX_BODY + 10) });
    expect((await t.h.POST(r)).status).toBe(401); // no 413
    expect(r.bodyUsed).toBe(false);
  });
  it("con firma buena el cuerpo sí se consume", async () => {
    const t = harness();
    const raw = JSON.stringify(body);
    const r = new Request("http://localhost:3000/api/whatsapp", { method: "POST", headers: { ...ipHeader(), ...signed(raw) }, body: raw });
    await t.h.POST(r);
    expect(r.bodyUsed).toBe(true);
  });
  it("cuerpo demasiado grande → 413 sin procesar (por Content-Length o por bytes leídos)", async () => {
    const t = harness();
    const big = "x".repeat(MAX_BODY + 1);
    expect((await t.post(null, { raw: big })).status).toBe(413);
    // Sin Content-Length confiable: stream que se pasa del tope.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await t.h.POST(new Request("http://localhost:3000/api/whatsapp", { method: "POST", headers: { ...ipHeader(), "x-hub-signature-256": "sha256=" + "0".repeat(64) }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(t.after).not.toHaveBeenCalled();
  });
  it("cuerpo justo en el tope se acepta (firma válida)", async () => {
    const t = harness();
    const raw = JSON.stringify({ object: "page", pad: "x".repeat(MAX_BODY - 30) });
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_BODY);
    expect((await t.post(null, { raw })).status).toBe(200);
  });
  it("sin configuración → 503 y no procesa aunque la firma sea válida", async () => {
    const t = harness({}, null);
    const res = await t.post(body);
    expect(res.status).toBe(503);
    expect(t.after).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(logs.join("\n")).toContain("sin configuración válida"); // el aviso (que nombra variables, nunca valores)…
    expect(logs.join("\n")).not.toContain(WA.appSecret); // …no filtra secretos
  });
});

describe("POST: remitentes y tipos de contenido", () => {
  it("remitente NO autorizado → ignorado sin responderle, sin fila y con número enmascarado en el log", async () => {
    const t = harness();
    const res = await t.post(webhookBody([textMsg("wamid.INT1", "dame tus datos", WA.intruso)]));
    expect(res.status).toBe(200);
    await t.flush();
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect(await rows()).toEqual([]);
    const all = logs.join("\n");
    expect(all).toContain("***0009");
    expect(all).not.toContain(WA.intruso);
    expect(all).not.toContain("dame tus datos");
  });
  it("mezcla de autorizado y no autorizado: solo se procesa el autorizado, en orden", async () => {
    const t = harness();
    await t.post(webhookBody([textMsg("wamid.M1", "uno"), textMsg("wamid.M2", "intruso", WA.intruso), textMsg("wamid.M3", "tres", WA.sam)]));
    await t.flush();
    expect(t.handled.map((h) => h.msg.id)).toEqual(["wamid.M1", "wamid.M3"]);
    expect(t.sent).toEqual([]);
  });
  it("521… de Meta coincide con una lista configurada con 52…", async () => {
    const t = harness({}, getWhatsAppConfig({ ...WA_ENV, WHATSAPP_ALLOWED: "525511110001=Alex" }));
    await t.post(webhookBody([textMsg("wamid.MX", "hola", WA.alex)]));
    await t.flush();
    expect(t.handled).toHaveLength(1);
    expect(t.handled[0].sender).toEqual({ waId: WA.alex, name: "Alex" });
  });
  it("misma terminación de 10 dígitos con otra lada de país NO es el remitente autorizado (sin suplantación)", async () => {
    const t = harness({}, getWhatsAppConfig({ ...WA_ENV, WHATSAPP_ALLOWED: "525511110001=Alex" }));
    const res = await t.post(webhookBody([textMsg("wamid.SPOOF", "hola", "15511110001")]));
    expect(res.status).toBe(200);
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
    expect(logs.join("\n")).not.toContain("15511110001");
  });
  it("metadata de OTRO número (phone_number_id) → ignorado sin tocar nada", async () => {
    const t = harness();
    const res = await t.post(webhookBody([textMsg("wamid.OTRO", "hola")], { phoneNumberId: "555000555000555" }));
    expect(res.status).toBe(200);
    expect(t.after).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it("solo `statuses` (acuses) → 200 y nada se programa", async () => {
    const t = harness();
    const res = await t.post(webhookBody([], { statuses: [{ id: "wamid.OUT", status: "delivered", recipient_id: WA.alex }] }));
    expect(res.status).toBe(200);
    expect(t.after).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it("documento, imagen, audio y otros tipos llegan al handler con su tipo y se registran con su kind", async () => {
    const t = harness();
    await t.post(webhookBody([
      { from: WA.alex, id: "wamid.DOC", timestamp: "1790000001", type: "document", document: { id: "70001", mime_type: "application/pdf", filename: "estado.pdf" } },
      { from: WA.alex, id: "wamid.IMG", timestamp: "1790000002", type: "image", image: { id: "70002", mime_type: "image/jpeg" } },
      { from: WA.alex, id: "wamid.AUD", timestamp: "1790000003", type: "audio", audio: { id: "70003", mime_type: "audio/ogg" } },
      { from: WA.alex, id: "wamid.REA", timestamp: "1790000004", type: "reaction", reaction: { emoji: "👍", message_id: "wamid.X" } },
    ]));
    await t.flush();
    expect(t.handled.map((h) => [h.msg.id, h.msg.type, h.msg.media?.id])).toEqual([
      ["wamid.DOC", "document", "70001"], ["wamid.IMG", "image", "70002"], ["wamid.AUD", "audio", "70003"], ["wamid.REA", "other", undefined],
    ]);
    expect((await rows()).map((r) => [r.msg_id, r.kind])).toEqual([["wamid.AUD", "audio"], ["wamid.DOC", "document"], ["wamid.IMG", "image"], ["wamid.REA", "other"]]);
  });
});

describe("POST: idempotencia y errores", () => {
  it("el mismo wamid dos veces (reintento de Meta) → una sola ejecución", async () => {
    const t = harness();
    t.handle.mockImplementation(async (msg) => void (await finishMessage(msg.id, "done"))); // como el handler real: cierra el mensaje
    const b = webhookBody([textMsg("wamid.DUP", "350 starbucks")]);
    expect((await t.post(b)).status).toBe(200);
    expect((await t.post(b)).status).toBe(200);
    await t.flush();
    expect(t.handle).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });
  it("el mismo wamid repetido dentro de un POST → una sola ejecución", async () => {
    const t = harness();
    await t.post(webhookBody([textMsg("wamid.DUP2", "a"), textMsg("wamid.DUP2", "a")]));
    await t.flush();
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("POST concurrentes con el mismo wamid → una sola ejecución", async () => {
    const t = harness();
    const b = webhookBody([textMsg("wamid.RACE", "a")]);
    await Promise.all([t.post(b), t.post(b), t.post(b)]);
    await Promise.all(t.queue.splice(0).map((fn) => fn()));
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("si el handler lanza → mensaje genérico al usuario, fila en failed y los demás mensajes siguen", async () => {
    const t = harness();
    t.handle.mockImplementationOnce(async () => {
      throw new Error("detalle interno con datos 350 starbucks");
    });
    const res = await t.post(webhookBody([textMsg("wamid.BOOM", "350 starbucks"), textMsg("wamid.OK2", "hoy")]));
    expect(res.status).toBe(200);
    await t.flush();
    expect(t.sent).toEqual([{ to: WA.alex, body: GENERIC_ERROR }]);
    expect(t.sent[0].body).not.toContain("starbucks");
    expect(await rows()).toEqual([
      { msg_id: "wamid.BOOM", wa_id: WA.alex, kind: "text", status: "failed" },
      { msg_id: "wamid.OK2", wa_id: WA.alex, kind: "text", status: "received" },
    ]);
    expect(t.handled.map((h) => h.msg.id)).toEqual(["wamid.OK2"]);
    // Reintento de Meta del mensaje fallido: no se reprocesa (ya está reclamado).
    await t.post(webhookBody([textMsg("wamid.BOOM", "350 starbucks")]));
    await t.flush();
    expect(t.handle).toHaveBeenCalledTimes(2);
  });
  it("si finishMessage también falla, igual responde el error genérico", async () => {
    const t = harness({ finish: async () => { throw new Error("db caída"); } });
    t.handle.mockRejectedValueOnce(new Error("x"));
    await t.post(webhookBody([textMsg("wamid.F1", "a")]));
    await t.flush();
    expect(t.sent).toEqual([{ to: WA.alex, body: GENERIC_ERROR }]);
  });
  it("si no se puede registrar el mensaje (base caída) → avisa al usuario que reenvíe; no revienta ni procesa", async () => {
    const t = harness({ claim: async () => { throw new Error("Failed to connect"); } });
    const res = await t.post(webhookBody([textMsg("wamid.NODB", "a"), textMsg("wamid.NODB2", "b", WA.intruso)]));
    expect(res.status).toBe(200);
    await t.flush();
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([{ to: WA.alex, body: BUSY_ERROR }]); // el intruso no recibe nada
  });
  it("varios mensajes en un POST se procesan en SERIE y en orden", async () => {
    const t = harness();
    const order: string[] = [];
    let running = 0, maxRunning = 0;
    t.handle.mockImplementation(async (msg) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      order.push(`start:${msg.id}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${msg.id}`);
      running--;
    });
    await t.post(webhookBody([textMsg("wamid.S1", "a"), textMsg("wamid.S2", "b"), textMsg("wamid.S3", "c")]));
    await t.flush();
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["start:wamid.S1", "end:wamid.S1", "start:wamid.S2", "end:wamid.S2", "start:wamid.S3", "end:wamid.S3"]);
  });
});

describe("POST: presupuesto de tiempo y after()", () => {
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
    const res = await t.post(webhookBody([textMsg("wamid.B1", "pdf grande")]));
    expect(res.status).toBe(200);
    expect(t.events).toEqual(["start:wamid.B1"]); // el handler sigue corriendo
    expect(t.after).toHaveBeenCalledTimes(1);
    g.release();
    await t.flush(); // after(): espera a que termine
    expect(t.events).toEqual(["start:wamid.B1", "end:wamid.B1"]);
    expect(logs.join("\n")).toContain("presupuesto");
  });
  it("presupuesto agotado con varios mensajes: el resto sigue EN SERIE dentro de after()", async () => {
    const g = gate();
    const t = harness({ budgetMs: 20 });
    t.handle.mockImplementation(async (msg) => {
      t.events.push(`start:${msg.id}`);
      if (msg.id === "wamid.B2") await g.p;
      t.events.push(`end:${msg.id}`);
    });
    await t.post(webhookBody([textMsg("wamid.B2", "a"), textMsg("wamid.B3", "b")]));
    expect(t.events).toEqual(["start:wamid.B2"]);
    g.release();
    await t.flush();
    expect(t.events).toEqual(["start:wamid.B2", "end:wamid.B2", "start:wamid.B3", "end:wamid.B3"]);
  });
  it("presupuesto agotado y after() lanza → igual 200 y el handler termina", async () => {
    const g = gate();
    const t = harness({ budgetMs: 20, after: () => { throw new Error("fuera de solicitud"); } });
    t.handle.mockImplementation(async () => {
      await g.p;
      t.events.push("fin");
    });
    const res = await t.post(webhookBody([textMsg("wamid.B4", "a")]));
    expect(res.status).toBe(200);
    g.release();
    await vi.waitFor(() => expect(t.events).toEqual(["fin"]));
  });
  it("dentro del presupuesto no se llama a after()", async () => {
    const t = harness({ budgetMs: 5000 });
    await t.post(webhookBody([textMsg("wamid.B5", "a")]));
    expect(t.after).not.toHaveBeenCalled();
  });
  it("un fallo del handler tras agotar el presupuesto nunca queda sin atrapar", async () => {
    const g = gate();
    const t = harness({ budgetMs: 20 });
    t.handle.mockImplementation(async () => {
      await g.p;
      throw new Error("x");
    });
    await t.post(webhookBody([textMsg("wamid.B6", "a")]));
    g.release();
    await expect(t.flush()).resolves.toBeUndefined();
    expect(t.sent).toEqual([{ to: WA.alex, body: GENERIC_ERROR }]);
  });
  it("un fallo del handler dentro del presupuesto tampoco rompe la respuesta", async () => {
    const t = harness();
    t.handle.mockRejectedValue(new Error("x"));
    const res = await t.post(webhookBody([textMsg("wamid.R1", "a"), textMsg("wamid.R2", "b")]));
    expect(res.status).toBe(200);
    expect(t.sent).toHaveLength(2);
  });
  it("si el proceso muere antes de responder, Meta reintenta: el claim vuelve a decidir (no depende de after)", async () => {
    // Primera entrega: el handler nunca termina (proceso muerto). Segunda: llega el reintento y se reprocesa.
    const t = harness({ budgetMs: 10, claim: async () => true });
    t.handle.mockImplementationOnce(() => new Promise<void>(() => {})); // nunca resuelve
    expect((await t.post(webhookBody([textMsg("wamid.B7", "x")]))).status).toBe(200); // (aquí el presupuesto lo libera; en un crash real no habría respuesta)
    await t.post(webhookBody([textMsg("wamid.B7", "x")]));
    expect(t.handle).toHaveBeenCalledTimes(2);
  });
  it("con la base real: una fila `received` de más de 2 min se reclama de nuevo (reintento tras un proceso muerto)", async () => {
    const t = harness();
    expect((await t.post(webhookBody([textMsg("wamid.REC", "hola")]))).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(MINUTE, -3, SYSUTCDATETIME()) WHERE msg_id = 'wamid.REC'");
    expect((await t.post(webhookBody([textMsg("wamid.REC", "hola")]))).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(2); // vencida: se reprocesa
  });
});

describe("POST: mensaje en vuelo (reintento de Meta dentro de la ventana de 120 s)", () => {
  const body = () => webhookBody([textMsg("wamid.INF", "350 starbucks")]);

  it("fila `received` RECIENTE (el proceso murió a media ejecución) → 503 con Retry-After: 5, sin procesar ni responder al usuario", async () => {
    const t = harness();
    await claimMessage("wamid.INF", WA.alex, "text"); // el primer intento lo reclamó y murió sin cerrar
    const res = await t.post(body());
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(JSON.stringify(await res.json())).not.toMatch(/INF|350|starbucks/);
    expect(t.handle).not.toHaveBeenCalled();
    expect(t.sent).toEqual([]);
    expect((await rows())[0].status).toBe("received"); // sigue reclamable cuando venza
  });
  it("el reintento que llega DESPUÉS de la ventana (stale) sí se procesa → 200; el siguiente ya es duplicado", async () => {
    const t = harness();
    await claimMessage("wamid.INF", WA.alex, "text");
    expect((await t.post(body())).status).toBe(503);
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(SECOND, -121, SYSUTCDATETIME()) WHERE msg_id = 'wamid.INF'");
    t.handle.mockImplementation(async (msg) => void (await finishMessage(msg.id, "done")));
    expect((await t.post(body())).status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
    const dup = await t.post(body());
    expect(dup.status).toBe(200); // `done`: duplicado, nada más
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it.each(["done", "failed", "ignored"] as const)("fila '%s' → 200 duplicado sin procesar", async (status) => {
    const t = harness();
    await claimMessage("wamid.INF", WA.alex, "text");
    await finishMessage("wamid.INF", status);
    const res = await t.post(body());
    expect(res.status).toBe(200);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(t.handle).not.toHaveBeenCalled();
  });
  it("carrera de dos reintentos simultáneos sobre una fila vencida: uno procesa (200), el otro 503", async () => {
    const t = harness();
    await claimMessage("wamid.INF", WA.alex, "text");
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(MINUTE, -3, SYSUTCDATETIME()) WHERE msg_id = 'wamid.INF'");
    t.handle.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 50)));
    const res = await Promise.all([t.post(body()), t.post(body())]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("carrera de dos entregas simultáneas de un mensaje NUEVO: uno procesa (200), el otro 503", async () => {
    const t = harness();
    t.handle.mockImplementation(() => new Promise<void>((r) => setTimeout(r, 50)));
    const res = await Promise.all([t.post(body()), t.post(body())]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 503]);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("claimMessageState: new → inflight (reciente) → stale (vencida) → inflight (renovada) → done; claimMessage es su versión booleana", async () => {
    expect(await claimMessageState("wamid.ST", WA.alex, "text")).toBe("new");
    expect(await claimMessageState("wamid.ST", WA.alex, "text")).toBe("inflight");
    await query("UPDATE dbo.whatsapp_messages SET created_at = DATEADD(MINUTE, -3, SYSUTCDATETIME()) WHERE msg_id = 'wamid.ST'");
    expect(await claimMessageState("wamid.ST", WA.alex, "text")).toBe("stale");
    expect(await claimMessageState("wamid.ST", WA.alex, "text")).toBe("inflight"); // la reclamó el anterior y renovó created_at
    await finishMessage("wamid.ST", "done");
    expect(await claimMessageState("wamid.ST", WA.alex, "text")).toBe("done");
    expect(await claimMessage("wamid.ST2", WA.alex, "text")).toBe(true);
    expect(await claimMessage("wamid.ST2", WA.alex, "text")).toBe(false);
  });
  it("con claim falso 'inflight': 503; con 'done': 200; con 'new'/'stale': se procesa", async () => {
    for (const [state, status, handled] of [["inflight", 503, 0], ["done", 200, 0], ["new", 200, 1], ["stale", 200, 1]] as const) {
      const t = harness({ claimState: async () => state });
      expect((await t.post(body())).status).toBe(status);
      expect(t.handle).toHaveBeenCalledTimes(handled);
    }
  });
  it("varios mensajes en un POST: los demás se procesan y, si alguno está en vuelo, el POST responde 503", async () => {
    const t = harness({ claimState: async (id) => (id === "wamid.B" ? "inflight" : "new") });
    const res = await t.post(webhookBody([textMsg("wamid.A", "a"), textMsg("wamid.B", "b"), textMsg("wamid.C", "c")]));
    expect(res.status).toBe(503);
    expect(t.handled.map((h) => h.msg.id)).toEqual(["wamid.A", "wamid.C"]);
  });
  it("si el presupuesto se agota antes de ver el en vuelo, ya se respondió 200 (el 503 solo aplica dentro del presupuesto)", async () => {
    const t = harness({ budgetMs: 10, claimState: async () => new Promise((r) => setTimeout(() => r("inflight"), 80)) });
    expect((await t.post(body())).status).toBe(200);
    await t.flush();
  });
  it("el 503 por mensaje en vuelo no cuenta contra los límites por IP (firma válida)", async () => {
    const t = harness({ claimState: async () => "inflight", limiters: { perIp: new RateLimiter(1, 60_000), failures: new RateLimiter(1, 60_000) } });
    for (let i = 0; i < 4; i++) expect((await t.post(body())).status).toBe(503);
  });
});

describe("POST: payload raro con firma válida → siempre 200", () => {
  it.each([
    ["JSON inválido", "{no json"],
    ["cuerpo vacío", ""],
    ["null", "null"],
    ["arreglo", "[1,2,3]"],
    ["texto", '"hola"'],
    ["objeto vacío", "{}"],
    ["object de otra plataforma", '{"object":"instagram","entry":[{"changes":[]}]}'],
    ["entry de tipo erróneo", '{"object":"whatsapp_business_account","entry":"x"}'],
    ["mensajes de tipo erróneo", `{"object":"whatsapp_business_account","entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"${WA.phoneNumberId}"},"messages":[1,null,{"id":5}]}}]}]}`],
    ["UTF-8 inválido", "\u0000\u0001�"],
  ])("%s", async (_n, raw) => {
    const t = harness();
    const res = await t.post(null, { raw });
    expect(res.status).toBe(200);
    await t.flush();
    expect(t.handle).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
});

describe("POST: límites de uso (solo para peticiones NO autenticadas)", () => {
  const bad = "mal-secreto-inventado-0123456789abc";
  const b = webhookBody([textMsg("wamid.BL", "a")]);
  const fail = (t: ReturnType<typeof harness>, headers: Record<string, string>) => t.post(b, { headers, secret: bad });

  it("10 firmas inválidas desde una IP → esa IP queda bloqueada (429 con Retry-After) para peticiones SIN firma válida", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.90" };
    for (let i = 0; i < 10; i++) expect((await fail(t, headers)).status).toBe(401);
    const res = await fail(t, headers);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await t.post(b, { headers, sign: false })).status).toBe(429);
    expect((await fail(t, { "x-forwarded-for": "198.51.100.91" })).status).toBe(401); // otra IP no se ve afectada
  });
  it("una firma VÁLIDA se procesa SIEMPRE, aunque su IP esté bloqueada o agotada (la IP de Meta no se puede bloquear)", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(2, 60_000), failures: new RateLimiter(3, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.92" };
    for (let i = 0; i < 5; i++) await fail(t, headers);
    expect((await fail(t, headers)).status).toBe(429);
    const res = await t.post(webhookBody([textMsg("wamid.OKB", "hola")]), { headers });
    expect(res.status).toBe(200);
    expect(t.handle).toHaveBeenCalledTimes(1);
  });
  it("anti-suplantación: se usa la ÚLTIMA entrada de X-Forwarded-For; poner la IP de Meta al principio no bloquea a Meta", async () => {
    const t = harness();
    const metaIp = "173.252.88.10";
    for (let i = 0; i < 10; i++) expect((await fail(t, { "x-forwarded-for": `${metaIp}, 203.0.113.99` })).status).toBe(401);
    expect((await fail(t, { "x-forwarded-for": `${metaIp}, 203.0.113.99` })).status).toBe(429); // el atacante sí queda bloqueado…
    expect((await fail(t, { "x-forwarded-for": metaIp })).status).toBe(401); // …pero la IP de Meta NO (ni siquiera con firma mala)
    expect((await t.post(b, { headers: { "x-forwarded-for": metaIp } })).status).toBe(200);
  });
  it("el rate limit por IP no se aplica a peticiones autenticadas", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(3, 60_000), failures: new RateLimiter(10, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.77" };
    for (let i = 0; i < 12; i++) expect((await t.post(webhookBody([]), { headers })).status).toBe(200);
  });
  it("sí se aplica a las no autenticadas: tras el cupo, 429 con Retry-After", async () => {
    const t = harness({ limiters: { perIp: new RateLimiter(3, 60_000), failures: new RateLimiter(100, 600_000) } });
    const headers = { "x-forwarded-for": "198.51.100.78" };
    for (let i = 0; i < 3; i++) expect((await fail(t, headers)).status).toBe(401);
    const res = await fail(t, headers);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
  it("las firmas válidas NO cuentan como fallos", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.95" };
    for (let i = 0; i < 15; i++) expect((await t.post(webhookBody([]), { headers })).status).toBe(200);
    expect((await fail(t, headers)).status).toBe(401);
  });
  it("sin firma también cuenta como fallo", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.96" };
    for (let i = 0; i < 10; i++) expect((await t.post(webhookBody([]), { headers, sign: false })).status).toBe(401);
    expect((await t.post(webhookBody([]), { headers, sign: false })).status).toBe(429);
  });
  it("cuerpo enorme con cabecera de firma (no se puede verificar) → 413 que cuenta como fallo; no se procesa", async () => {
    const t = harness();
    const headers = { "x-forwarded-for": "198.51.100.98" };
    const big = "x".repeat(MAX_BODY + 1);
    for (let i = 0; i < 10; i++) expect((await t.post(null, { raw: big, headers })).status).toBe(413);
    expect((await t.post(null, { raw: big, headers })).status).toBe(429);
    expect(t.handle).not.toHaveBeenCalled();
  });
  it("sin configuración, las respuestas 503 no cuentan como fallos de firma", async () => {
    const t = harness({}, null);
    const headers = { "x-forwarded-for": "198.51.100.97" };
    for (let i = 0; i < 12; i++) expect((await t.post(webhookBody([]), { headers })).status).toBe(503);
  });
});

describe("higiene de logs", () => {
  it("nada de textos, números completos, secretos, firmas ni nombres en los logs, en ningún escenario", async () => {
    const t = harness();
    const text = "gasto secreto 777 farmacia-inventada";
    const raw = JSON.stringify(webhookBody([textMsg("wamid.LOG1", text), textMsg("wamid.LOG2", text, WA.intruso)]));
    await t.post(null, { raw });
    await t.post(null, { raw, sign: false, headers: { "x-hub-signature-256": "sha256=" + "e".repeat(64) } });
    await t.post("{no json " + text);
    t.handle.mockRejectedValueOnce(new Error("falla controlada"));
    await t.post(webhookBody([textMsg("wamid.LOG3", text, WA.sam)]));
    await t.flush();
    await t.get(verifyParams({ "hub.verify_token": "intento-falso-inventado-0123" }));
    const all = logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [text, "farmacia-inventada", WA.alex, WA.sam, WA.intruso, WA.verifyToken, WA.appSecret, WA.accessToken, "Nombre Inventado", "Alex", "e".repeat(64), "intento-falso"]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe("rutas reales (/api/whatsapp) y Easy Auth", () => {
  const url = "/api/whatsapp";
  const fetchSpy = () => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("¡red real en pruebas!"); }));
  afterEach(() => vi.unstubAllGlobals());

  it("GET con el verify token → challenge (sin sesión de Easy Auth)", async () => {
    const res = await routeGet(req(`${url}?${new URLSearchParams(verifyParams())}`, { headers: ipHeader() }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1158201444");
  });
  it("GET con token malo → 403 aunque venga con sesión válida de Easy Auth (la sesión no sustituye al verify token)", async () => {
    const res = await routeGet(req(`${url}?${new URLSearchParams(verifyParams({ "hub.verify_token": "x".repeat(20) }))}`, { headers: { ...ipHeader(), ...authed() } }));
    expect(res.status).toBe(403);
  });
  it("POST sin firma → 401 aunque venga con sesión válida de Easy Auth", async () => {
    const res = await routePost(req(url, { method: "POST", body: webhookBody([textMsg("wamid.RT1", "a")]), headers: { ...ipHeader(), ...authed() } }));
    expect(res.status).toBe(401);
    expect(await rows()).toEqual([]);
  });
  it("POST con firma buena sin sesión → 200; remitente no autorizado e ignorado: sin red y sin filas", async () => {
    fetchSpy();
    const raw = JSON.stringify(webhookBody([textMsg("wamid.RT2", "hola", WA.intruso)]));
    const res = await routePost(req(url, { method: "POST", raw, headers: { ...ipHeader(), ...signed(raw) } }));
    expect(res.status).toBe(200);
    await flushWebhookWork();
    expect(fetch).not.toHaveBeenCalled();
    expect(await rows()).toEqual([]);
  });
  it("POST con firma buena y solo statuses → 200 y nada pasa", async () => {
    fetchSpy();
    const raw = JSON.stringify(webhookBody([], { statuses: [{ id: "wamid.O", status: "read" }] }));
    const res = await routePost(req(url, { method: "POST", raw, headers: { ...ipHeader(), ...signed(raw) } }));
    expect(res.status).toBe(200);
    await flushWebhookWork();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sin configuración en el entorno, la ruta real falla cerrado (503)", async () => {
    const saved = process.env.WHATSAPP_APP_SECRET;
    delete process.env.WHATSAPP_APP_SECRET;
    try {
      const raw = JSON.stringify(webhookBody([textMsg("wamid.RT3", "a")]));
      expect((await routePost(req(url, { method: "POST", raw, headers: { ...ipHeader(), ...signed(raw) } }))).status).toBe(503);
      expect((await routeGet(req(`${url}?${new URLSearchParams(verifyParams())}`, { headers: ipHeader() }))).status).toBe(503);
      expect(logs.join("\n")).toContain("WHATSAPP_APP_SECRET"); // solo el nombre de la variable
      expect(logs.join("\n")).not.toContain(WA.appSecret);
    } finally {
      process.env.WHATSAPP_APP_SECRET = saved;
    }
  });

  const px = (path: string, headers: Record<string, string> = {}, method = "POST") =>
    proxy(new NextRequest(`http://localhost:3000${path}`, { method, headers }));
  it("el proxy NO exige Easy Auth en /api/whatsapp (ni reemite la cookie) pero sí en el resto de /api", () => {
    const wa = px("/api/whatsapp");
    expect(wa.status).toBe(200);
    expect(wa.headers.get("x-middleware-next")).toBe("1");
    expect(wa.headers.get("set-cookie")).toBeNull();
    expect(px("/api/whatsapp", {}, "GET").status).toBe(200);
    expect(px("/api/transactions", {}, "GET").status).toBe(401);
    expect(px("/api/whatsapp/otra").status).toBe(401); // solo la ruta exacta queda fuera
    expect(px("/api/ingest").status).toBe(200);
  });
});
