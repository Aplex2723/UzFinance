import { describe, expect, it } from "vitest";
import { OcrError, ocrPdf, ocrText } from "@/lib/pdf/ocr";
import { parseBanamexTransfer, transferConflicts } from "@/lib/pdf/receipts/banamex-transfer";
import { hasPdfHeader, openPdf, PdfInvalidError, PdfTooBigError, PDF_MAX_BYTES, readPdfText } from "@/lib/pdf/text";
import { imagePdf, receiptPdf, textPdf } from "../pdf-fixtures";

describe("lectura de PDF", () => {
  it("PDF con texto: devuelve palabras con posiciones; PDF de imagen: 0 caracteres (hace falta OCR)", async () => {
    const t = await readPdfText(textPdf([["Hola mundo", "Segundo renglon"], ["Pagina dos"]]));
    expect(t.numPages).toBe(2);
    expect(t.chars).toBeGreaterThan(20);
    expect(t.pages[0].words.map((w) => w.str).join(" ")).toContain("Hola mundo");
    expect(t.pages[0].words[0].top).toBeLessThan(t.pages[0].words.at(-1)!.top); // origen arriba
    expect((await readPdfText(receiptPdf())).chars).toBe(0);
  });

  it("rechaza lo que no es PDF, lo muy grande y lo corrupto", async () => {
    expect(hasPdfHeader(new TextEncoder().encode("%PDF-1.7\n....."))).toBe(true);
    expect(hasPdfHeader(new TextEncoder().encode("GIF89a......"))).toBe(false);
    await expect(openPdf(new TextEncoder().encode("esto no es un pdf, es texto"))).rejects.toBeInstanceOf(PdfInvalidError);
    await expect(openPdf(new TextEncoder().encode("%PDF-1.4\nbasura basura basura"))).rejects.toBeInstanceOf(PdfInvalidError);
    await expect(openPdf(new Uint8Array(PDF_MAX_BYTES + 1))).rejects.toBeInstanceOf(PdfTooBigError);
  });

  it("no modifica el buffer que recibe (se puede reutilizar para el OCR)", async () => {
    const b = textPdf([["abc def"]]);
    const before = Buffer.from(b).toString("base64");
    await readPdfText(b);
    await readPdfText(b);
    expect(Buffer.from(b).toString("base64")).toBe(before);
  });
});

describe("OCR local + parser de comprobante (PDF de imagen)", () => {
  it("lee el comprobante con dos resoluciones y los campos críticos coinciden", async () => {
    const r = await ocrPdf(receiptPdf());
    expect(r.passes).toHaveLength(2);
    const [a, b] = r.passes.map((p) => parseBanamexTransfer(ocrText(p)));
    expect(a.kind).toBe("ok");
    expect(b.kind).toBe("ok");
    if (a.kind !== "ok" || b.kind !== "ok") return;
    expect(a.transfer).toMatchObject({ amountCents: 123_456, originTail: "456", destTail: "789", authCode: "123456", trackingKey: "012345678901234567", reference: "4321" });
    expect(a.transfer.concept?.toLowerCase()).toContain("renta");
    expect(transferConflicts(a.transfer, b.transfer)).toEqual([]);
  }, 60_000);

  it("un monto a medio leer NUNCA se interpreta: sin centavos completos no hay monto", () => {
    // El OCR puede perder el punto o los decimales; leer "$1,23456" como 123,456 pesos sería un error de 100×.
    for (const bad of ["$1,23456 MXN", "$123456 MXN", "$111. MXN", "$987 65 MXN"]) {
      const text = `Comprobante de transferencia\nBanamex\nTransferencia exitosa\n${bad}\nCuenta origen\nMiCuenta Banamex **456\nCuenta destino\nEjemplo **789\nClave de rastreo 012345678901234567\nFecha y hora 14 nov 2026 09:05 h`;
      expect(parseBanamexTransfer(text)).toMatchObject({ kind: "unparsed", reason: "monto: no se encontró el monto" });
    }
  });

  it("un comprobante rechazado se lee como rechazado (no se registra)", async () => {
    const r = await ocrPdf(receiptPdf({ status: "Transferencia rechazada" }), [2.5]);
    expect(parseBanamexTransfer(ocrText(r.passes[0])).kind).toBe("rejected");
  }, 60_000);

  it("una página gigante se rechaza antes de renderizar (PDF bomba) y el OCR sigue sirviendo después", async () => {
    await expect(ocrPdf(textPdf([["x"]], [14_400, 14_400]), [3.5])).rejects.toBeInstanceOf(OcrError);
    const r = await ocrPdf(receiptPdf(), [2.5]); // el worker se reinició y los siguientes documentos funcionan
    expect(parseBanamexTransfer(ocrText(r.passes[0])).kind).toBe("ok");
  }, 90_000);

  it("cualquier fallo del PDF sale como OcrError (no como 500) y no envenena al siguiente", async () => {
    await expect(ocrPdf(new TextEncoder().encode("%PDF-1.4\nbasura que no es un pdf"), [2.5])).rejects.toBeInstanceOf(OcrError);
    const r = await ocrPdf(receiptPdf(), [2.5]);
    expect(parseBanamexTransfer(ocrText(r.passes[0])).kind).toBe("ok");
  }, 90_000);

  it("un PDF de imagen que no es comprobante no se confunde con uno", async () => {
    const r = await ocrPdf(imagePdf([["Factura 123", "Total $500.00 MXN", "Gracias por su compra"]]), [2.5]);
    expect(parseBanamexTransfer(ocrText(r.passes[0])).kind).toBe("other");
  }, 60_000);

  it("varias lecturas en paralelo se serializan sin mezclar resultados", async () => {
    const a = receiptPdf({ amount: "$1,111.25 MXN", key: "111111111111111111", auth: "111111" });
    const b = receiptPdf({ amount: "$17,337.35 MXN", key: "222222222222222222", auth: "222222" });
    const [ra, rb] = await Promise.all([ocrPdf(a, [2.5]), ocrPdf(b, [2.5])]);
    const pa = parseBanamexTransfer(ocrText(ra.passes[0]));
    const pb = parseBanamexTransfer(ocrText(rb.passes[0]));
    expect(pa.kind === "ok" && pa.transfer.amountCents).toBe(111_125);
    expect(pb.kind === "ok" && pb.transfer.amountCents).toBe(1_733_735);
  }, 90_000);
});
