/** Datos 100 % inventados. */
export const TG = {
  token: "123456789:AAH-token_inventado_0123456789abcdefg",
  secret: "secreto-inventado-telegram-0123456789abcdef",
  allowed: "111111111=Uziel,222222222=Ana",
  uziel: 111111111,
  ana: 222222222,
  intruso: 999999999,
  botUsername: "UzFinanceInventadoBot",
  /** Supergrupo de ejemplo (id negativo). */
  group: -1001234567890,
};

export const TG_ENV = {
  TELEGRAM_BOT_TOKEN: TG.token,
  TELEGRAM_WEBHOOK_SECRET: TG.secret,
  TELEGRAM_ALLOWED: TG.allowed,
};

type Obj = Record<string, unknown>;

export const user = (id: number, over: Obj = {}): Obj => ({ id, is_bot: false, first_name: "Nombre Inventado", language_code: "es", ...over });
export const privateChat = (id: number): Obj => ({ id, type: "private", first_name: "Nombre Inventado" });
export const groupChat = (id = TG.group, type = "supergroup"): Obj => ({ id, type, title: "Casa inventada" });

/** Update de Telegram con un `message`; `over` se mezcla sobre el mensaje (usa `undefined` para quitar un campo). */
export function update(updateId: number, over: Obj = {}, extra: Obj = {}): Obj {
  const message: Obj = { message_id: updateId + 1000, from: user(TG.uziel), chat: privateChat(TG.uziel), date: 1790000000, ...over };
  for (const k of Object.keys(message)) if (message[k] === undefined) delete message[k];
  return { update_id: updateId, message, ...extra };
}

export const textUpdate = (updateId: number, text: string, over: Obj = {}) => update(updateId, { text, ...over });
export const groupText = (updateId: number, text: string, fromId = TG.uziel, chatId = TG.group) =>
  update(updateId, { text, from: user(fromId), chat: groupChat(chatId) });
/** El bot como remitente de un mensaje (para `reply_to_message`). */
export const botUser = (username = TG.botUsername): Obj => ({ id: 777000111, is_bot: true, first_name: "Bot inventado", username });
/** Mensaje de grupo (permitido) que RESPONDE a un mensaje del bot. */
export const groupReply = (updateId: number, text: string, fromId = TG.uziel, chatId = TG.group) =>
  update(updateId, { text, from: user(fromId), chat: groupChat(chatId), reply_to_message: { message_id: 1, from: botUser(), chat: groupChat(chatId), text: "pregunta del bot" } });
export const secretHeader = (secret = TG.secret) => ({ "x-telegram-bot-api-secret-token": secret });
