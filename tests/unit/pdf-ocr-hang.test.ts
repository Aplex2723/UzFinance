import { afterEach, describe, expect, it, vi } from "vitest";
import { textPdf } from "../pdf-fixtures";

// Un worker de tesseract que falla al cargar (p. ej. falta un módulo en el paquete) NO rechaza: su promesa queda colgada para siempre.
// El OCR debe fallar limpio, a tiempo, y la cola no debe quedar bloqueada para los documentos siguientes.
vi.mock("tesseract.js", async (orig) => {
  const m = await orig<typeof import("tesseract.js")>();
  return { ...m, createWorker: vi.fn(() => new Promise(() => {})) };
});

afterEach(() => vi.useRealTimers());

describe("OCR con el motor colgado", () => {
  it("falla con OcrError cuando el motor no arranca a tiempo y el siguiente documento no queda atrás de uno atascado", async () => {
    vi.useFakeTimers();
    const { ocrPdf, OcrError } = await import("@/lib/pdf/ocr");
    const bytes = textPdf([["Hola"]]);

    const first = ocrPdf(bytes).catch((e) => e);
    const second = ocrPdf(bytes).catch((e) => e);
    await vi.advanceTimersByTimeAsync(121_000);
    const e1 = await first;
    expect(e1).toBeInstanceOf(OcrError);
    expect((e1 as Error).message).toContain("No se pudo iniciar el OCR");

    await vi.advanceTimersByTimeAsync(121_000);
    expect(await second).toBeInstanceOf(OcrError);
  });
});
