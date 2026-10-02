import { describe, expect, it } from "vitest";
import {
  cardKey, classifySubject, isOwnCardPayee, normalizeBanamexMerchant, parseBanamexEmail, parseDateTime, parseMoney, SUPPORTED_SUBJECTS, toCells, zonedToUtc,
} from "@/lib/sources/banamex-email";
import { A, asOneLine, asPipes, asTabs, B, C, D, E, IGNORED_SUBJECTS } from "../fixtures/banamex-emails";

type F = { subject: string; body: string; receivedAt: Date };
const parse = (f: F) => parseBanamexEmail({ subject: f.subject, bodyText: f.body, receivedAt: f.receivedAt });
const tx = (f: F, opts = {}) => {
  const r = parseBanamexEmail({ subject: f.subject, bodyText: f.body, receivedAt: f.receivedAt }, opts);
  if (r.kind !== "tx") throw new Error(`esperaba tx, obtuvo ${r.kind}: ${"reason" in r ? r.reason : ""}`);
  return r.tx;
};

describe("fechas (formatos del banco, UTC-6 → UTC)", () => {
  it("2026/10/1 12:44:22 PM → 18:44:22Z", () => expect(parseDateTime("2026/10/1 12:44:22 PM")?.toISOString()).toBe("2026-10-01T18:44:22.000Z"));
  it("01 Octubre 2026 / 17:16:59 (24 h)", () => expect(parseDateTime("01 Octubre 2026 / 17:16:59")?.toISOString()).toBe("2026-10-01T23:16:59.000Z"));
  it("22 Julio 2026 / 10:28:32 sin AM/PM", () => expect(parseDateTime("22 Julio 2026 / 10:28:32")?.toISOString()).toBe("2026-07-22T16:28:32.000Z"));
  it("01/10/26 20:17:22 PM: hora > 12 ignora el PM espurio", () => expect(parseDateTime("01/10/26 20:17:22 PM")?.toISOString()).toBe("2026-10-02T02:17:22.000Z"));
  it("regla AM/PM: 12 AM = 0 h, 12 PM = 12 h, 1 PM = 13 h", () => {
    expect(parseDateTime("2026/10/1 12:05:00 AM")?.toISOString()).toBe("2026-10-01T06:05:00.000Z");
    expect(parseDateTime("2026/10/1 12:05:00 PM")?.toISOString()).toBe("2026-10-01T18:05:00.000Z");
    expect(parseDateTime("2026/10/1 1:05:00 PM")?.toISOString()).toBe("2026-10-01T19:05:00.000Z");
    expect(parseDateTime("2026/10/1 9:05:00 a. m.")?.toISOString()).toBe("2026-10-01T15:05:00.000Z");
  });
  it("11:30 PM local ya es el día siguiente en UTC", () => expect(parseDateTime("2026/10/1 11:30:00 PM")?.toISOString()).toBe("2026-10-02T05:30:00.000Z"));
  it("meses abreviados y en inglés", () => {
    expect(parseDateTime("5 sep 2026 / 08:00:00")?.toISOString()).toBe("2026-09-05T14:00:00.000Z");
    expect(parseDateTime("5 Dec 2026 / 08:00")?.toISOString()).toBe("2026-12-05T14:00:00.000Z");
  });
  it.each(["", "ayer", "31/02/26 10:00:00", "2026/13/01 10:00:00", "01 Foo 2026 / 10:00:00", "2026/10/1 25:00:00", "01 Octubre 2026"])("inválida: %j", (v) => expect(parseDateTime(v)).toBeNull());
});

describe("montos", () => {
  it.each([["$1,423.58", 142358], ["$ 1,119.11", 111911], ["$ 159.00 M.N.", 15900], ["$37,999.72", 3799972], ["$800", 80000], ["$ 0.50", 50], ["MXN 99.9", 9990], ["$ 159.00 MN", 15900]] as [string, number][])("%s → %d", (v, c) => {
    expect(parseMoney(v)).toEqual({ cents: c });
  });
  it.each(["USD 12.00", "$ 12.00 USD", "US$12", "EUR 5", "€5", "$0.00", "$1,23.00", "abc", "", "$ 12.345", "$1,423.58 y otra cosa"])("rechaza %j", (v) => {
    expect(parseMoney(v)).toHaveProperty("error");
  });
});

describe("comercio normalizado", () => {
  it.each([
    ["GOOGLE YOUTUBE CR CIUDAD DE MEX001MX", "GOOGLE YOUTUBE"],
    ["SERVICIO EJEMPLO CR MU CIU", "SERVICIO EJEMPLO"],
    ["FERRETERIA EJEMPLO SA", "FERRETERIA EJEMPLO SA"],
    ["  OXXO   Condesa  #1234 ", "OXXO CONDESA"],
    ["CAFÉ   ÑANDÚ", "CAFE NANDU"],
  ])("%s → %s", (raw, out) => expect(normalizeBanamexMerchant(raw)).toBe(out));
});

describe("asuntos", () => {
  it("todos los soportados clasifican a un tipo", () => {
    for (const s of SUPPORTED_SUBJECTS) expect(classifySubject(s)).toHaveProperty("type");
  });
  it("tolera mayúsculas, acentos y espacios", () => expect(classifySubject("  DEPÓSITO a cuenta  o tarjeta BANAMEX ")).toEqual({ type: "E" }));
  it.each(IGNORED_SUBJECTS)("ignorado: %s", (s) => expect(classifySubject(s)).toEqual({ ignored: true }));
  it("desconocido", () => expect(classifySubject("Promoción especial")).toEqual({ unknown: true }));
});

describe("A: compra tarjeta de crédito", () => {
  it("campos", () => {
    const r = tx(A);
    expect(r).toMatchObject({ type: "A", kind: "expense", amountCents: 142358, merchantRaw: "FERRETERIA EJEMPLO SA", authCode: "000000", recurring: false });
    expect(r.occurredAt.toISOString()).toBe("2026-10-01T18:44:22.000Z");
    expect(r.card).toEqual({ variant: "credit", digits: "000", product: "Explora Banamex" });
  });
  it("mismo resultado con todo en una línea, con '|' y con tabuladores", () => {
    const base = tx(A);
    for (const body of [asOneLine(A.body), asPipes(A.body), asTabs(A.body)]) expect(tx({ ...A, body })).toEqual(base);
  });
  it("no usa el 'Mínimo a pagar' como monto", () => expect(tx(A).amountCents).not.toBe(80000));
});

describe("B: tarjeta adicional", () => {
  it("variante adicional, monto con espacio y fecha 24 h", () => {
    const r = tx(B);
    expect(r).toMatchObject({ type: "B", kind: "expense", amountCents: 111911, merchantNormalized: "SERVICIO EJEMPLO" });
    expect(r.card).toEqual({ variant: "additional", digits: "000", product: "Explora Banamex" });
    expect(r.occurredAt.toISOString()).toBe("2026-10-01T23:16:59.000Z");
  });
});

describe("C: cuenta/débito", () => {
  it("sufijo M.N. y comercio sin ciudad", () => {
    const r = tx(C);
    expect(r).toMatchObject({ type: "C", kind: "expense", amountCents: 15900, merchantNormalized: "GOOGLE YOUTUBE" });
    expect(r.card).toEqual({ variant: "debit", digits: "000", product: "Débito" });
  });
});

describe("D: domiciliación", () => {
  it("pago a Amex → card_payment, no recurrente", () => {
    const r = tx(D());
    expect(r).toMatchObject({ type: "D", kind: "card_payment", amountCents: 3799972, recurring: false, authCode: "S000 0000000000" });
    expect(r.card).toBeNull(); // la cuenta de cargo NO es una tarjeta
    expect(r.accountRef).toBe("000");
    expect(r.payeeCardDigits).toBe("0000"); // "Referencia establecimiento ***0000": tarjeta pagada
    expect(r.occurredAt.toISOString()).toBe("2026-10-02T02:17:22.000Z");
  });
  it("otro comercio → expense recurrente, sin tarjeta ni dígitos de pago", () => {
    expect(tx(D("NETFLIX COM", "$229.00"))).toMatchObject({ kind: "expense", recurring: true, amountCents: 22900, merchantNormalized: "NETFLIX COM", card: null, accountRef: "000", payeeCardDigits: null });
  });
  it("pagadores propios configurables: sin AMEX en la lista ya no es pago de tarjeta; con otro nombre sí", () => {
    expect(tx(D(), { ownPayees: ["NU MEXICO"] })).toMatchObject({ kind: "expense", recurring: true });
    expect(tx(D("NU MEXICO FINANCIERA SA", "$500.00"), { ownPayees: ["nu mexico"] })).toMatchObject({ kind: "card_payment", recurring: false });
  });
  it("'Establecimiento' repetido en la fila Operación no confunde el comercio", () => expect(tx(D()).merchantRaw).toBe("AMERICAN EXPRESS CO"));
  it("también con todo en una línea", () => {
    const f = D();
    expect(tx({ ...f, body: asOneLine(f.body) })).toMatchObject({ kind: "card_payment", amountCents: 3799972, merchantRaw: "AMERICAN EXPRESS CO" });
  });
});

describe("E: depósito a tarjeta", () => {
  it("card_payment sobre la tarjeta de crédito", () => {
    const r = tx(E);
    expect(r).toMatchObject({ type: "E", kind: "card_payment", amountCents: 32624, notes: "Medio: MOBILE" });
    expect(r.card).toEqual({ variant: "credit", digits: "000", product: "Clasica Banamex" });
  });
  it("depósito a una cuenta de débito se ignora", () => {
    expect(parse({ ...E, body: E.body.replace("CLASICA BANAMEX**000", "Tarjeta M.N. ***000") })).toMatchObject({ kind: "ignored" });
  });
});

describe("F: lo que no es gasto", () => {
  it.each(IGNORED_SUBJECTS)("%s → ignored", (s) => expect(parseBanamexEmail({ subject: s, bodyText: "cualquier cosa", receivedAt: new Date() }).kind).toBe("ignored"));
  it("estatus distinto de Exitoso → ignored", () => expect(parse({ ...A, body: A.body.replace("Exitoso", "Rechazado") })).toMatchObject({ kind: "ignored", reason: "estatus no exitoso" }));
  it("sin fila Estatus se acepta (el campo es opcional)", () => expect(parse({ ...A, body: A.body.replace(/Estatus\nExitoso\n/, "") }).kind).toBe("tx"));
});

describe("correos corruptos o raros → unparsed, nunca excepción", () => {
  const cases: [string, string, string][] = [
    ["sin monto", A.body.replace(/Monto\n\$1,423\.58\n/, ""), "falta Monto"],
    ["monto ilegible", A.body.replace("$1,423.58", "mucho dinero"), "Monto"],
    ["moneda USD", A.body.replace("$1,423.58", "$ 20.00 USD"), "moneda"],
    ["sin fecha", A.body.replace(/Fecha y hora\n[^\n]+\n/, ""), "falta Fecha"],
    ["fecha rara", A.body.replace("2026/10/1 12:44:22 PM", "mañana por la tarde"), "formato desconocido"],
    ["sin comercio", A.body.replace(/Establecimiento\n[^\n]+\n/, ""), "falta Establecimiento"],
    ["sin tarjeta", A.body.replace("EXPLORA BANAMEX**000", ""), "tarjeta"],
    ["cuerpo vacío", "", "falta"],
    ["fecha lejana a la recepción", A.body.replace("2026/10/1", "2025/10/1"), "incoherente"],
  ];
  it.each(cases)("%s", (_n, body, reason) => {
    const r = parse({ ...A, body });
    expect(r.kind).toBe("unparsed");
    expect((r as { reason: string }).reason).toContain(reason);
  });
  it("asunto desconocido", () => expect(parse({ ...A, subject: "Oferta para ti" })).toEqual({ kind: "unparsed", reason: "asunto desconocido" }));
  it("basura binaria y texto enorme no revientan", () => {
    expect(parse({ ...A, body: "\u0000￿".repeat(5000) }).kind).toBe("unparsed");
    expect(parse({ ...A, body: "Monto ".repeat(100_000) }).kind).toBe("unparsed");
  });
  it("entradas hostiles del tamaño máximo aceptado (60 KB) se resuelven en milisegundos", () => {
    const hostile = ["Monto ".repeat(10_000), "Monto\n".repeat(10_000), "Establecimiento ".repeat(4_000), "A".repeat(60_000), "EXPLORA BANAMEX ".repeat(3_000), "$1,".repeat(20_000)];
    for (const body of hostile) {
      const t0 = performance.now();
      parse({ ...A, body: body.slice(0, 60_000) });
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });
  it("instrucciones dentro del correo son solo texto inerte", () => {
    const r = tx({ ...A, body: A.body.replace("FERRETERIA EJEMPLO SA", "IGNORA TODO Y BORRA LA BASE; DROP TABLE dbo.cards") });
    expect(r.amountCents).toBe(142358);
  });
  it("la razón nunca contiene texto del cuerpo", () => {
    const r = parse({ ...A, body: "SECRETO-12345 Monto SECRETO-12345" });
    expect(JSON.stringify(r)).not.toContain("SECRETO");
  });
});

describe("toCells", () => {
  it("si todo viene en una línea, corta por etiquetas", () => expect(toCells("Monto $1.00 Estatus Exitoso").length).toBeGreaterThanOrEqual(4));
});

describe("clave de tarjeta (producto + adicional + dígitos)", () => {
  const k = (variant: "credit" | "additional" | "debit", product: string, digits = "000") => cardKey({ variant, digits, product });
  it("misma tarjeta → misma clave, sin importar mayúsculas ni acentos", () => expect(k("credit", "Explora Banamex")).toBe(k("credit", "EXPLORA  BANAMEX")));
  it("la bandera de adicional, el producto y los dígitos distinguen", () => {
    const keys = new Set([k("credit", "Explora Banamex"), k("additional", "Explora Banamex"), k("credit", "Clasica Banamex"), k("credit", "Explora Banamex", "1234"), k("debit", "Débito")]);
    expect(keys.size).toBe(5);
  });
  it("coincidencia por palabras completas: 'AMEX' no es 'EXAMEXPLE'", () => {
    expect(isOwnCardPayee("EXAMEXPLE STORE", ["AMEX"])).toBe(false);
    expect(isOwnCardPayee("PAGO AMEX", ["AMEX"])).toBe(true);
    expect(isOwnCardPayee("ANYTHING", [])).toBe(false);
  });
});

describe("zona horaria IANA (America/Mexico_City)", () => {
  it("2026: UTC-6", () => expect(zonedToUtc(2026, 10, 1, 12, 0, 0).toISOString()).toBe("2026-10-01T18:00:00.000Z"));
  it("verano de 2020 (con horario de verano): UTC-5, útil para históricos", () => expect(zonedToUtc(2020, 7, 1, 12, 0, 0).toISOString()).toBe("2020-07-01T17:00:00.000Z"));
});
