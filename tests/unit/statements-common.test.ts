import { describe, expect, it } from "vitest";
import {
  centsToStr, cleanBanamexMerchant, cleanText, inferYear, makeCheck, pageLines, pageWords, parseDate, parseInstallment, parseMoney,
  parseMoneyOrNull, splitAmexCity, splitBanamexRfc, wordLines,
} from "@/lib/pdf/statements/common";
import { EM_DASH, MINUS, NBSP, ZWSP, item, linesPdf, pdfOf, row } from "./statements-pdf";

// Mismas pruebas que scripts/statements/test_parsers.py (datos inventados) + los casos propios de pdf.js.

describe("dinero", () => {
  it("entiende los formatos de los estados", () => {
    expect(parseMoney("$1,487.42")).toBe(148742);
    expect(parseMoney("+$1,487.42")).toBe(148742);
    expect(parseMoney("- $18,890.87")).toBe(-1889087);
    expect(parseMoney("-$16,050.00")).toBe(-1605000);
    expect(parseMoney("$ 1 2 5 . 0 0")).toBe(12500); // dígitos separados por espacios
    expect(parseMoney("+ $ 1 , 2 5 0 . 5 0")).toBe(125050);
    expect(parseMoney("312.0")).toBe(31200);
    expect(parseMoney("1169")).toBe(116900);
    expect(parseMoney("$0.01")).toBe(1);
    expect(parseMoney("$0.00")).toBe(0);
    expect(centsToStr(-1889087)).toBe("-18,890.87");
  });
  it("tolera signo menos tipográfico, guiones largos y espacios duros", () => {
    expect(parseMoney(`${MINUS}$18.00`)).toBe(-1800);
    expect(parseMoney(`${EM_DASH} $18.00`)).toBe(-1800);
    expect(parseMoney(`$1,2${NBSP}50.00`)).toBe(125000); // parseMoney ignora todo espacio
    expect(parseMoney(`$${ZWSP}1,250.00`)).toBe(125000);
  });
  it("lo que no es dinero no se interpreta: null, o error si se pidió con parseMoney", () => {
    expect(parseMoneyOrNull("abc")).toBeNull();
    expect(parseMoneyOrNull("")).toBeNull();
    expect(parseMoneyOrNull("1.234,56")).toBeNull(); // separadores a la europea: no se adivina
    expect(() => parseMoney("abc")).toThrow(/monto no reconocido/);
  });
});

describe("fechas", () => {
  it("meses en español e inglés, con y sin año", () => {
    expect(parseDate("19-ago-2026")).toBe("2026-08-19");
    expect(parseDate("5-sep-2026")).toBe("2026-09-05");
    expect(parseDate("17 AGO 2026")).toBe("2026-08-17");
    expect(parseDate("02 SEP 2026")).toBe("2026-09-02");
    expect(parseDate("28 deAgosto", 2026)).toBe("2026-08-28"); // pegado
    expect(parseDate("28 de Agosto", 2026)).toBe("2026-08-28");
    expect(parseDate("12 de Septiembre", 2026)).toBe("2026-09-12");
    expect(parseDate("12 de Septiembre de 2025", 2026)).toBe("2025-09-12");
    expect(parseDate("3 de Diciembre", 2026)).toBe("2026-12-03");
    expect(parseDate("2026-10-01")).toBe("2026-10-01");
    expect(parseDate("texto")).toBeNull();
  });
  it("sin año usa el del periodo y retrocede uno si pasaría del corte", () => {
    expect(parseDate("25 deJul", 2026, "2026-09-25")).toBe("2026-07-25");
    expect(parseDate("01 Oct", 2026, "2026-10-02")).toBe("2026-10-01");
    expect(parseDate("28 Dic", 2026, "2026-01-15")).toBe("2025-12-28"); // retrocede un año
    expect(parseDate("28 de Diciembre", 2026, "2026-01-15")).toBe("2025-12-28");
    expect(parseDate("28 Dic")).toBeNull(); // sin año no se inventa
  });
  it("fechas imposibles no lanzan: null", () => {
    expect(parseDate("31-feb-2026")).toBeNull();
    expect(parseDate("30 de Febrero", 2026)).toBeNull();
    expect(parseDate("10 de Foo", 2026)).toBeNull();
  });
  it("año de un 'dd MON' dentro de un periodo que cruza de año", () => {
    expect(inferYear(25, 12, "2026-12-19", "2027-01-18")).toBe(2026);
    expect(inferYear(3, 1, "2026-12-19", "2027-01-18")).toBe(2027);
  });
});

describe("mensualidades", () => {
  it("reconoce los marcadores de Banamex, Amex y Nu", () => {
    expect(parseInstallment("TIENDA UNO 012 de 024")).toEqual([{ n: 12, total: 24 }, "TIENDA UNO"]);
    expect(parseInstallment("TIENDA DOS 94(013:024)")).toEqual([{ n: 13, total: 24 }, "TIENDA DOS 94"]);
    expect(parseInstallment("Compra Ficticia A Meses - 1/3")).toEqual([{ n: 1, total: 3 }, "Compra Ficticia A Meses"]);
    expect(parseInstallment("CARGO 05 DE 06")[0]).toEqual({ n: 5, total: 6 });
    expect(parseInstallment("CARGO 03 DE03")[0]).toEqual({ n: 3, total: 3 });
  });
  it("lo que no es mensualidad no lo es", () => {
    expect(parseInstallment("TIENDA TRES 7/2")[0]).toBeNull(); // n > total
    expect(parseInstallment("TIENDA CUATRO")[0]).toBeNull();
  });
});

describe("comercios", () => {
  it("Banamex: quita RFC, adquirente, país y letras sueltas", () => {
    expect(cleanBanamexMerchant("CAFE LUNA CENTRO XYZ 250515CC7")).toBe("CAFE LUNA CENTRO");
    expect(cleanBanamexMerchant("MERPAGO*TIENDAFAKE MAG 2105031W3MX")).toBe("MERPAGO*TIENDAFAKE");
    expect(cleanBanamexMerchant("SUPER NORTE RGG120522NP6MX")).toBe("SUPER NORTE");
    expect(cleanBanamexMerchant("TIENDA SOL CCO XYZ830101AB1 MX")).toBe("TIENDA SOL");
    expect(cleanBanamexMerchant("JOYERIA K E T E N AIBU7904046I6MX")).toBe("JOYERIA KETEN");
    expect(cleanBanamexMerchant("TIENDA OCHO 940317114")).toBe("TIENDA OCHO");
    expect(cleanBanamexMerchant("SERV PLAYA VERACRUZ VER MX")).toBe("SERV PLAYA VERACRUZ");
    expect(cleanBanamexMerchant("APP FICTICIA AMSTERDAM NL")).toBe("APP FICTICIA");
    expect(cleanBanamexMerchant("TIENDA UNO MERIDA 012 de 024")).toBe("TIENDA UNO MERIDA");
    expect(splitBanamexRfc("CAFE LUNA CENTRO XYZ 250515CC7")).toEqual(["CAFE LUNA CENTRO", "XYZ", "250515CC7"]);
    expect(cleanBanamexMerchant("PAPELERIA LA ESQUINA")).toBe("PAPELERIA LA ESQUINA"); // un nombre normal no se toca
  });
  it("Amex: separa la ciudad pegada al comercio", () => {
    expect(splitAmexCity("MERCADOPAGO*TIENDAFAKE Ciudad de Mex")).toEqual(["MERCADOPAGO*TIENDAFAKE", "Ciudad de Mex"]);
    expect(splitAmexCity("TIENDA FICTICIA MEXICO CITY")).toEqual(["TIENDA FICTICIA", "MEXICO CITY"]);
    expect(splitAmexCity("PARQUE SOL BOCA DEL RIO")).toEqual(["PARQUE SOL", "BOCA DEL RIO"]);
    expect(splitAmexCity("UBER EATS HTTPS://HELP.UB")).toEqual(["UBER EATS", "HTTPS://HELP.UB"]);
    expect(splitAmexCity("MERIDA")).toEqual(["MERIDA", null]); // conserva al menos una palabra
    // "Mérida" llega con un carácter de reemplazo según el lector
    expect(splitAmexCity("CLINICA FICTICIA M?rida")).toEqual(["CLINICA FICTICIA", "M?rida"]);
    expect(splitAmexCity("CLINICA FICTICIA M�rida")).toEqual(["CLINICA FICTICIA", "M�rida"]);
    expect(splitAmexCity("CLINICA FICTICIA Mérida YUC")).toEqual(["CLINICA FICTICIA", "Mérida YUC"]);
  });
});

describe("checks", () => {
  it("compara en centavos o conteos, con tolerancia opcional", () => {
    expect(makeCheck("a", 100, 100).ok).toBe(true);
    expect(makeCheck("a", 100, 101).ok).toBe(false);
    expect(makeCheck("a", 100, 101, 1).ok).toBe(true);
    expect(makeCheck("n", 3, 3, 0, "count")).toEqual({ name: "n", expected_cents: 3, actual_cents: 3, ok: true, unit: "count" });
  });
});

describe("texto de pdf.js -> palabras y renglones", () => {
  it("un ítem con varias palabras se parte repartiendo x; el orden de los ítems no importa", () => {
    const page = pdfOf([[item(100, 50, "uno dos tres", { w: 60 }), item(30, 50, "antes", { w: 25 }), item(300, 50, "1,234.00")]]).pages[0];
    const ws = pageWords(page).sort((a, b) => a.x0 - b.x0);
    expect(ws.map((w) => w.str)).toEqual(["antes", "uno", "dos", "tres", "1,234.00"]);
    expect(ws[1].x0).toBeCloseTo(100, 5);
    expect(ws[2].x0).toBeGreaterThan(ws[1].x1 - 1);
    expect(pageLines(page)).toEqual(["antes uno dos tres 1,234.00"]);
  });
  it("renglones por altura (± 3 pt) aunque las fuentes tengan distinto tamaño", () => {
    const page = pdfOf([[...row(100, [20, "Fecha"], [200, "Monto"]), ...row(111, [20, "Segundo"]), item(300, 111.5, "5.00", { fs: 8 })]]).pages[0];
    expect(pageLines(page)).toEqual(["Fecha Monto", "Segundo 5.00"]);
  });
  it("une una palabra partida en ítems pegados, pero no dos palabras separadas por un espacio", () => {
    const page = pdfOf([[
      item(20, 50, "TIEN", { w: 20 }), item(40, 50, "DA", { w: 10 }), // pegados: TIENDA
      item(70, 50, "Número de tarjeta:", { w: 90 }), item(166, 50, "1234", { w: 20 }), // hay hueco: dos palabras
      item(250, 50, "Total", { w: 25, sp: true }), item(276, 50, "9", { w: 5 }), // espacio suelto de pdf.js: dos palabras
    ]]).pages[0];
    expect(pageLines(page)).toEqual(["TIENDA Número de tarjeta: 1234 Total 9"]);
  });
  it("ítems con espacios finales/iniciales, NBSP y caracteres invisibles", () => {
    const page = pdfOf([[item(20, 50, `Hola${NBSP}mundo `, { w: 60 }), item(100, 50, `${ZWSP}$1${NBSP}250.00${ZWSP}`, { w: 50 })]]).pages[0];
    expect(pageLines(page)).toEqual(["Hola mundo $1,250.00"]);
    expect(cleanText(`${MINUS}$5.00`)).toBe("-$5.00");
    expect(cleanText(`Pagos ${EM_DASH}$5.00`)).toBe("Pagos -$5.00");
    expect(cleanText(`Desde tu App ${EM_DASH} Disponible`)).toBe(`Desde tu App ${EM_DASH} Disponible`); // un guion largo en prosa no se toca
    expect(cleanText("ﬁnanciero")).toBe("financiero");
  });
  it("ignora el texto girado (sellos laterales)", () => {
    const rotated = { ...item(33, 90, "0002696", { w: 150 }), rot: true };
    const page = pdfOf([[...row(100, [30, "19 AGO"]), rotated]]).pages[0];
    expect(pageLines(page)).toEqual(["19 AGO"]);
  });
  it("wordLines compara con la primera palabra del renglón (como group_lines de Python)", () => {
    const ws = pageWords(pdfOf([[...row(100, [20, "a"], [60, "b"]), ...row(120, [20, "c"])]]).pages[0]);
    expect(wordLines(ws, 3).map((l) => l.map((w) => w.str))).toEqual([["a", "b"], ["c"]]);
  });
  it("un PDF sin texto da cero renglones (no lanza)", () => {
    expect(pageLines(linesPdf([[]]).pages[0])).toEqual([]);
  });
});
