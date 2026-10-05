import { describe, expect, it } from "vitest";
import { extractUpdates, MAX_UPDATES_PER_POST, translateCommand } from "@/lib/telegram/payload";
import { groupChat, privateChat, TG, textUpdate, update, user } from "../tg-webhook-fixtures";

const BOT = TG.botUsername;
/** Chats de grupo "permitidos" por omisión en estas pruebas (los de abajo se usan en varios casos). */
const CHATS = [String(TG.group), "-5", "-100", "-4000111", "-1001111"];
const one = (body: unknown, botUsername: string | null = null, allowedChats: string[] = CHATS) => extractUpdates(body, { botUsername, allowedChats });
const msgOf = (body: unknown, botUsername: string | null = null) => {
  const it = one(body, botUsername).items[0];
  return it?.kind === "message" ? it.message : undefined;
};

describe("mapeo a InboundMessage", () => {
  it("texto en chat privado", () => {
    expect(msgOf(textUpdate(5001, "350 starbucks amex"))).toEqual({
      id: "tg:5001", from: "tg111111111", replyTo: "111111111", timestamp: 1790000000, channel: "telegram", type: "text", text: "350 starbucks amex",
    });
  });
  it("documento: usa mime_type, file_name y file_id", () => {
    const m = msgOf(update(5002, { document: { file_id: "BQACAgQAAxkBAAIB-ejemplo", file_unique_id: "u", file_name: "estado.pdf", mime_type: "application/pdf", file_size: 12345 } }));
    expect(m).toMatchObject({ type: "document", media: { id: "BQACAgQAAxkBAAIB-ejemplo", mimeType: "application/pdf", filename: "estado.pdf" } });
    expect(m).not.toHaveProperty("text");
  });
  it("documento sin mime ni nombre", () => {
    expect(msgOf(update(5003, { document: { file_id: "BQACAgQAAxkBAAIB-ejemplo" } }))?.media).toEqual({ id: "BQACAgQAAxkBAAIB-ejemplo" });
  });
  it("foto: toma el tamaño más pesado", () => {
    const m = msgOf(update(5004, { photo: [{ file_id: "chica-0123456789", file_size: 100 }, { file_id: "grande-0123456789", file_size: 90000 }, { file_id: "media-0123456789", file_size: 5000 }] }));
    expect(m).toMatchObject({ type: "image", media: { id: "grande-0123456789" } });
  });
  it("foto sin tamaños o con basura → other", () => {
    expect(msgOf(update(5005, { photo: [] }))?.type).toBe("other");
    expect(msgOf(update(5006, { photo: [1, null, "x"] }))?.type).toBe("other");
    expect(msgOf(update(5007, { photo: "no es arreglo" }))?.type).toBe("other");
  });
  it.each(["voice", "audio", "video_note"])("%s → audio", (k) => {
    expect(msgOf(update(5008, { [k]: { file_id: "audio-0123456789", mime_type: "audio/ogg", duration: 3 } }))).toMatchObject({ type: "audio", media: { id: "audio-0123456789" } });
  });
  it.each([
    ["sticker", { sticker: { file_id: "stk-0123456789", emoji: "😀" } }],
    ["ubicación", { location: { latitude: 19.4, longitude: -99.1 } }],
    ["contacto", { contact: { phone_number: "5500000000", first_name: "Inventado" } }],
    ["encuesta", { poll: { id: "1", question: "¿?" } }],
    ["video", { video: { file_id: "vid-0123456789" } }],
    ["GIF (animation + document)", { animation: { file_id: "gif-0123456789" }, document: { file_id: "gif-0123456789" } }],
    ["mensaje vacío de servicio", { new_chat_members: [user(1)] }],
  ])("%s → other, sin media", (_n, over) => {
    const m = msgOf(update(5009, over));
    expect(m?.type).toBe("other");
    expect(m).not.toHaveProperty("media");
    expect(m).toMatchObject({ id: "tg:5009", from: "tg111111111", channel: "telegram" });
  });
  it("documento con file_id de tipo equivocado → other", () => {
    expect(msgOf(update(5010, { document: { file_id: 42 } }))?.type).toBe("other");
    expect(msgOf(update(5011, { document: "x" }))?.type).toBe("other");
  });
  it("grupo y supergrupo: replyTo es el chat (negativo) y from sigue siendo el usuario", () => {
    const g = msgOf(update(5012, { text: "/hoy", from: user(TG.ana), chat: groupChat(TG.group, "supergroup") }));
    expect(g).toMatchObject({ from: "tg222222222", replyTo: String(TG.group), text: "hoy" });
    expect(msgOf(update(5013, { text: "/hoy", chat: groupChat(-4000111, "group") }))?.replyTo).toBe("-4000111");
  });
  it("timestamp: message.date; si falta o es raro, la hora actual", () => {
    expect(msgOf(update(1, { text: "a", date: 1790000123 }))?.timestamp).toBe(1790000123);
    const now = 1_800_000_000_000;
    for (const date of [undefined, "1790000000", -5, 0, 1.5, null]) {
      const r = extractUpdates(update(1, { text: "a", date }), {}, now);
      expect(r.items[0].kind === "message" && r.items[0].message.timestamp).toBe(1_800_000_000);
    }
  });
  it("texto muy largo se recorta a 4096", () => {
    expect(msgOf(textUpdate(1, "x".repeat(10000)))?.text).toHaveLength(4096);
  });
  it("update_id 0 es válido", () => expect(msgOf(textUpdate(0, "hola"))?.id).toBe("tg:0"));
  it("ids grandes (hasta 2^52) se conservan", () => {
    const big = 4_503_599_627_370_000;
    expect(msgOf(update(1, { text: "a", from: user(big), chat: privateChat(big) }))).toMatchObject({ from: `tg${big}`, replyTo: String(big) });
  });
});

describe("qué se ignora", () => {
  const reasons = (b: unknown) => one(b).stats.reasons;
  it.each([
    ["edited_message", { update_id: 1, edited_message: { message_id: 1, from: user(TG.uziel), chat: privateChat(TG.uziel), date: 1, text: "x" } }],
    ["channel_post", { update_id: 2, channel_post: { message_id: 1, chat: { id: -1001, type: "channel" }, date: 1, text: "x" } }],
    ["callback_query", { update_id: 3, callback_query: { id: "1", from: user(TG.uziel), data: "x" } }],
    ["my_chat_member", { update_id: 4, my_chat_member: { chat: groupChat(), from: user(TG.uziel) } }],
    ["solo update_id", { update_id: 5 }],
  ])("%s → ignorado (no-message)", (_n, body) => {
    const r = one(body);
    expect(r.items).toEqual([]);
    expect(r.stats.reasons).toEqual({ "no-message": 1 });
  });
  it("mensaje de un bot → ignorado", () => {
    expect(reasons(update(1, { text: "a", from: user(77, { is_bot: true }) }))).toEqual({ bot: 1 });
  });
  it("is_bot ausente se trata como persona; is_bot de tipo raro es 'invalid'", () => {
    expect(one(update(1, { text: "a", from: { id: 5 } })).items).toHaveLength(1);
    expect(reasons(update(1, { text: "a", from: user(5, { is_bot: "sí" }) }))).toEqual({ invalid: 1 });
  });
  it("sin from (p. ej. admin anónimo o canal) → ignorado", () => {
    expect(reasons(update(1, { text: "a", from: undefined }))).toEqual({ "no-sender": 1 });
  });
  it("chat de canal → ignorado; tipos desconocidos → chat-type", () => {
    expect(reasons(update(1, { text: "a", chat: { id: -1002, type: "channel" } }))).toEqual({ channel: 1 });
    expect(reasons(update(1, { text: "a", chat: { id: 5, type: "sender" } }))).toEqual({ "chat-type": 1 });
  });
  it.each([
    ["chat privado", privateChat(1), 1],
    ["grupo", groupChat(-5, "group"), 1],
    ["supergrupo", groupChat(-100, "supergroup"), 1],
  ])("%s se procesa", (_n, chat, count) => {
    expect(one(update(1, { text: "/hoy", chat })).items).toHaveLength(count);
  });
  it("sin chat o con chat inválido → invalid", () => {
    expect(reasons(update(1, { text: "a", chat: undefined }))).toEqual({ invalid: 1 });
    expect(reasons(update(1, { text: "a", chat: { id: "5", type: "private" } }))).toEqual({ invalid: 1 });
    expect(reasons(update(1, { text: "a", chat: { id: 1.5, type: "private" } }))).toEqual({ invalid: 1 });
  });
  it("from con id inválido (0, negativo, texto, decimal) → invalid", () => {
    for (const id of [0, -3, "5", 2.5, null, Number.MAX_SAFE_INTEGER + 2]) expect(reasons(update(1, { text: "a", from: { id } }))).toEqual({ invalid: 1 });
  });
});

describe("cuerpos raros: nunca lanza", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["número", 42],
    ["cadena", "hola"],
    ["arreglo vacío", []],
    ["arreglo de basura", [1, null, "x", {}, []]],
    ["objeto vacío", {}],
    ["update_id de tipo erróneo", { update_id: "1", message: {} }],
    ["update_id negativo", { update_id: -1, message: {} }],
    ["update_id decimal", { update_id: 1.5, message: {} }],
    ["message nulo", { update_id: 1, message: null }],
    ["message de tipo erróneo", { update_id: 1, message: "x" }],
    ["message arreglo", { update_id: 1, message: [1] }],
    ["text de tipo erróneo", update(1, { text: 123 })],
    ["text objeto", update(1, { text: { a: 1 } })],
    ["date de tipo erróneo", update(1, { text: "a", date: {} })],
    ["campos con tipos cambiados", update(1, { photo: 5, document: [], voice: "x", text: undefined })],
  ])("%s", (_n, body) => {
    expect(() => one(body)).not.toThrow();
    const r = one(body);
    expect(r.items.every((i) => i.kind === "message" || i.kind === "id")).toBe(true);
  });
  it("ignora campos extra desconocidos", () => {
    const u = { ...textUpdate(7, "hola"), campo_nuevo: { x: 1 }, otro: [1, 2] } as Record<string, unknown>;
    Object.assign(u.message as Record<string, unknown>, { entities: [{ type: "bot_command", offset: 0, length: 4 }], campo_futuro: true });
    expect(msgOf(u)).toMatchObject({ type: "text", text: "hola" });
  });
  it("un getter hostil no se propaga", () => {
    const hostile = { update_id: 1, get message(): unknown { throw new Error("boom"); } };
    expect(() => one(hostile)).not.toThrow();
    expect(one(hostile).items).toEqual([]);
  });
  it("arreglo de updates: se procesan todos y se acota a 50", () => {
    const many = Array.from({ length: MAX_UPDATES_PER_POST + 5 }, (_, i) => textUpdate(i + 1, "a"));
    const r = one(many);
    expect(r.items).toHaveLength(MAX_UPDATES_PER_POST);
    expect(r.stats.truncated).toBe(5);
    expect(one([textUpdate(1, "a"), { update_id: 2 }, textUpdate(3, "b")]).items).toHaveLength(2);
  });
});

describe("comandos de Telegram", () => {
  const text = (raw: string, bot: string | null = null) => {
    const c = translateCommand(raw, bot);
    return "text" in c ? c.text : c;
  };
  it("/start, /ayuda, /help → ayuda (con o sin argumentos)", () => {
    for (const c of ["/start", "/ayuda", "/help", "/START", "/Ayuda", "/start abc123", "/help me por favor"]) expect(text(c)).toBe("ayuda");
  });
  it("comandos de una palabra → la misma palabra sin /", () => {
    for (const w of ["tarjetas", "resumen", "hoy", "deshacer", "cancelar"]) {
      expect(text(`/${w}`)).toBe(w);
      expect(text(`/${w.toUpperCase()}`)).toBe(w);
    }
  });
  it("respeta los argumentos", () => {
    expect(text("/resumen mes")).toBe("resumen mes");
    expect(text("/hoy   extra  ")).toBe("hoy extra");
    expect(text("/hoy\nsegunda línea")).toBe("hoy segunda línea");
  });
  it("quita el sufijo @Bot (sin usuario configurado, de cualquier bot)", () => {
    expect(text("/ayuda@UnBotCualquiera")).toBe("ayuda");
    expect(text("/hoy@UnBotCualquiera algo")).toBe("hoy algo");
  });
  it("con usuario configurado: el sufijo propio pasa (sin importar mayúsculas) y el de OTRO bot se ignora", () => {
    expect(text("/resumen@uzfinanceinventadobot", BOT)).toBe("resumen");
    expect(text("/resumen@UZFINANCEINVENTADOBOT", BOT.toLowerCase())).toBe("resumen");
    expect(text("/resumen@OtroBot", BOT)).toEqual({ ignore: "other-bot" });
    expect(text("/id@OtroBot", BOT)).toEqual({ ignore: "other-bot" });
    expect(text("/foo@OtroBot bar", BOT)).toEqual({ ignore: "other-bot" });
  });
  it("comandos desconocidos pasan como texto normal sin la /", () => {
    expect(text("/foo")).toBe("foo");
    expect(text("/foo bar baz")).toBe("foo bar baz");
    expect(text("/350 starbucks amex")).toBe("350 starbucks amex");
    expect(text("/Foo@OtroBotSinConfigurar x")).toBe("Foo x");
  });
  it("lo que no parece comando se devuelve sin la / inicial; un texto sin / no cambia", () => {
    expect(text("/")).toBe("");
    expect(text("/ hola")).toBe("hola");
    expect(text("/1,250.50 gasolina")).toBe("1,250.50 gasolina");
    expect(text("/hoy,")).toBe("hoy,");
    expect(text("350 starbucks")).toBe("350 starbucks");
    expect(text("hola /ayuda")).toBe("hola /ayuda");
  });
  it("/id (con argumentos o @Bot propio) es kind id, nunca texto", () => {
    expect(text("/id")).toEqual({ id: true });
    expect(text("/ID")).toEqual({ id: true });
    expect(text("/id algo")).toEqual({ id: true });
    expect(text("/id@UzFinanceInventadoBot", BOT)).toEqual({ id: true });
  });

  it("en extractUpdates: /id devuelve ids de usuario y chat; en grupo con chat negativo", () => {
    const r = one(update(9, { text: "/id", from: user(TG.intruso), chat: groupChat(-1001111, "supergroup") }));
    expect(r.items).toEqual([{ kind: "id", userId: "999999999", chatId: "-1001111", chatType: "supergroup" }]);
    expect(one(textUpdate(9, "/id")).items).toEqual([{ kind: "id", userId: "111111111", chatId: "111111111", chatType: "private" }]);
  });
  it("en extractUpdates: /resumen@OtroBot en un grupo se ignora si el bot es conocido", () => {
    const body = update(10, { text: "/resumen@OtroBot", chat: groupChat() });
    expect(one(body, BOT).stats.reasons).toEqual({ "other-bot": 1 });
    expect(one(body, null).items).toHaveLength(1);
  });
  it("los comandos no cambian el id ni el remitente", () => {
    expect(msgOf(textUpdate(11, "/hoy"))).toMatchObject({ id: "tg:11", from: "tg111111111", text: "hoy" });
  });
});

describe("modo grupo (TELEGRAM_ALLOWED_CHATS y mensajes dirigidos al bot)", () => {
  const BOTUSER = user(777000111, { is_bot: true, username: BOT });
  const grp = (id: number, text: string | undefined, over: Record<string, unknown> = {}, chat = TG.group) =>
    update(id, { text, from: user(TG.uziel), chat: groupChat(chat), ...over });
  const reasons = (body: unknown, bot: string | null = BOT, chats: string[] = CHATS) => one(body, bot, chats).stats.reasons;
  const textOf = (body: unknown, bot: string | null = BOT, chats: string[] = CHATS) => {
    const it = one(body, bot, chats).items[0];
    return it?.kind === "message" ? it.message.text : undefined;
  };

  it("chat de grupo que NO está en la lista (o lista vacía/omitida) se ignora por completo, incluso un comando", () => {
    expect(reasons(grp(1, "/resumen"), BOT, [])).toEqual({ "group-not-allowed": 1 });
    expect(reasons(grp(2, "350 starbucks"), BOT, ["-999"])).toEqual({ "group-not-allowed": 1 });
    expect(extractUpdates(grp(3, "/resumen"), { botUsername: BOT }).stats.reasons).toEqual({ "group-not-allowed": 1 });
    expect(extractUpdates(grp(4, "/resumen")).items).toEqual([]);
  });
  it("también aplica a type 'group', no solo supergrupos", () => {
    expect(reasons(update(5, { text: "/hoy", chat: groupChat(-77, "group") }), BOT, [])).toEqual({ "group-not-allowed": 1 });
  });
  it("/id funciona SIEMPRE, también en un grupo no permitido (así se descubre el id del chat)", () => {
    const r = one(grp(6, "/id", { from: user(TG.intruso) }, -4242), BOT, []);
    expect(r.items).toEqual([{ kind: "id", userId: "999999999", chatId: "-4242", chatType: "supergroup" }]);
  });
  it("chat permitido: charla sin comando, respuesta ni mención → ignorada (group-chatter)", () => {
    expect(reasons(grp(7, "nos vemos a las 8"))).toEqual({ "group-chatter": 1 });
    expect(reasons(grp(8, "350 starbucks amex"))).toEqual({ "group-chatter": 1 });
    expect(reasons(grp(9, "sí"))).toEqual({ "group-chatter": 1 });
  });
  it("chat permitido: un comando con / se procesa (con chatType)", () => {
    const r = one(grp(10, "/resumen"));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: "message", chatType: "supergroup", message: { text: "resumen", replyTo: String(TG.group), from: "tg111111111" } });
  });
  it("una mención al bot se procesa y se quita del texto", () => {
    expect(textOf(grp(11, `@${BOT} 350 starbucks amex`))).toBe("350 starbucks amex");
    expect(textOf(grp(12, `350 starbucks @${BOT.toUpperCase()}`))).toBe("350 starbucks");
    expect(textOf(grp(13, `@${BOT}`))).toBe("ayuda");
  });
  it("la mención debe ser exacta: otro usuario o prefijo parecido no cuenta", () => {
    expect(reasons(grp(14, `@${BOT}2 hola 350`))).toEqual({ "group-chatter": 1 });
    expect(reasons(grp(15, "@OtroBot 350 starbucks"))).toEqual({ "group-chatter": 1 });
    expect(reasons(grp(16, `correo a${"@"}${BOT}`))).toEqual({ "group-chatter": 1 });
  });
  it("sin usuario del bot conocido no se puede detectar una mención", () => {
    expect(reasons(grp(17, `@${BOT} 350 starbucks`), null)).toEqual({ "group-chatter": 1 });
  });
  it("una respuesta a un mensaje del bot se procesa (con el usuario del bot, solo si es el nuestro)", () => {
    expect(textOf(grp(18, "amex", { reply_to_message: { message_id: 1, from: BOTUSER, chat: groupChat() } }))).toBe("amex");
    const otro = { message_id: 1, from: user(5, { is_bot: true, username: "OtroBot" }) };
    expect(reasons(grp(19, "amex", { reply_to_message: otro }))).toEqual({ "group-chatter": 1 });
    expect(textOf(grp(20, "amex", { reply_to_message: otro }), null)).toBe("amex"); // usuario desconocido: cualquier bot
  });
  it("responder a una PERSONA no cuenta; tampoco un reply malformado", () => {
    expect(reasons(grp(21, "amex", { reply_to_message: { message_id: 1, from: user(TG.ana) } }))).toEqual({ "group-chatter": 1 });
    for (const bad of [null, "x", 5, { from: "x" }, { from: { id: -1, is_bot: true } }, {}]) {
      expect(reasons(grp(22, "amex", { reply_to_message: bad }))).toEqual({ "group-chatter": 1 });
    }
  });
  it("archivos en grupo: solo con respuesta al bot o mención en el pie; si no, se ignoran", () => {
    const doc = { file_id: "BQACAgQAAxkBAAIB-ejemplo", file_name: "e.pdf", mime_type: "application/pdf" };
    expect(reasons(update(23, { document: doc, chat: groupChat() }))).toEqual({ "group-chatter": 1 });
    const viaReply = one(update(24, { document: doc, chat: groupChat(), reply_to_message: { message_id: 1, from: BOTUSER } }), BOT);
    expect(viaReply.items[0]).toMatchObject({ chatType: "supergroup", message: { type: "document" } });
    expect(one(update(25, { document: doc, chat: groupChat(), caption: `@${BOT} estado` }), BOT).items).toHaveLength(1);
    expect(reasons(update(26, { document: doc, chat: groupChat() }), BOT, [])).toEqual({ "group-not-allowed": 1 });
  });
  it("chat privado: nada cambia (sin lista, sin respuesta ni mención)", () => {
    const r = one(textUpdate(27, "350 starbucks amex"), BOT, []);
    expect(r.items[0]).toMatchObject({ kind: "message", chatType: "private", message: { text: "350 starbucks amex" } });
    expect(one(update(28, { document: { file_id: "BQACAgQAAxkBAAIB-ejemplo" } }), BOT, []).items[0]).toMatchObject({ chatType: "private" });
  });
  it("el mensaje de un bot en un grupo permitido sigue ignorándose", () => {
    expect(reasons(grp(29, "/hoy", { from: BOTUSER }))).toEqual({ bot: 1 });
  });
});
