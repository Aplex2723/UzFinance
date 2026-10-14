import { describe, expect, it } from "vitest";
import { findSender, getTelegramConfig, maskId, parseAllowed, parseAllowedChats, telegramConfigIssues } from "@/lib/telegram/config";
import { TG, TG_ENV } from "../tg-webhook-fixtures";

describe("getTelegramConfig", () => {
  it("configuración completa válida", () => {
    const c = getTelegramConfig({ ...TG_ENV, TELEGRAM_BOT_USERNAME: "@UzFinanceInventadoBot", WEBSITE_HOSTNAME: "Uz-Inventada.azurewebsites.net" });
    expect(c).toEqual({
      botToken: TG.token,
      webhookSecret: TG.secret,
      allowed: [{ waId: "tg111111111", name: "Alex" }, { waId: "tg222222222", name: "Sam" }],
      allowedChats: [],
      botUsername: "uzfinanceinventadobot",
      appUrl: "https://uz-inventada.azurewebsites.net",
    });
  });

  it("todo vacío o ausente → null (falla cerrado) y nombra las variables, nunca valores", () => {
    expect(getTelegramConfig({})).toBeNull();
    expect(telegramConfigIssues({})).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]);
    expect(getTelegramConfig({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_WEBHOOK_SECRET: "" })).toBeNull();
  });

  it.each([
    ["sin token", { TELEGRAM_BOT_TOKEN: undefined }],
    ["sin secreto", { TELEGRAM_WEBHOOK_SECRET: undefined }],
    ["token sin dos puntos", { TELEGRAM_BOT_TOKEN: "123456789AAH-token_inventado_0123456789abcdefg" }],
    ["token con id corto", { TELEGRAM_BOT_TOKEN: "12345:AAH-token_inventado_0123456789abcdefg" }],
    ["token con id largo", { TELEGRAM_BOT_TOKEN: "1234567890123:AAH-token_inventado_0123456789abcdefg" }],
    ["token con parte secreta corta", { TELEGRAM_BOT_TOKEN: "123456789:corto" }],
    ["token con parte secreta larga", { TELEGRAM_BOT_TOKEN: "123456789:" + "a".repeat(51) }],
    ["token con caracteres raros", { TELEGRAM_BOT_TOKEN: "123456789:AAH token inventado 0123456789abcdefg" }],
    ["token con id no numérico", { TELEGRAM_BOT_TOKEN: "abc456789:AAH-token_inventado_0123456789abcdefg" }],
    ["secreto corto", { TELEGRAM_WEBHOOK_SECRET: "a".repeat(31) }],
    ["secreto largo", { TELEGRAM_WEBHOOK_SECRET: "a".repeat(257) }],
    ["secreto con caracteres raros", { TELEGRAM_WEBHOOK_SECRET: "secreto con espacios 0123456789abcdef!" }],
    ["lista de autorizados inválida", { TELEGRAM_ALLOWED: "no-es-un-id=Alex" }],
    ["chats permitidos inválidos", { TELEGRAM_ALLOWED_CHATS: "-100123,basura" }],
    ["usuario del bot inválido", { TELEGRAM_BOT_USERNAME: "no válido!" }],
  ] as [string, Record<string, string | undefined>][])("%s → null", (_n, over) => {
    expect(getTelegramConfig({ ...TG_ENV, ...over })).toBeNull();
  });

  it("lista de autorizados vacía o en blanco es VÁLIDA (modo descubrimiento)", () => {
    expect(getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED: "" })!.allowed).toEqual([]);
    expect(getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED: "   " })!.allowed).toEqual([]);
    expect(getTelegramConfig({ TELEGRAM_BOT_TOKEN: TG.token, TELEGRAM_WEBHOOK_SECRET: TG.secret })!.allowed).toEqual([]);
  });

  it("sin usuario del bot → null en la config (no se filtran comandos); sin hostname → appUrl null", () => {
    const c = getTelegramConfig(TG_ENV)!;
    expect(c.botUsername).toBeNull();
    expect(c.appUrl).toBeNull();
  });

  it("APP_URL explícita gana sobre WEBSITE_HOSTNAME; con credenciales se descarta", () => {
    expect(getTelegramConfig({ ...TG_ENV, APP_URL: "https://mi.app/ruta", WEBSITE_HOSTNAME: "otro.net" })!.appUrl).toBe("https://mi.app");
    expect(getTelegramConfig({ ...TG_ENV, APP_URL: "https://u:p@mi.app", WEBSITE_HOSTNAME: "otro.net" })!.appUrl).toBe("https://otro.net");
    expect(getTelegramConfig({ ...TG_ENV, APP_URL: "ftp://mi.app" })!.appUrl).toBeNull();
  });

  it("lee process.env por omisión (se evalúa en cada llamada)", () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, TG_ENV);
      expect(getTelegramConfig()).not.toBeNull();
      process.env.TELEGRAM_BOT_TOKEN = "x";
      expect(getTelegramConfig()).toBeNull();
    } finally {
      for (const k of Object.keys(TG_ENV)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("parseAllowed", () => {
  it("de 0 a 5 personas; 6 → null", () => {
    expect(parseAllowed("")).toEqual([]);
    expect(parseAllowed("1=A")).toEqual([{ waId: "tg1", name: "A" }]);
    const five = [1, 2, 3, 4, 5].map((i) => `${i}00000${i}=P${String.fromCharCode(64 + i)}`).join(",");
    expect(parseAllowed(five)).toHaveLength(5);
    expect(parseAllowed(`${five},6000006=Pf`)).toBeNull();
  });
  it("tolera espacios y comas sobrantes", () => {
    expect(parseAllowed(" 123456789 = Alex , 987654321=Sam ,")).toEqual([{ waId: "tg123456789", name: "Alex" }, { waId: "tg987654321", name: "Sam" }]);
  });
  it("acepta nombres con acentos, punto, apóstrofo y guion", () => {
    expect(parseAllowed("123456789=José Ángel Mª-O'Neil Jr.")).toHaveLength(1);
  });
  it.each([
    ["sin igual", "123456789"],
    ["sin id", "=Alex"],
    ["sin nombre", "123456789="],
    ["id con letras", "12345abc=Alex"],
    ["id negativo (un grupo, no una persona)", "-100123456=Casa"],
    ["id con +", "+123456789=Alex"],
    ["id con cero a la izquierda", "0123456789=Alex"],
    ["id cero", "0=Alex"],
    ["id de más de 15 dígitos", "1234567890123456=Alex"],
    ["nombre con dígitos", "123456789=Alex2"],
    ["nombre con símbolos", "123456789=Uz<script>"],
    ["nombre de solo signos", "123456789=..."],
    ["nombre largo", "123456789=" + "a".repeat(31)],
    ["id repetido", "123456789=Alex,123456789=Sam"],
    ["una entrada mala invalida todo", "123456789=Alex,basura"],
  ])("%s → null", (_n, raw) => {
    expect(parseAllowed(raw)).toBeNull();
  });
});

describe("TELEGRAM_ALLOWED_CHATS", () => {
  it("por omisión o vacía es VÁLIDA y da [] (ningún grupo atendido)", () => {
    expect(getTelegramConfig(TG_ENV)!.allowedChats).toEqual([]);
    expect(getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED_CHATS: "  " })!.allowedChats).toEqual([]);
    expect(telegramConfigIssues({ ...TG_ENV, TELEGRAM_ALLOWED_CHATS: "" })).toEqual([]);
  });
  it("lee ids negativos y tolera espacios y comas sobrantes", () => {
    expect(getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED_CHATS: " -1001234567890 , -4000111,"})!.allowedChats).toEqual(["-1001234567890", "-4000111"]);
  });
  it("una lista inválida invalida TODA la configuración (falla cerrado) y nombra la variable", () => {
    expect(getTelegramConfig({ ...TG_ENV, TELEGRAM_ALLOWED_CHATS: "-100123,basura" })).toBeNull();
    expect(telegramConfigIssues({ ...TG_ENV, TELEGRAM_ALLOWED_CHATS: "abc" })).toEqual(["TELEGRAM_ALLOWED_CHATS"]);
  });
  it.each([
    ["texto", "abc"],
    ["cero", "0"],
    ["cero negativo", "-0"],
    ["con cero a la izquierda", "-0100"],
    ["con +", "+100"],
    ["decimal", "-100.5"],
    ["notación científica", "1e5"],
    ["más de 15 dígitos", "-1234567890123456"],
    ["repetidos", "-100,-100"],
    ["con nombre (formato de TELEGRAM_ALLOWED)", "-100=Casa"],
    ["más de 10", Array.from({ length: 11 }, (_, i) => `-${i + 1}00`).join(",")],
  ])("%s → null", (_n, raw) => {
    expect(parseAllowedChats(raw)).toBeNull();
  });
  it("hasta 10 chats", () => {
    expect(parseAllowedChats(Array.from({ length: 10 }, (_, i) => `-${i + 1}00`).join(","))).toHaveLength(10);
  });
});

describe("findSender y maskId", () => {
  const allowed = parseAllowed(TG.allowed)!;
  it("encuentra por 'tg<id>' exacto", () => {
    expect(findSender(allowed, "tg111111111")).toEqual({ waId: "tg111111111", name: "Alex" });
    expect(findSender(allowed, "tg222222222")?.name).toBe("Sam");
  });
  it("no autoriza prefijos, sufijos ni formas parecidas", () => {
    for (const f of ["tg11111111", "tg1111111111", "111111111", "TG111111111", "tg999999999", "", "tg"]) expect(findSender(allowed, f)).toBeNull();
    expect(findSender([], "tg111111111")).toBeNull();
  });
  it("maskId deja solo los últimos 4 dígitos", () => {
    expect(maskId("tg123456789")).toBe("***6789");
    expect(maskId("-1001234567890")).toBe("***7890");
  });
});
