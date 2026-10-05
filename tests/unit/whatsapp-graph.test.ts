import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGraphIO, isMetaMediaUrl, MAX_SEND_CHARS, truncateForWhatsApp } from "@/lib/whatsapp/graph";
import { WA } from "../wa-webhook-fixtures";

type Call = { url: string; init: RequestInit };
type Responder = (call: Call) => Response | Promise<Response>;

/** fetch falso: cada llamada consume el siguiente responder (el último se repite). Nada de red real. */
function fakeFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    const r = responders[Math.min(calls.length - 1, responders.length - 1)];
    return r(call);
  }) as typeof fetch;
  return { f, calls };
}
const jsonRes = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const ok: Responder = () => jsonRes({ messages: [{ id: "wamid.OUT" }] });
const hang: Responder = ({ init }) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));

const MEDIA_URL = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&ext=1&hash=FIRMA-SECRETA-INVENTADA";
const stream = (chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200) =>
  new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); } }), { status, headers });

const mk = (f: typeof fetch, extra: Partial<Parameters<typeof createGraphIO>[0]> = {}) =>
  createGraphIO({ accessToken: WA.accessToken, phoneNumberId: WA.phoneNumberId, version: "v23.0", fetchImpl: f, retryDelayMs: 0, ...extra });

let logs: string[];
beforeEach(() => {
  logs = [];
  const grab = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
});
afterEach(() => vi.restoreAllMocks());

/** Ningún mensaje de error ni log puede contener el token, la URL firmada ni el número. */
const clean = (...texts: string[]) => {
  for (const s of [...texts, ...logs]) {
    expect(s).not.toContain(WA.accessToken);
    expect(s).not.toContain("FIRMA-SECRETA");
    expect(s).not.toContain("lookaside");
    expect(s).not.toContain(WA.uziel);
  }
};

describe("sendText", () => {
  it("envío correcto: URL, método, cabeceras y cuerpo exactos", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText(WA.uziel, "Hola *mundo*");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://graph.facebook.com/v23.0/${WA.phoneNumberId}/messages`);
    expect(calls[0].init.method).toBe("POST");
    const h = calls[0].init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${WA.accessToken}`);
    expect(h["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: WA.uziel, type: "text", text: { body: "Hola *mundo*", preview_url: false },
    });
    expect(calls[0].init.signal).toBeDefined();
    expect(calls[0].init.redirect).toBe("error");
  });
  it("usa la versión configurada", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f, { version: "v24.0" }).sendText(WA.uziel, "x");
    expect(calls[0].url).toContain("/v24.0/");
  });
  it("429 → un reintento y termina bien", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ error: { code: 130429, message: "texto con datos" } }, 429), ok);
    await mk(f).sendText(WA.uziel, "hola");
    expect(calls).toHaveLength(2);
    expect(logs.join("\n")).toContain("status=429 code=130429");
    clean();
  });
  it("5xx → un reintento; si vuelve a fallar se rinde (2 llamadas máximo) sin lanzar", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ error: { code: 2 } }, 503));
    await expect(mk(f).sendText(WA.uziel, "hola")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
    clean();
  });
  it("4xx (token vencido, número no permitido) → NO se reintenta y no lanza", async () => {
    const { f, calls } = fakeFetch(() => jsonRes({ error: { code: 190, message: `Token ${WA.accessToken} inválido`, error_data: { details: WA.uziel } } }, 401));
    await expect(mk(f).sendText(WA.uziel, "hola")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("status=401 code=190");
    clean(); // el cuerpo de error de Meta (que podría traer el token o el número) jamás se loguea
  });
  it("cuerpo de error que no es JSON → code=?", async () => {
    const { f } = fakeFetch(() => new Response("<html>caído</html>", { status: 500 }));
    await mk(f).sendText(WA.uziel, "hola");
    expect(logs.join("\n")).toContain("code=?");
  });
  it("tiempo agotado → no lanza, no reintenta, loguea sin detalles", async () => {
    const { f, calls } = fakeFetch(hang);
    await expect(mk(f, { sendTimeoutMs: 20 }).sendText(WA.uziel, "hola")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(logs.join("\n")).toContain("tiempo agotado");
    clean();
  });
  it("error de red → no lanza", async () => {
    const f = (async () => { throw new TypeError(`fetch failed ${WA.accessToken}`); }) as typeof fetch;
    await expect(mk(f).sendText(WA.uziel, "hola")).resolves.toBeUndefined();
    clean();
  });
  it("trunca a 4096 caracteres sin partir un emoji", async () => {
    const { f, calls } = fakeFetch(ok);
    await mk(f).sendText(WA.uziel, "a".repeat(10_000));
    const body = JSON.parse(calls[0].init.body as string).text.body as string;
    expect(body.length).toBe(MAX_SEND_CHARS);
    expect(body.endsWith("…")).toBe(true);
    const emoji = "a".repeat(MAX_SEND_CHARS - 2) + "😀😀";
    const t = truncateForWhatsApp(emoji);
    expect(t.length).toBeLessThanOrEqual(MAX_SEND_CHARS);
    expect(() => encodeURIComponent(t)).not.toThrow(); // un sustituto suelto lanzaría URIError
    expect(truncateForWhatsApp("corto")).toBe("corto");
    expect(truncateForWhatsApp("a".repeat(MAX_SEND_CHARS))).toHaveLength(MAX_SEND_CHARS);
  });
  it("destinatario inválido o cuerpo vacío → no llama a Meta", async () => {
    const { f, calls } = fakeFetch(ok);
    const io = mk(f);
    await io.sendText("../../etc", "hola");
    await io.sendText("", "hola");
    await io.sendText(WA.uziel, "   ");
    expect(calls).toHaveLength(0);
  });
  it("respeta Retry-After (acotado) en 429", async () => {
    vi.useFakeTimers();
    try {
      const { f, calls } = fakeFetch(() => jsonRes({ error: { code: 4 } }, 429, { "retry-after": "1" }), ok);
      const p = mk(f).sendText(WA.uziel, "hola");
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("downloadMedia", () => {
  const meta = (over: Record<string, unknown> = {}): Responder => () => jsonRes({ url: MEDIA_URL, mime_type: "application/pdf", file_size: 5, id: "123456", messaging_product: "whatsapp", ...over });
  const bytes = new Uint8Array([37, 80, 68, 70, 45]); // %PDF-

  it("descarga correcta: metadatos con Bearer y luego la URL con el mismo Bearer", async () => {
    const { f, calls } = fakeFetch(meta(), () => stream([bytes.slice(0, 2), bytes.slice(2)], { "content-type": "application/octet-stream" }));
    const r = await mk(f).downloadMedia("123456", 1000);
    expect(Array.from(r.bytes)).toEqual(Array.from(bytes));
    expect(r.mimeType).toBe("application/pdf");
    expect(calls[0].url).toBe("https://graph.facebook.com/v23.0/123456");
    expect(calls[1].url).toBe(MEDIA_URL);
    for (const c of calls) expect((c.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${WA.accessToken}`);
    expect(calls[1].init.redirect).toBe("manual");
  });
  it("mime: toma el de Meta; si falta, el Content-Type (sin parámetros); si es basura, octet-stream", async () => {
    let r = await mk(fakeFetch(meta({ mime_type: undefined }), () => stream([bytes], { "content-type": "Image/JPEG; charset=binary" })).f).downloadMedia("123456", 100);
    expect(r.mimeType).toBe("image/jpeg");
    r = await mk(fakeFetch(meta({ mime_type: "<script>" }), () => stream([bytes], { "content-type": "no es un mime" })).f).downloadMedia("123456", 100);
    expect(r.mimeType).toBe("application/octet-stream");
    r = await mk(fakeFetch(meta({ mime_type: "audio/ogg; codecs=opus" }), () => stream([bytes])).f).downloadMedia("123456", 100);
    expect(r.mimeType).toBe("audio/ogg");
  });
  it("file_size como texto también se valida", async () => {
    const { f, calls } = fakeFetch(meta({ file_size: "999999" }));
    await expect(mk(f).downloadMedia("123456", 1000)).rejects.toThrow("demasiado grande");
    expect(calls).toHaveLength(1); // no llegó a descargar
  });
  it("file_size declarado > maxBytes → rechaza SIN descargar", async () => {
    const { f, calls } = fakeFetch(meta({ file_size: 2_000_000 }));
    await expect(mk(f).downloadMedia("123456", 1_000_000)).rejects.toThrow("demasiado grande");
    expect(calls).toHaveLength(1);
  });
  it("file_size justo en el tope pasa", async () => {
    const { f } = fakeFetch(meta({ file_size: 5 }), () => stream([bytes]));
    await expect(mk(f).downloadMedia("123456", 5)).resolves.toBeDefined();
  });
  it("stream que se pasa del tope aunque file_size mintió → corta y cancela", async () => {
    let cancelled = false;
    let pulled = 0;
    const big = new Response(new ReadableStream({
      pull(c) { pulled++; c.enqueue(new Uint8Array(400)); },
      cancel() { cancelled = true; },
    }));
    const { f } = fakeFetch(meta({ file_size: 10 }), () => big);
    await expect(mk(f).downloadMedia("123456", 1000)).rejects.toThrow("demasiado grande");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10); // no leyó indefinidamente
  });
  it("Content-Length mayor al tope → rechaza antes de leer", async () => {
    const { f } = fakeFetch(meta({ file_size: 5 }), () => stream([bytes], { "content-length": "99999" }));
    await expect(mk(f).downloadMedia("123456", 1000)).rejects.toThrow("demasiado grande");
  });
  it.each([
    ["host ajeno", "https://evil.example.com/x"],
    ["host parecido", "https://lookaside.fbsbx.com.evil.example/x"],
    ["sufijo sin punto", "https://evilfbcdn.net/x"],
    ["dominio raíz fbcdn.net sin subdominio", "https://fbcdn.net/x"],
    ["http", "http://lookaside.fbsbx.com/x"],
    ["IP", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/x"],
    ["credenciales", "https://user:pw@lookaside.fbsbx.com/x"],
    ["puerto raro", "https://lookaside.fbsbx.com:8443/x"],
    ["esquema file", "file:///etc/passwd"],
    ["no es URL", "no-es-url"],
    ["vacía", ""],
  ])("URL no permitida (%s) → rechaza y NO la pide", async (_n, url) => {
    const { f, calls } = fakeFetch(meta({ url }));
    await expect(mk(f).downloadMedia("123456", 1000)).rejects.toThrow("Origen del archivo no permitido");
    expect(calls).toHaveLength(1);
    clean();
  });
  it.each([
    "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1",
    "https://scontent.xx.fbcdn.net/v/t1/x.jpg",
    "https://mmg.whatsapp.net/v/t62/x",
    "https://graph.facebook.com/v23.0/x",
    "https://LOOKASIDE.FBSBX.COM/x",
    "https://lookaside.fbsbx.com:443/x",
  ])("URL permitida: %s", (u) => expect(isMetaMediaUrl(u)).toBe(true));
  it("respuesta de metadatos sin url / sin JSON → error seguro", async () => {
    await expect(mk(fakeFetch(() => jsonRes({ id: "1" })).f).downloadMedia("123456", 100)).rejects.toThrow("Respuesta de Meta inválida");
    await expect(mk(fakeFetch(() => new Response("no json")).f).downloadMedia("123456", 100)).rejects.toThrow("Respuesta de Meta inválida");
  });
  it("metadatos con error de Meta → mensaje fijo (sin cuerpo)", async () => {
    const { f } = fakeFetch(() => jsonRes({ error: { code: 100, message: `token ${WA.accessToken}` } }, 400));
    const e = await mk(f).downloadMedia("123456", 100).catch((x: Error) => x);
    expect((e as Error).message).toBe("Meta no entregó el archivo");
    clean((e as Error).message);
  });
  it("la URL del medio responde 404 → error seguro sin la URL", async () => {
    const { f } = fakeFetch(meta(), () => new Response("nope", { status: 404 }));
    const e = (await mk(f).downloadMedia("123456", 100).catch((x: Error) => x)) as Error;
    expect(e.message).toBe("No se pudo descargar el archivo");
    clean(e.message);
  });
  it("redirect a host ajeno → rechaza y no manda el token allí", async () => {
    const { f, calls } = fakeFetch(meta(), () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/robo" } }));
    await expect(mk(f).downloadMedia("123456", 100)).rejects.toThrow("Origen del archivo no permitido");
    expect(calls.map((c) => c.url)).not.toContain("https://evil.example.com/robo");
  });
  it("redirect a otro host de Meta se sigue (máx. 2); más saltos → rechaza", async () => {
    const hop = (to: string): Responder => () => new Response(null, { status: 302, headers: { location: to } });
    const r = await mk(fakeFetch(meta(), hop("https://scontent.xx.fbcdn.net/a"), () => stream([bytes])).f).downloadMedia("123456", 100);
    expect(r.bytes).toHaveLength(5);
    const loop = fakeFetch(meta(), hop("https://scontent.xx.fbcdn.net/a"));
    await expect(mk(loop.f).downloadMedia("123456", 100)).rejects.toThrow("Origen del archivo no permitido");
    expect(loop.calls.length).toBeLessThanOrEqual(4);
  });
  it.each(["", "abc", "1234", "12345678901234567890123456789012345678901", "123 456", "../../me", "123456/../x", "1e10000", "123456\n"])("mediaId inválido %j → rechaza sin llamar", async (id) => {
    const { f, calls } = fakeFetch(meta());
    await expect(mk(f).downloadMedia(id, 100)).rejects.toThrow("Identificador de archivo inválido");
    expect(calls).toHaveLength(0);
  });
  it("tiempo agotado → mensaje seguro", async () => {
    const { f } = fakeFetch(hang);
    const e = (await mk(f, { mediaTimeoutMs: 20 }).downloadMedia("123456", 100).catch((x: Error) => x)) as Error;
    expect(e.message).toBe("Se agotó el tiempo al descargar el archivo");
    clean(e.message);
  });
  it("error de red con detalles internos → mensaje genérico sin token ni URL", async () => {
    let n = 0;
    const f = (async () => {
      if (n++ === 0) return jsonRes({ url: MEDIA_URL, file_size: 5 });
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${MEDIA_URL} ${WA.accessToken}`);
    }) as typeof fetch;
    const e = (await mk(f).downloadMedia("123456", 100).catch((x: Error) => x)) as Error;
    expect(e.message).toBe("No se pudo descargar el archivo");
    expect(e.cause).toBeUndefined();
    clean(e.message, e.stack ?? "");
  });
  it("NINGÚN error producido contiene el token", async () => {
    const cases: Responder[][] = [
      [meta({ url: "https://evil.example.com" })],
      [meta({ file_size: 1e9 })],
      [() => jsonRes({}, 500)],
      [meta(), () => new Response("x", { status: 500 })],
    ];
    for (const c of cases) {
      const e = (await mk(fakeFetch(...c).f).downloadMedia("123456", 100).catch((x: Error) => x)) as Error;
      expect(e).toBeInstanceOf(Error);
      clean(e.message, e.stack ?? "");
    }
  });
});
