import { describe, expect, it } from "vitest";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import type { PdfText } from "@/lib/pdf/text";
import { item, linesPdf, pdfOf } from "./statements-pdf";

// Detección del banco y contrato de extractStatement con documentos INVENTADOS.

const nuLines = (extra: string[] = []) => [
  "Periodo: 16 AGO 2026 al 15 SEP 2026",
  "Fecha de corte: 15 SEP 2026",
  "Producto: Tarjeta de Crédito Nu, Oro",
  "Número de tarjeta: XXXX-XXXX-XXXX-1234",
  "CARGOS, ABONOS Y COMPRAS REGULARES",
  "Tarjeta titular: ANA PRUEBA LOPEZ",
  "17 AGO 2026 17 AGO 2026 Cafe Inventado | RFC: S.I. +$120.00",
  "Total de cargos +$120.00",
  "Total de abonos -$0.00",
  ...extra,
];

describe("detectStatement", () => {
  it("reconoce cada banco por su contenido", () => {
    expect(detectStatement(linesPdf([nuLines()]))).toEqual({ kind: "nu" });
    expect(detectStatement(linesPdf([[
      "Estado de Cuenta Mensual", "Tarjeta de Crédito", "Periodo: 19-ago-2026 al 18-sep-2026", "Tarjeta de Crédito EXPLORA BANAMEX Número de días en el periodo: 31 días",
    ]]))).toEqual({ kind: "banamex_credit" });
    expect(detectStatement(linesPdf([["Estado de Cuenta", "MiCuenta", "Período del 19 de agosto al 18 de septiembre del 2026", "Saldo anterior"]]))).toEqual({ kind: "banamex_debit" });
    expect(detectStatement(linesPdf([["American Express", "Estado de Cuenta Página 1", "Número de Cuenta 3401-123456-12345", "Período de Facturación Del 26 de Agosto al 25 de Septiembre de 2026"]]))).toEqual({ kind: "amex" });
  });
  it("reconoce el banco aunque el encabezado venga en otra página o con el orden de ítems revuelto", () => {
    const pdf = linesPdf([["Hoja de portada sin datos del banco, solo publicidad y avisos legales de la institución"], nuLines()], { shuffle: true });
    expect(detectStatement(pdf)).toEqual({ kind: "nu" });
  });
  it("rechaza lo que no es un estado: factura, comprobante de transferencia, carta", () => {
    const invoice = linesPdf([["FACTURA A-1234", "Emisor: EMPRESA FICTICIA SA DE CV  RFC XAXX010101000", "Concepto: servicios profesionales  Subtotal $1,000.00  IVA $160.00  Total $1,160.00", "Folio fiscal 00000000-0000-0000-0000-000000000000"]]);
    const receipt = linesPdf([["Comprobante de la transacción", "Transferencia SPEI enviada el 03-oct-2026", "Monto: $500.00  Clave de rastreo: ABC123  Beneficiario: PERSONA FICTICIA", "Banco destino: BANCO UNO"]]);
    for (const pdf of [invoice, receipt]) {
      const d = detectStatement(pdf);
      expect(d.kind).toBeNull();
      if (d.kind === null) expect(d.reason).toMatch(/no parece un estado de cuenta/i);
    }
    expect(() => extractStatement(invoice)).toThrow(/no parece un estado de cuenta/i);
  });
  it("PDF de solo imagen (sin capa de texto): razón clara", () => {
    const image: PdfText = { numPages: 3, chars: 0, pages: [1, 2, 3].map((page) => ({ page, width: 612, height: 792, words: [] })) };
    const d = detectStatement(image);
    expect(d.kind).toBeNull();
    if (d.kind === null) expect(d.reason).toMatch(/imagen|escaneo/i);
    expect(() => extractStatement(image)).toThrow(/imagen|escaneo/i);
    expect(detectStatement({ numPages: 0, chars: 0, pages: [] }).kind).toBeNull();
  });
  it("una palabra del banco suelta no basta (un correo que menciona a Banamex o a Nu)", () => {
    expect(detectStatement(linesPdf([["Hola, tu estado de cuenta de Nu ya está disponible en nu.com.mx, revísalo cuando quieras en la app"]])).kind).toBeNull();
    expect(detectStatement(linesPdf([["Banamex te informa que su tarjeta de crédito tiene nuevas promociones este periodo de verano 2026"]])).kind).toBeNull();
  });
});

describe("extractStatement", () => {
  it("devuelve la lista de documentos ya validados con docSchema", () => {
    const docs = extractStatement(linesPdf([nuLines()]));
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ document: "nu_stmt", card_key: "nu", period: { start: "2026-08-16", end: "2026-09-15" }, as_of: "2026-09-15" });
    expect(docs[0].checks.length).toBeGreaterThan(0);
    expect(docs[0].plans).toEqual([]);
  });
  it("se puede forzar el tipo (kind) sin detectar", () => {
    expect(extractStatement(linesPdf([nuLines()]), "nu")[0].document).toBe("nu_stmt");
  });
  it("un plan con datos inválidos se descarta y queda un check fallido (para revisión)", () => {
    const [doc] = extractStatement(linesPdf([nuLines(["COMPRAS Y CARGOS DIFERIDOS A MESES SIN INTERESES", "01 AGO 2026 Plan Raro $0.00 $0.00 $0.00 1/3 0.00%"])]));
    expect(doc.plans).toEqual([]);
    expect(doc.checks.some((c) => !c.ok && /planes/.test(c.name))).toBe(true);
    expect(doc.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/planes MSI/)]));
  });
  it("datos raros dentro de un estado conocido no lanzan: warnings y checks fallidos", () => {
    const [doc] = extractStatement(linesPdf([nuLines().map((l) => (l.startsWith("Total de cargos") ? "Total de cargos +$1.00" : l))]));
    expect(doc.checks.some((c) => !c.ok)).toBe(true);
  });
  it("un fallo inesperado del extractor no tumba la carga: documento con check fallido", () => {
    const broken = { numPages: 1, chars: 500, pages: [{ page: 1, width: 612, height: 792, words: null as never }] } as PdfText;
    const [doc] = extractStatement(broken, "nu");
    expect(doc.checks.some((c) => !c.ok && c.name === "extraccion completa")).toBe(true);
    expect(doc.warnings.join(" ")).toMatch(/error inesperado/);
    expect(doc.transactions).toEqual([]);
  });
  it("rendimiento: un estado de 40 páginas se procesa muy por debajo de 3 s", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `17 AGO 2026 17 AGO 2026 Comercio ${i} | RFC: S.I. +$1.00`);
    const pages = Array.from({ length: 40 }, (_, p) => (p === 0 ? [...nuLines().slice(0, 6), ...rows] : rows).map((l, i) => item(40, 40 + i * 12, l)));
    const t0 = performance.now();
    const [doc] = extractStatement(pdfOf(pages));
    expect(doc.transactions.length).toBe(60 * 40);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
