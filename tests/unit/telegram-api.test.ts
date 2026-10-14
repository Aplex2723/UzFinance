import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelegramIO, deleteTelegramWebhook, getMe, isSafeFilePath, MAX_SEND_CHARS, setTelegramWebhook, truncateForTelegram } from "@/lib/telegram/api";
import { TG } from "../tg-webhook-fixtures";

type Call = { url: string; init: RequestInit };
type Responder = (call: Call) => Response | Promise<Response>;

/** fetch falso: cada llamada consume el siguiente responder (el último se repite). Nada de red real. */
function fakeFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return responders[Math.min(calls.length - 1, responders.length - 1)](call);
  }) as typeof fetch;
  return { f, calls };
}
const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const ok: Responder = () => jsonRes({ ok: true, result: { message_id: 1 } });
const hang: Responder = ({ init }) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
const err = (status: number, description: string, extra: Record<string, unknown> = {}): Responder => () => jsonRes({ ok: false, error_code: status, description, ...extra }, status);
const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { status, headers });
const bytes = (s: string) => new TextEncoder().encode(s);

const FILE_ID = "BQACAgQAAxkBAAIB-ejemplo-inventado";
const fileInfo = (file_path: string, file_size?: number): Responder => () => jsonRes({ ok: true, result: { file_id: FILE_ID, file_unique_id: "u", ...(file_size === undefined ? {} : { file_size }), file_path } });

const mk = (f: typeof fetch, extra: Partial<Parameters<typeof createTelegramIO>[0]> = {}) => createTelegramIO({ botToken: TG.token, fetchImpl: f, retryDelayMs: 0, ...extra });

let logs: string[];
beforeEach(() => {
  logs = [];
  const grab = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

/** Ningún mensaje de error ni log puede contener el token (ni su mitad secreta) ni el id de chat. */
const clean = (...texts: string[]) => {
  for (const s of [...texts, ...logs]) {
    expect(s).not.toContain(TG.token);
    expect(s).not.toContain(TG.token.split(":")[1]);
    expect(s).not.toContain("api.telegram.org");
    expect(s).not.toContain(String(TG.alex));
  }
};
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("debía fallar");
};

describe("sendText", () => {
  it("quita las *negritas* estilo WhatsApp de los textos fijos (Telegram va sin parse_mode) y no toca el resto", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText("1", "✅ *Registrado*\n$350.00 en *Starbucks* (a * b)\n• 2 * 3 = 6");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.text).toBe("✅ Registrado\n$350.00 en Starbucks (a * b)\n• 2 * 3 = 6");
    expect(body.text).not.toMatch(/\*[^ *\n][^*\n]*\*/);
  });
  it("URL, método, cabeceras y cuerpo exactos: texto plano, sin parse_mode", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText(String(TG.alex), "Hola mundo <b>x</b>");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TG.token}/sendMessage`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toEqual({ chat_id: "111111111", text: "Hola mundo <b>x</b>", disable_web_page_preview: true });
    expect(body).not.toHaveProperty("parse_mode");
    expect(calls[0].init.signal).toBeDefined();
    expect(calls[0].init.redirect).toBe("error");
  });
  it("chat de grupo (negativo) y 'tg<id>' (si el handler no usa replyTo)", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText("-1001234567890", "a");
    await mk(f).sendText("tg111111111", "b");
    expect(JSON.parse(calls[0].init.body as string).chat_id).toBe("-1001234567890");
    expect(JSON.parse(calls[1].init.body as string).chat_id).toBe("111111111");
  });
  it.each([["vacío", ""], ["con letras", "abc"], ["inyección", "1/../x"], ["muy largo", "1".repeat(30)]])("destinatario %s → no llama y no lanza", async (_n, to) => {
    const { f, calls } = fakeFetch(ok);
    await expect(mk(f).sendText(to, "hola")).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
  it("cuerpo vacío o en blanco → no llama", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText("1", "   ");
    expect(calls).toHaveLength(0);
  });
  it("trunca a 4096 con elipsis", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText("1", "x".repeat(9000));
    const t = JSON.parse(calls[0].init.body as string).text as string;
    expect(t).toHaveLength(MAX_SEND_CHARS);
    expect(t.endsWith("…")).toBe(true);
  });
  it("no parte un emoji por la mitad al truncar", () => {
    const s = "x".repeat(MAX_SEND_CHARS - 2) + "😀😀";
    const t = truncateForTelegram(s);
    expect(t.length).toBeLessThanOrEqual(MAX_SEND_CHARS);
    expect(t.endsWith("😀…") || t.endsWith("x…")).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(t)).toBe(false);
    expect(truncateForTelegram("corto")).toBe("corto");
  });
  it("429 con retry_after ≤ 5 s → un reintento que respeta la espera", async () => {
    vi.useFakeTimers();
    try {
      const { f, calls } = fakeFetch(err(429, "Too Many Requests: retry after 2", { parameters: { retry_after: 2 } }), ok);
      const p = mk(f).sendText("1", "hola");
      await vi.advanceTimersByTimeAsync(1900);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await p;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    expect(logs.join("\n")).toContain("status=429 error_code=429 (reintento)");
  });
  it("429 con retry_after > 5 s → no se reintenta", async () => {
    const { f, calls } = fakeFetch(err(429, "Too Many Requests", { parameters: { retry_after: 30 } }), ok);
    await mk(f).sendText("1", "hola");
    expect(calls).toHaveLength(1);
  });
  it("5xx → un reintento; si vuelve a fallar, se rinde sin lanzar (máx. 2 llamadas)", async () => {
    const a = fakeFetch(err(502, "Bad Gateway"), ok);
    await mk(a.f).sendText("1", "hola");
    expect(a.calls).toHaveLength(2);
    const b = fakeFetch(err(500, "x"));
    await expect(mk(b.f).sendText("1", "hola")).resolves.toBeUndefined();
    expect(b.calls).toHaveLength(2);
  });
  it("4xx (400/403) → sin reintento, sin lanzar; loguea status y error_code", async () => {
    const { f, calls } = fakeFetch(err(403, "Forbidden: bot was blocked by the user"));
    await mk(f).sendText("1", "hola");
    expect(calls).toHaveLength(1);
    const all = logs.join("\n");
    expect(all).toContain("status=403 error_code=403");
    expect(all).not.toContain("blocked");
  });
  it("cuerpo de error ilegible → error_code=?", async () => {
    const { f } = fakeFetch(() => new Response("<html>502</html>", { status: 502 }), ok);
    await mk(f).sendText("1", "x");
    expect(logs.join("\n")).toContain("error_code=?");
  });
  it("tiempo agotado → no reintenta y no lanza", async () => {
    const { f, calls } = fakeFetch(hang);
    await expect(mk(f, { sendTimeoutMs: 20 }).sendText("1", "hola")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("tiempo agotado");
  });
  it("error de red → no lanza y el log no trae el token ni el chat", async () => {
    const { f } = fakeFetch(() => { throw new TypeError(`fetch failed https://api.telegram.org/bot${TG.token}/sendMessage`); });
    await expect(mk(f).sendText(String(TG.alex), "hola")).resolves.toBeUndefined();
    clean();
    expect(logs.join("\n")).toContain("error de red");
  });
  it("nada de lo que loguea contiene el token ni el cuerpo, en ningún escenario", async () => {
    for (const r of [err(429, "x", { parameters: { retry_after: 1 } }), err(500, `error con ${TG.token}`), err(403, "bot bloqueado")]) {
      await mk(fakeFetch(r).f).sendText(String(TG.alex), "gasto secreto farmacia-inventada");
    }
    clean();
    expect(logs.join("\n")).not.toContain("farmacia-inventada");
  });
});

describe("downloadMedia", () => {
  const PDF = bytes("%PDF-1.4 contenido inventado");
  const happy = (path = "documents/file_12.pdf", size = PDF.length, extra: Record<string, string> = {}) =>
    fakeFetch(fileInfo(path, size), () => stream([PDF.slice(0, 5), PDF.slice(5)], extra));

  it("getFile y descarga: URLs, métodos y resultado (PDF por extensión)", async () => {
    const { f, calls } = happy();
    const r = await mk(f).downloadMedia(FILE_ID, 1_000_000);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TG.token}/getFile`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ file_id: FILE_ID });
    expect(calls[1].url).toBe(`https://api.telegram.org/file/bot${TG.token}/documents/file_12.pdf`);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[1].init.redirect).toBe("manual");
    expect(r.mimeType).toBe("application/pdf");
    expect(Buffer.from(r.bytes).toString()).toBe("%PDF-1.4 contenido inventado");
    clean();
  });
  it("PDF por los bytes (%PDF-) aunque la ruta no tenga extensión; si no, octet-stream", async () => {
    const a = fakeFetch(fileInfo("documents/file_13", PDF.length), () => stream([PDF]));
    expect((await mk(a.f).downloadMedia(FILE_ID, 1e6)).mimeType).toBe("application/pdf");
    const b = fakeFetch(fileInfo("documents/file_14.bin", 3), () => stream([bytes("abc")]));
    expect((await mk(b.f).downloadMedia(FILE_ID, 1e6)).mimeType).toBe("application/octet-stream");
    const c = fakeFetch(fileInfo("photos/file_1.jpg", 3), () => stream([bytes("abc")], { "content-type": "application/pdf" }));
    expect((await mk(c.f).downloadMedia(FILE_ID, 1e6)).mimeType).toBe("application/octet-stream"); // no se confía en el Content-Type
  });
  it("sin file_size en getFile también funciona (el tope duro protege)", async () => {
    const { f } = fakeFetch(fileInfo("documents/a.pdf"), () => stream([PDF]));
    expect((await mk(f).downloadMedia(FILE_ID, 1e6)).bytes.byteLength).toBe(PDF.length);
  });

  it.each([
    ["con ..", "documents/../../etc/passwd"],
    ["con .. al final", "documents/.."],
    ["con esquema", "https://evil.example/x.pdf"],
    ["esquema sin //", "javascript:alert(1)"],
    ["absoluta", "/documents/x.pdf"],
    ["con //", "documents//x.pdf"],
    ["segmento .", "documents/./x.pdf"],
    ["con @ (credenciales)", "user@evil.example/x.pdf"],
    ["con ?", "documents/x.pdf?x=1"],
    ["con #", "documents/x.pdf#a"],
    ["con espacios", "documents/mi archivo.pdf"],
    ["con %2e", "documents/%2e%2e/x"],
    ["con backslash", "documents\\x.pdf"],
    ["vacía", ""],
    ["demasiado larga", "a".repeat(301)],
  ])("file_path malicioso (%s) → rechazado SIN segunda llamada", async (_n, path) => {
    const { f, calls } = fakeFetch(fileInfo(path, 10), () => stream([bytes("x")]));
    const msg = await failure(mk(f).downloadMedia(FILE_ID, 1e6));
    expect(msg).toBe("Respuesta de Telegram inválida");
    expect(calls).toHaveLength(1);
    clean(msg);
  });
  it("file_path de tipo erróneo o ausente → rechazado", async () => {
    for (const path of [undefined, 5, null, ["a"], {}]) {
      const { f, calls } = fakeFetch(() => jsonRes({ ok: true, result: { file_path: path } }));
      expect(await failure(mk(f).downloadMedia(FILE_ID, 1e6))).toBe("Respuesta de Telegram inválida");
      expect(calls).toHaveLength(1);
    }
  });
  it("isSafeFilePath acepta rutas normales de Telegram", () => {
    for (const p of ["documents/file_12.pdf", "photos/file_3.jpg", "voice/file_0.oga", "a-b_c/d.e-f"]) expect(isSafeFilePath(p)).toBe(true);
  });

  it("file_size declarado mayor al tope → rechaza sin descargar", async () => {
    const { f, calls } = fakeFetch(fileInfo("documents/a.pdf", 5_000_000), () => stream([PDF]));
    expect(await failure(mk(f).downloadMedia(FILE_ID, 1000))).toBe("El archivo es demasiado grande");
    expect(calls).toHaveLength(1);
  });
  it("file_size justo en el tope se acepta", async () => {
    const { f } = fakeFetch(fileInfo("documents/a.pdf", PDF.length), () => stream([PDF]));
    await expect(mk(f).downloadMedia(FILE_ID, PDF.length)).resolves.toBeDefined();
  });
  it("Content-Length mayor al tope → rechaza y cancela", async () => {
    const { f } = fakeFetch(fileInfo("documents/a.pdf", 10), () => stream([PDF], { "content-length": "999999" }));
    expect(await failure(mk(f).downloadMedia(FILE_ID, 1000))).toBe("El archivo es demasiado grande");
  });
  it("stream que se pasa del tope (mentiras en file_size y Content-Length) → corta y cancela", async () => {
    let cancelled = false;
    let pulled = 0;
    const big = new Response(
      new ReadableStream({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(400));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    const { f } = fakeFetch(fileInfo("documents/a.pdf", 10), () => big);
    expect(await failure(mk(f).downloadMedia(FILE_ID, 1000))).toBe("El archivo es demasiado grande");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
  it("getFile responde 'file is too big' (archivo > 20 MB) → mensaje de tamaño", async () => {
    const { f } = fakeFetch(err(400, "Bad Request: file is too big"));
    expect(await failure(mk(f).downloadMedia(FILE_ID, 1e6))).toBe("El archivo es demasiado grande");
    expect(logs.join("\n")).toContain("status=400 error_code=400");
    clean();
  });
  it("getFile con otro error → mensaje fijo; el log trae solo status y code", async () => {
    const { f } = fakeFetch(err(401, `Unauthorized ${TG.token}`));
    const msg = await failure(mk(f).downloadMedia(FILE_ID, 1e6));
    expect(msg).toBe("Telegram no entregó el archivo");
    clean(msg);
  });
  it("getFile con ok:false pero HTTP 200, o JSON inválido → 'Respuesta de Telegram inválida'", async () => {
    for (const r of [() => jsonRes({ ok: false }), () => new Response("no json"), () => jsonRes({ ok: true })]) {
      expect(await failure(mk(fakeFetch(r).f).downloadMedia(FILE_ID, 1e6))).toBe("Respuesta de Telegram inválida");
    }
  });

  it("host distinto: un redirect en getFile o en la descarga se rechaza y NUNCA se sigue", async () => {
    const evil = "https://evil.example/robo";
    const a = fakeFetch(() => new Response(null, { status: 302, headers: { location: evil } }));
    expect(await failure(mk(a.f).downloadMedia(FILE_ID, 1e6))).toBe("Origen del archivo no permitido");
    expect(a.calls).toHaveLength(1);
    const b = fakeFetch(fileInfo("documents/a.pdf", 10), () => new Response(null, { status: 301, headers: { location: evil } }));
    expect(await failure(mk(b.f).downloadMedia(FILE_ID, 1e6))).toBe("Origen del archivo no permitido");
    expect(b.calls).toHaveLength(2);
    for (const c of [...a.calls, ...b.calls]) expect(new URL(c.url).hostname).toBe("api.telegram.org");
    clean();
  });
  it("todas las llamadas van a api.telegram.org por https", async () => {
    const { f, calls } = happy();
    await mk(f).downloadMedia(FILE_ID, 1e6);
    for (const c of calls) expect(new URL(c.url).origin).toBe("https://api.telegram.org");
  });
  it("la descarga con status de error → mensaje fijo, sin la URL", async () => {
    const { f } = fakeFetch(fileInfo("documents/a.pdf", 10), () => new Response("nope", { status: 404 }));
    const msg = await failure(mk(f).downloadMedia(FILE_ID, 1e6));
    expect(msg).toBe("No se pudo descargar el archivo");
    expect(logs.join("\n")).toContain("status=404");
    clean(msg);
  });
  it.each([
    ["vacío", ""],
    ["corto", "abc"],
    ["con /", "a/b/c/d/e/f/g/h/i/j"],
    ["con espacios", "abcdefghij klmno"],
    ["con caracteres de URL", "abcdefghij?x=1"],
    ["demasiado largo", "a".repeat(201)],
  ])("fileId inválido (%s) → no llama a la red", async (_n, id) => {
    const { f, calls } = fakeFetch(ok);
    expect(await failure(mk(f).downloadMedia(id, 1e6))).toBe("Identificador de archivo inválido");
    expect(calls).toHaveLength(0);
  });
  it("error de red con el token en el mensaje original → mensaje fijo, sin cause", async () => {
    const { f } = fakeFetch(() => { throw new TypeError(`fetch failed ${TG.token}`, { cause: new Error(`https://api.telegram.org/file/bot${TG.token}/x`) }); });
    let caught: Error | undefined;
    try {
      await mk(f).downloadMedia(FILE_ID, 1e6);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("No se pudo descargar el archivo");
    expect(caught?.cause).toBeUndefined();
    clean(caught!.message, String(caught!.stack));
  });
  it("tiempo agotado → mensaje de tiempo", async () => {
    const { f } = fakeFetch(hang);
    expect(await failure(mk(f, { mediaTimeoutMs: 20 }).downloadMedia(FILE_ID, 1e6))).toBe("Se agotó el tiempo al descargar el archivo");
  });
  it("mensajes de tamaño: los que reconoce el handler (grande)", async () => {
    const { f } = fakeFetch(fileInfo("documents/a.pdf", 10_000_000));
    expect(await failure(mk(f).downloadMedia(FILE_ID, 12 * 1024 * 1024 - 1 - 9_000_000))).toMatch(/grande/);
  });
});

describe("getMe, setTelegramWebhook y deleteTelegramWebhook (fetch falso)", () => {
  it("getMe devuelve id y @usuario", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ ok: true, result: { id: 123456789, is_bot: true, first_name: "UzFinance", username: "UzFinanceInventadoBot" } }));
    expect(await getMe({ botToken: TG.token, fetchImpl: f })).toEqual({ id: 123456789, username: "UzFinanceInventadoBot", firstName: "UzFinance" });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TG.token}/getMe`);
  });
  it("getMe con token rechazado → error sin el token; sin llamar si el formato es inválido", async () => {
    const a = fakeFetch(err(401, "Unauthorized"));
    const msg = await failure(getMe({ botToken: TG.token, fetchImpl: a.f }));
    expect(msg).toContain("401");
    clean(msg);
    const b = fakeFetch(ok);
    expect(await failure(getMe({ botToken: "malo", fetchImpl: b.f }))).toBe("Token del bot inválido");
    expect(b.calls).toHaveLength(0);
  });
  it("getMe con respuesta sin username o error de red → errores fijos", async () => {
    expect(await failure(getMe({ botToken: TG.token, fetchImpl: fakeFetch(() => jsonRes({ ok: true, result: { id: 1 } })).f }))).toBe("Respuesta de Telegram inválida");
    const msg = await failure(getMe({ botToken: TG.token, fetchImpl: fakeFetch(() => { throw new Error(`boom ${TG.token}`); }).f }));
    expect(msg).toBe("No se pudo contactar a Telegram");
  });
  it("setTelegramWebhook manda url, secret_token, allowed_updates=[message], max_connections=5 y drop_pending_updates", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ ok: true, result: true, description: "Webhook was set" }));
    await setTelegramWebhook({ botToken: TG.token, url: "https://uz-inventada.azurewebsites.net/api/telegram", secret: TG.secret, fetchImpl: f });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TG.token}/setWebhook`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      url: "https://uz-inventada.azurewebsites.net/api/telegram", secret_token: TG.secret, allowed_updates: ["message"], max_connections: 5, drop_pending_updates: true,
    });
  });
  it("setTelegramWebhook valida url (https, sin credenciales) y secreto antes de llamar", async () => {
    const { f, calls } = fakeFetch(ok);
    for (const url of ["http://x.net/api/telegram", "no-url", "https://u:p@x.net/api/telegram"]) {
      expect(await failure(setTelegramWebhook({ botToken: TG.token, url, secret: TG.secret, fetchImpl: f }))).toBe("URL del webhook inválida");
    }
    expect(await failure(setTelegramWebhook({ botToken: TG.token, url: "https://x.net/a", secret: "corto", fetchImpl: f }))).toBe("Secreto del webhook inválido");
    expect(calls).toHaveLength(0);
  });
  it("setTelegramWebhook con rechazo de Telegram → error sin token ni secreto", async () => {
    const { f } = fakeFetch(err(400, "Bad Request: bad webhook"));
    const msg = await failure(setTelegramWebhook({ botToken: TG.token, url: "https://x.net/a", secret: TG.secret, fetchImpl: f }));
    expect(msg).toContain("400");
    expect(msg).not.toContain(TG.secret);
    clean(msg);
  });
  it("deleteTelegramWebhook", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ ok: true, result: true }));
    await deleteTelegramWebhook({ botToken: TG.token, fetchImpl: f, dropPendingUpdates: false });
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TG.token}/deleteWebhook`);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ drop_pending_updates: false });
  });
});
