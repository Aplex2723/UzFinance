import { describe, expect, it } from "vitest";
import type { IntakeResult } from "@/lib/docs/intake";
import * as R from "@/lib/whatsapp/replies";
import { addDays, cdmxAt, daysBetween, isRealDate, localTime, whenLabel } from "@/lib/whatsapp/when";
import type { CardLite } from "@/lib/whatsapp/cards";
import { cardLabel, matchCards, fold } from "@/lib/whatsapp/cards";
import { replyAddress } from "@/lib/whatsapp/types";

const card = (id: number, name: string, last4: string | null = null): CardLite => ({ id, name, issuer: "banamex", last4, aliases: null, art: null });

describe("textos del bot", () => {
  it("registro: monto, comercio, tarjeta, cuándo, categoría y cómo deshacer", () => {
    const t = R.registered({ cents: 35000, merchant: "Starbucks", card: "Amex Platinum", when: "hoy 14:03", category: "Restaurantes" });
    expect(t).toBe("✅ Registrado: $350.00 · Starbucks · Amex Platinum · hoy 14:03 · Categoría Restaurantes. Responde *deshacer* si no es correcto.");
    expect(R.registered({ cents: 120050, merchant: "Gasolina", card: "Nu", when: "ayer", category: null })).toContain("$1,200.50 · Gasolina · Nu · ayer · Sin categoría");
  });

  it("lo que viene del usuario nunca se interpreta como formato de WhatsApp", () => {
    const t = R.registered({ cents: 100, merchant: "*negrita* _cursiva_ ~tachado~ `code`", card: "Tarjeta *X*", when: "hoy 10:00", category: "*Cat*" });
    expect(t).not.toMatch(/\*negrita\*|_cursiva_|~tachado~|`code`|\*X\*|\*Cat\*/);
    expect(t).toContain("negrita cursiva tachado code");
    expect(R.plain("a\n\n  b\t*c*")).toBe("a b c");
    expect(R.plain("x".repeat(500)).length).toBe(120);
  });

  it("ayuda trae 3 ejemplos y los comandos", () => {
    expect(R.HELP.match(/^• /gm)).toHaveLength(3);
    for (const c of ["tarjetas", "hoy", "resumen", "deshacer", "cancelar"]) expect(R.HELP).toContain(c);
  });

  it("lista numerada de tarjetas: máximo 9 y avisa del resto", () => {
    const many = Array.from({ length: 12 }, (_, i) => card(i + 1, `Tarjeta ${i + 1}`));
    const t = R.askCard({ merchant: "Starbucks", cents: 35000 }, many, { subset: false });
    expect(t).toContain("$350.00 · Starbucks");
    expect(t).toContain("9. Tarjeta 9");
    expect(t).not.toContain("10. Tarjeta 10");
    expect(t).toContain("…y 3 más");
    expect(t).toContain("Responde con el número");
    expect(R.askCard({ merchant: "X", cents: 100 }, many.slice(0, 2), { subset: true })).toContain("Hay varias tarjetas posibles");
    expect(R.askCard({ merchant: "X", cents: 100 }, many.slice(0, 2), { subset: false, hint: "999" })).toContain("termine en 999");
  });

  it("preguntas de monto y comercio", () => {
    expect(R.askAmount({ merchant: "Uber", cents: null }, true)).toContain("varios números");
    expect(R.askAmount({ merchant: "Uber", cents: null }, false)).toContain("¿Cuánto fue lo de Uber?");
    expect(R.askMerchant({ merchant: null, cents: 35000 })).toContain("¿En qué comercio?");
  });

  it("posible duplicado: comercio, monto, cuándo y fuente", () => {
    expect(R.askDuplicate({ merchant: "Starbucks", cents: 35000, when: "hoy 13:50", sources: "shortcut" })).toBe("Ya hay un gasto igual: Starbucks $350.00 (hoy 13:50, vía Atajo). ¿Es otro? Responde *sí* (lo registro) o *no*.");
    expect(R.viaLabel("shortcut,email")).toBe("Atajo + correo");
    expect(R.viaLabel("receipt")).toBe("comprobante PDF");
    expect(R.viaLabel("whatsapp,email,shortcut")).toBe("WhatsApp + correo + Atajo");
    expect(R.viaLabel("")).toBe("la app");
  });

  it("alto monto pide sí/no", () => {
    expect(R.askConfirm({ merchant: "Renta", cents: 2_500_000 }, "Amex Platinum", "hoy 10:00")).toContain("$25,000.00");
  });

  it("deshacer", () => {
    expect(R.undone("Starbucks", 35000, "Amex")).toContain("Deshecho: Starbucks $350.00");
    expect(R.undoConfirmed("Starbucks", 35000)).toContain("edítalo en la app");
    expect(R.undoNothing()).toContain("30 minutos");
  });

  it("hoy y resumen (con y sin ingreso)", () => {
    expect(R.todayList({ rows: [], total: 0, totalCents: 0 })).toBe("Hoy todavía no hay gastos registrados.");
    const t = R.todayList({ rows: [{ merchant: "Oxxo", cents: 4500, card: "Nu", time: "09:15" }], total: 7, totalCents: 90000 });
    expect(t).toContain("$900.00 en 7 gastos");
    expect(t).toContain("últimos 1 de 7");
    expect(t).toContain("• 09:15 · Oxxo $45.00 · Nu");
    const s = R.summary({ todayCents: 35000, todayCount: 1, monthLabel: "Octubre 2026", monthCents: 1_500_000, monthCount: 12, incomeCents: 5_000_000 });
    expect(s).toContain("Hoy: $350.00 (1 gasto)");
    expect(s).toContain("Octubre 2026: $15,000.00 (12 gastos) · 30% de tu ingreso");
    expect(R.summary({ todayCents: 0, todayCount: 0, monthLabel: "Octubre 2026", monthCents: 0, monthCount: 0, incomeCents: 0 })).not.toContain("ingreso");
  });

  it("nunca excede el límite de WhatsApp", () => {
    expect(R.clip("x".repeat(10_000)).length).toBeLessThanOrEqual(R.MAX_REPLY);
    expect(R.clip("hola")).toBe("hola");
  });
});

const base = (o: Partial<IntakeResult>): IntakeResult => ({ documentId: 7, kind: "transfer_receipt", status: "processed", title: "Transferencia $1,234.56 · 2026-10-03", detail: "Registrada.", already: false, txId: 9, registered: "inserted", ...o });

describe("respuestas por PDF", () => {
  const url = "https://uz.example.com";
  it("transferencia registrada", () => {
    const t = R.pdfReply(base({}), { appUrl: url, tx: { cents: 123456, merchant: "Renta depa", card: "Débito ···296" } });
    expect(t).toContain("✅ Registré la transferencia de $1,234.56 · Renta depa · Débito ···296");
    expect(t).toContain("*deshacer*");
  });
  it("sin el movimiento a la mano usa el título", () => {
    expect(R.pdfReply(base({}), {})).toContain("Transferencia $1,234.56");
  });
  it("duplicada y fusionada con el correo", () => {
    expect(R.pdfReply(base({ registered: "duplicate" }), {})).toBe("Esa transferencia ya estaba registrada.");
    expect(R.pdfReply(base({ registered: "merged" }), {})).toContain("correo del banco");
  });
  it("necesita revisión → detalle y enlace (sin enlace si no hay appUrl)", () => {
    const r = base({ status: "needs_review", registered: undefined, txId: null, detail: "las lecturas no coinciden en el monto" });
    expect(R.pdfReply(r, { appUrl: `${url}/` })).toBe(`📎 Lo recibí pero necesito que lo revises en la app: las lecturas no coinciden en el monto\n${url}/documentos/7`);
    expect(R.pdfReply(r, {})).not.toContain("http");
    expect(R.pdfReply(r, {})).not.toContain("/documentos/");
  });
  it("estado de cuenta: resumen con diferencias y enlace", () => {
    const t = R.pdfReply(base({ kind: "statement", status: "needs_review", title: "Amex · sep 2026", detail: "12 movimientos conciliados", registered: undefined, txId: null, openFindings: 3, highFindings: 1 }), { appUrl: url });
    expect(t).toContain("Estado de cuenta recibido: Amex · sep 2026");
    expect(t).toContain("Diferencias abiertas: 3 (1 importantes)");
    expect(t).toContain(`${url}/documentos/7`);
    expect(R.pdfReply(base({ kind: "statement", registered: undefined, txId: null, openFindings: 0 }), {})).toContain("Sin diferencias abiertas");
    expect(R.pdfReply(base({ kind: "statement", registered: undefined, txId: null, openFindings: 0, needsMapping: ["Amex ···1005"] }), {})).toContain("tarjetas por relacionar");
  });
  it("fallido, con contraseña y rechazado", () => {
    expect(R.pdfReply(base({ status: "failed", detail: "El PDF está protegido con contraseña. Súbelo de nuevo indicando la contraseña." }), {})).toContain("súbelo desde la app");
    expect(R.pdfReply(base({ status: "failed", detail: "OCR caído" }), {})).toContain("No pude leer el PDF: OCR caído");
    expect(R.pdfReply(base({ status: "rejected", detail: "transferencia rechazada" }), {})).toBe("No pude usar este PDF: transferencia rechazada");
  });
  it("el detalle de un PDF no puede colar formato", () => {
    expect(R.pdfReply(base({ status: "rejected", detail: "*x* _y_" }), {})).toBe("No pude usar este PDF: x y");
  });
  it("PDF ya recibido", () => {
    expect(R.pdfAlready(base({ already: true }))).toContain("ya lo había recibido");
    expect(R.pdfAlready(base({ already: true, kind: "statement" }), url)).toContain(`${url}/documentos/7`);
  });
});

describe("fechas en hora de CDMX", () => {
  it("localTime y whenLabel (hoy con hora; ayer/anteayer/otro día sin ella)", () => {
    const now = new Date("2026-10-04T20:03:00Z"); // 14:03 CDMX
    expect(localTime(now)).toBe("14:03");
    expect(whenLabel(now, now)).toBe("hoy 14:03");
    expect(whenLabel(new Date("2026-10-03T18:00:00Z"), now)).toBe("ayer");
    expect(whenLabel(new Date("2026-10-02T18:00:00Z"), now)).toBe("anteayer");
    expect(whenLabel(new Date("2026-09-20T18:00:00Z"), now)).toBe("20 sep");
    expect(whenLabel(new Date("2025-12-20T18:00:00Z"), now)).toBe("20 dic 2025");
  });
  it("23:59 en CDMX todavía es 'hoy' aunque en UTC ya sea mañana", () => {
    const late = new Date("2026-10-05T05:59:00Z"); // 4 oct 23:59 CDMX
    expect(localTime(late)).toBe("23:59");
    expect(whenLabel(late, late)).toBe("hoy 23:59");
    expect(whenLabel(new Date("2026-10-04T18:00:00Z"), late)).toBe("hoy 12:00");
    expect(whenLabel(new Date("2026-10-03T18:00:00Z"), late)).toBe("ayer");
  });
  it("cdmxAt: las 12:00 de CDMX son las 18:00 UTC", () => {
    expect(cdmxAt("2026-10-03").toISOString()).toBe("2026-10-03T18:00:00.000Z");
    expect(cdmxAt("2026-12-31").toISOString()).toBe("2026-12-31T18:00:00.000Z");
    expect(cdmxAt("2028-02-29", 23).toISOString()).toBe("2028-03-01T05:00:00.000Z");
  });
  it("aritmética de fechas", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(daysBetween("2026-08-05", "2026-10-04")).toBe(60);
    expect(isRealDate(2028, 2, 29)).toBe(true);
    expect(isRealDate(2027, 2, 29)).toBe(false);
    expect(isRealDate(2026, 4, 31)).toBe(false);
    expect(isRealDate(2026, 13, 1)).toBe(false);
  });
});

describe("tarjetas: emparejamiento y etiquetas", () => {
  it("fold quita acentos y mayúsculas sin cambiar la longitud", () => {
    for (const s of ["Débito", "ÁÉÍÓÚ Ñandú", "𝒳 emoji 😀", "İstanbul", "ß"]) expect(fold(s).length).toBe(s.length);
    expect(fold("Débito ÑANDÚ")).toBe("debito nandu");
  });
  it("cardLabel agrega la terminación solo si el nombre no la trae", () => {
    expect(cardLabel(card(1, "Débito ···296", "296"))).toBe("Débito ···296");
    expect(cardLabel(card(1, "Amex Platinum", "1005"))).toBe("Amex Platinum (···1005)");
    expect(cardLabel(card(1, "Nu", null))).toBe("Nu");
  });
  it("matchCards: sin tarjetas o sin texto → vacío", () => {
    expect(matchCards("hola", [], [], [])).toEqual({ ids: [], spans: [], unmatchedHint: null });
    expect(matchCards("", [], [card(1, "Nu")], []).ids).toEqual([]);
  });
  it("una terminación de 3 dígitos empata con una de 4 que la contiene al final", () => {
    const c = [card(1, "Débito", "0296")];
    expect(matchCards("oxxo", new Array(4).fill(false), c, ["296"]).ids).toEqual([1]);
  });
});

describe("dos canales: WhatsApp y Telegram", () => {
  it("la ayuda menciona el canal correcto y, en Telegram, los comandos con barra; nunca el otro canal", () => {
    const wa = R.help("whatsapp");
    const tg = R.help("telegram");
    expect(wa).toContain("en WhatsApp");
    expect(wa).not.toMatch(/Telegram|\/tarjetas/);
    expect(tg).toContain("en Telegram");
    expect(tg).not.toContain("WhatsApp");
    expect(tg).toContain("/deshacer");
    expect(tg).toContain("En un grupo");
    for (const t of [wa, tg]) {
      expect(t.match(/^• /gm)).toHaveLength(3);
      for (const c of ["tarjetas", "hoy", "resumen", "deshacer", "cancelar"]) expect(t).toContain(c);
    }
    expect(R.help()).toBe(R.HELP);
  });

  it("etiquetas de fuente: Telegram, las de fecha explícita y las de siempre", () => {
    expect(R.viaLabel("telegram")).toBe("Telegram");
    expect(R.viaLabel("telegram-d")).toBe("Telegram");
    expect(R.viaLabel("whatsapp-d")).toBe("WhatsApp");
    expect(R.viaLabel("telegram,shortcut,email")).toBe("Telegram + Atajo + correo");
    expect(R.askDuplicate({ merchant: "Starbucks", cents: 35000, when: "ayer", sources: "telegram-d" })).toContain("vía Telegram");
  });

  it("preguntas de monto según por qué falta", () => {
    expect(R.askAmount({ merchant: "Renta", cents: null }, { kind: "mil", raw: "mil 500" })).toContain("No me quedó claro «mil 500»");
    expect(R.askAmount({ merchant: "Liverpool", cents: null }, { kind: "installments" })).toContain("meses sin intereses");
    expect(R.askAmount({ merchant: "Liverpool", cents: null }, { kind: "installments" })).toContain("¿Cuánto fue lo de Liverpool en total?");
    const q = R.askAmount({ merchant: "Oxxo", cents: null }, { kind: "last4", digits: "1234" });
    expect(q).toContain("¿$1,234 o terminación 1234?");
    expect(R.askAmount({ merchant: "Uber", cents: null }, { kind: "many" })).toContain("varios números");
    expect(R.askAmount({ merchant: "Uber", cents: null }, null)).not.toContain("varios");
    // dos cifras y una podría ser la terminación de una tarjeta
    const e = R.askAmount({ merchant: "Eleven", cents: null }, { kind: "either", ending: "296", cents: 700 });
    expect(e).toContain("¿Cuánto fue: $296 o $7?");
    expect(e).toContain("*terminación 296*");
    expect(R.askAmount({ merchant: "Taxi", cents: null }, { kind: "either", ending: "296", cents: 5050 })).toContain("¿Cuánto fue: $296 o $50.50?");
    // la única cifra era una hora
    expect(R.askAmount({ merchant: "Oxxo", cents: null }, { kind: "time", raw: "5pm" })).toContain("Vi una hora («5pm») pero no un monto");
  });

  it("stripFormat quita las negritas de los textos fijos para un transporte de texto plano", () => {
    expect(R.stripFormat(R.help("telegram"))).not.toContain("*");
    expect(R.stripFormat("Responde *sí* o *no*.")).toBe("Responde sí o no.");
  });

  it("replyAddress: replyTo manda; en WhatsApp 521+10 dígitos se contesta a 52+10", () => {
    expect(replyAddress({ from: "tg1001", replyTo: "-100500", channel: "telegram" })).toBe("-100500");
    expect(replyAddress({ from: "tg1001", channel: "telegram" })).toBe("tg1001");
    // Telegram no se toca aunque parezca un móvil mexicano
    expect(replyAddress({ from: "x", replyTo: "5215550000001", channel: "telegram" })).toBe("5215550000001");
    expect(replyAddress({ from: "5215550000001" })).toBe("525550000001");
    expect(replyAddress({ from: "5215550000001", channel: "whatsapp" })).toBe("525550000001");
    expect(replyAddress({ from: "+5215550000001" })).toBe("525550000001");
    expect(replyAddress({ from: "x", replyTo: "5215550000001" })).toBe("525550000001");
    // ya viene bien, o no es de México
    expect(replyAddress({ from: "525550000001" })).toBe("525550000001");
    expect(replyAddress({ from: "14155550123" })).toBe("14155550123");
    // 521 con otra longitud: no se toca
    expect(replyAddress({ from: "52155500000" })).toBe("52155500000");
    expect(replyAddress({ from: "521555000000012" })).toBe("521555000000012");
  });
});
