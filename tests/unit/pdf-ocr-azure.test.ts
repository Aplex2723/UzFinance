import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readImage, resetVisionToken, visionConfig, VisionError } from "@/lib/pdf/ocr-azure";
import { parseBanamexTransfer } from "@/lib/pdf/receipts/banamex-transfer";
import { textPdf } from "../pdf-fixtures";

const EP = "https://demo-vision.cognitiveservices.azure.com";
const cfg = { endpoint: EP };
const png = new Uint8Array([137, 80, 78, 71]);
const sleep = async () => undefined;
const read = (lines: [string, number[]][]) => ({ readResult: { blocks: [{ lines: lines.map(([text, conf]) => ({ text, words: conf.map((confidence) => ({ confidence })) })) }] } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const status = (n: number) => new Response("{}", { status: n });

beforeEach(() => {
  resetVisionToken();
  vi.stubEnv("IDENTITY_ENDPOINT", "http://127.0.0.1:9/msi/token");
  vi.stubEnv("IDENTITY_HEADER", "secret-header");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("visionConfig", () => {
  it("solo acepta https hacia *.cognitiveservices.azure.com (el token no viaja a otro host)", () => {
    expect(visionConfig({ AZURE_VISION_ENDPOINT: `${EP}/` })).toEqual({ endpoint: EP, key: undefined });
    expect(visionConfig({ AZURE_VISION_ENDPOINT: EP, AZURE_VISION_KEY: " k " })?.key).toBe("k");
    for (const bad of ["", "   ", "http://demo.cognitiveservices.azure.com", "https://evil.example.com", "https://demo.cognitiveservices.azure.com.evil.com", "https://user:pw@demo.cognitiveservices.azure.com", "no es url", "https://cognitiveservices.azure.com"])
      expect(visionConfig({ AZURE_VISION_ENDPOINT: bad })).toBeNull();
    expect(visionConfig({})).toBeNull();
  });
});

describe("readImage", () => {
  it("lee las líneas en orden y promedia la confianza de las palabras", async () => {
    const f = vi.fn(async (...a: [string | URL | Request, RequestInit?]) => (String(a[0]).includes("/msi/") ? ok({ access_token: "tok", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) : ok(read([["Monto $231.65 MXN", [0.9, 1]], ["Cuenta  origen", [0.98]]]))));
    const r = await readImage(png, cfg, { fetch: f as unknown as typeof fetch, sleep });
    expect(r).toEqual({ text: "Monto $231.65 MXN\nCuenta origen", confidence: 96 });
    const call = f.mock.calls.find((c) => String(c[0]).startsWith(EP))!;
    expect(String(call[0])).toContain("features=read");
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok", "Content-Type": "application/octet-stream" });
  });

  it("el token de la identidad se reutiliza entre llamadas", async () => {
    const f = vi.fn(async (url: string | URL | Request) => (String(url).includes("/msi/") ? ok({ access_token: "tok", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) : ok(read([["a", [1]]]))));
    await readImage(png, cfg, { fetch: f as unknown as typeof fetch, sleep });
    await readImage(png, cfg, { fetch: f as unknown as typeof fetch, sleep });
    expect(f.mock.calls.filter((c) => String(c[0]).includes("/msi/"))).toHaveLength(1);
  });

  it("con llave (solo pruebas manuales) no pide token", async () => {
    const f = vi.fn(async (...a: [string, RequestInit?]) => (a.length ? ok(read([["a", [1]]])) : ok({})));
    await readImage(png, { endpoint: EP, key: "k1" }, { fetch: f as unknown as typeof fetch, sleep });
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "Ocp-Apim-Subscription-Key": "k1" });
  });

  it("reintenta 429 y 5xx, y falla con VisionError si no se recupera", async () => {
    const seq = [status(429), status(503), ok(read([["listo", [1]]]))];
    const f = vi.fn(async () => seq.shift()!);
    expect((await readImage(png, { endpoint: EP, key: "k" }, { fetch: f as unknown as typeof fetch, sleep })).text).toBe("listo");
    expect(f).toHaveBeenCalledTimes(3);
    const always = vi.fn(async () => status(500));
    await expect(readImage(png, { endpoint: EP, key: "k" }, { fetch: always as unknown as typeof fetch, sleep })).rejects.toBeInstanceOf(VisionError);
    expect(always).toHaveBeenCalledTimes(3);
  });

  it("errores de red también se reintentan; 403 y 400 fallan de inmediato", async () => {
    const seq: (Response | Error)[] = [new Error("ECONNRESET"), ok(read([["x", [1]]]))];
    const f = vi.fn(async () => {
      const n = seq.shift()!;
      if (n instanceof Error) throw n;
      return n;
    });
    expect((await readImage(png, { endpoint: EP, key: "k" }, { fetch: f as unknown as typeof fetch, sleep })).text).toBe("x");
    for (const code of [400, 403]) {
      const g = vi.fn(async () => status(code));
      await expect(readImage(png, { endpoint: EP, key: "k" }, { fetch: g as unknown as typeof fetch, sleep })).rejects.toBeInstanceOf(VisionError);
      expect(g).toHaveBeenCalledTimes(1);
    }
  });

  it("sin identidad administrada ni llave falla con VisionError claro; una respuesta vacía es texto vacío", async () => {
    vi.stubEnv("IDENTITY_ENDPOINT", "");
    await expect(readImage(png, cfg, { fetch: vi.fn() as unknown as typeof fetch, sleep })).rejects.toThrow(/identidad administrada/);
    const f = vi.fn(async () => ok({}));
    expect(await readImage(png, { endpoint: EP, key: "k" }, { fetch: f as unknown as typeof fetch, sleep })).toEqual({ text: "", confidence: 0 });
  });
});

describe("ocrPdf con Azure Vision", () => {
  it("usa Azure cuando está configurado y NO arranca el OCR local", async () => {
    vi.resetModules();
    vi.stubEnv("AZURE_VISION_ENDPOINT", EP);
    vi.stubEnv("AZURE_VISION_KEY", "k");
    const createWorker = vi.fn();
    vi.doMock("tesseract.js", async (orig) => ({ ...(await orig<typeof import("tesseract.js")>()), createWorker }));
    const f = vi.fn(async () => ok(read([["Hola desde Azure", [0.95]]])));
    vi.stubGlobal("fetch", f);
    const { ocrPdf } = await import("@/lib/pdf/ocr");
    const r = await ocrPdf(textPdf([["Hola"], ["Dos"]]));
    expect(r.numPages).toBe(2);
    expect(r.passes.map((p) => p.scale)).toEqual([2, 3]);
    expect(r.passes[0].pages).toEqual([{ page: 1, text: "Hola desde Azure", confidence: 95 }, { page: 2, text: "Hola desde Azure", confidence: 95 }]);
    expect(f).toHaveBeenCalledTimes(4);
    expect(createWorker).not.toHaveBeenCalled();
    vi.doUnmock("tesseract.js");
  });

  it("si Azure falla, lee con el OCR local (respaldo)", async () => {
    vi.resetModules();
    vi.stubEnv("AZURE_VISION_ENDPOINT", EP);
    vi.stubEnv("AZURE_VISION_KEY", "k");
    const worker = { setParameters: vi.fn(async () => undefined), terminate: vi.fn(async () => undefined), recognize: vi.fn(async () => ({ data: { text: "texto local", confidence: 88 } })) };
    vi.doMock("tesseract.js", async (orig) => ({ ...(await orig<typeof import("tesseract.js")>()), createWorker: vi.fn(async () => worker) }));
    vi.doMock("@/lib/pdf/ocr-azure", async (orig) => ({ ...(await orig<typeof import("@/lib/pdf/ocr-azure")>()), readImage: vi.fn(async () => { throw new (await import("@/lib/pdf/ocr-azure")).VisionError("sin cuota"); }) }));
    const { ocrPdf } = await import("@/lib/pdf/ocr");
    const r = await ocrPdf(textPdf([["Hola"]]), [1]);
    expect(r.passes[0].pages[0]).toEqual({ page: 1, text: "texto local", confidence: 88 });
    vi.doUnmock("tesseract.js");
    vi.doUnmock("@/lib/pdf/ocr-azure");
  });
});

describe("comprobante con la salida de Azure (etiqueta y valor en líneas separadas, logo y avatar sueltos)", () => {
  // Datos inventados con la forma real de la salida de Azure.
  const page1 = `Banamex
Comprobante de transferencia
14 nov 2026 09:05:12 h
Transferencia exitosa
Esta transferencia ha sido aceptada. Para validarla consulta tu Comprobante
Electrónico de Pago (CEP)
$1,234.56 MXN
Cuenta origen
# Banamex
MiCuenta Banamex ** 456
Cuenta destino
J
JUAN plomero ** 789
Banorte . Juan Perez Lopez *
Datos de la transferencia
Número de autorización
123456
Clave de rastreo
012345678901234567
1 de 2`;
  const page2 = `Banamex
Comprobante de transferencia
14 nov 2026 09:05:12 h
Tipo de cuenta
Débito
Tipo de beneficiario
Persona física
Concepto
MULTISERVICIOS
Referencia numérica
4321
Fecha y hora
14 nov 2026 09:05 h
2 de 2`;
  it("lee todos los campos", () => {
    const r = parseBanamexTransfer(`${page1}\n${page2}`);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.transfer).toMatchObject({
      amountCents: 123_456, originLabel: "MiCuenta Banamex", originTail: "456", destAlias: "JUAN plomero", destTail: "789", destBank: "Banorte",
      destName: "Juan Perez Lopez", concept: "MULTISERVICIOS", reference: "4321", trackingKey: "012345678901234567", authCode: "123456", accountType: "Débito",
    });
  });
});
