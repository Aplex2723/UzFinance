import { describe, expect, it } from "vitest";
import {
  activeFilterCount, activeTags, addDays, advancedCount, centsToPesos, CLEARED, DEFAULT_VIEW, detectPreset, diffDays, effectiveRange, isRealDate, MAX_CARDS,
  parseFlag, parseId, parsePesos, parsePesosLoose, parseTxParams, periodLabel, presetPeriod, rangeDays, rangeError, serializeTxParams, shortCardName,
  todayLocal, viewToCriteria, weekdayIndex, type PeriodPreset, type TxView,
} from "@/lib/tx-filters";
import { avgTicket, compareTotals, dailyAverage, isTodayPeriod, pctChange, previousPeriod, rankShares } from "@/lib/tx-summary";

const view = (o: Partial<TxView> = {}): TxView => ({ ...DEFAULT_VIEW, cardIds: [], sources: [], ...o });
const parse = (qs: string, today = "2026-10-04") => parseTxParams(new URLSearchParams(qs), today);

describe("fechas", () => {
  it("isRealDate: calendario real, bisiestos y formatos", () => {
    expect(isRealDate("2026-10-04")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-1-1")).toBe(false);
    expect(isRealDate("2026-10-04T00:00")).toBe(false);
    expect(isRealDate("0001-01-01")).toBe(false);
    expect(isRealDate("")).toBe(false);
  });
  it("addDays cruza fin de mes, de año y 29 de febrero", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-10-04", 0)).toBe("2026-10-04");
    expect(diffDays("2026-02-28", "2026-03-01")).toBe(1);
    expect(rangeDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(rangeDays("2026-10-01", "2026-10-30")).toBe(30);
  });
  it("weekdayIndex: lunes = 0 … domingo = 6", () => {
    expect(weekdayIndex("2026-09-28")).toBe(0); // lunes
    expect(weekdayIndex("2026-10-04")).toBe(6); // domingo
    expect(weekdayIndex("2026-10-01")).toBe(3); // jueves
  });
  it("todayLocal: 23:59 en CDMX sigue siendo hoy aunque en UTC ya sea mañana", () => {
    expect(todayLocal(new Date("2026-10-05T05:59:00Z"))).toBe("2026-10-04"); // 23:59 CDMX
    expect(todayLocal(new Date("2026-10-05T06:00:00Z"))).toBe("2026-10-05"); // 00:00 CDMX
    expect(todayLocal(new Date("2027-01-01T05:59:59Z"))).toBe("2026-12-31"); // cambio de año
    expect(todayLocal(new Date("2026-10-04T00:30:00Z"))).toBe("2026-10-03"); // 18:30 CDMX del día anterior
  });
  it("rangeError: orden y tope de 5 años", () => {
    expect(rangeError("2026-10-05", "2026-10-04")).toMatch(/posterior/);
    expect(rangeError("2026-10-04", "2026-10-04")).toBeNull();
    expect(rangeError("2021-10-05", "2026-10-04")).toBeNull(); // ~5 años exactos
    expect(rangeError("2020-01-01", "2026-10-04")).toMatch(/5 años/);
    expect(rangeError("2020-01-01", null)).toBeNull(); // extremo abierto
    expect(rangeError(null, null)).toBeNull();
  });
});

describe("presets de periodo", () => {
  const P = (id: PeriodPreset, today: string) => presetPeriod(id, today);
  it("hoy y ayer", () => {
    expect(P("today", "2026-10-04")).toEqual({ from: "2026-10-04", to: "2026-10-04" });
    expect(P("yesterday", "2026-10-04")).toEqual({ from: "2026-10-03", to: "2026-10-03" });
  });
  it("ayer en fronteras: 1 de mes, 1 de marzo (28 y 29 de febrero) y 1 de enero", () => {
    expect(P("yesterday", "2026-10-01")).toEqual({ from: "2026-09-30", to: "2026-09-30" });
    expect(P("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(P("yesterday", "2028-03-01")).toEqual({ from: "2028-02-29", to: "2028-02-29" });
    expect(P("yesterday", "2027-01-01")).toEqual({ from: "2026-12-31", to: "2026-12-31" });
  });
  it("semana = lunes → hoy (lunes, domingo y a media semana)", () => {
    expect(P("week", "2026-09-28")).toEqual({ from: "2026-09-28", to: "2026-09-28" }); // lunes
    expect(P("week", "2026-10-04")).toEqual({ from: "2026-09-28", to: "2026-10-04" }); // domingo
    expect(P("week", "2026-09-30")).toEqual({ from: "2026-09-28", to: "2026-09-30" }); // miércoles
    expect(P("week", "2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-01" }); // la semana cruza el año
  });
  it("mes y mes pasado (cambio de año)", () => {
    expect(P("month", "2026-10-04")).toEqual({ month: "2026-10" });
    expect(P("last_month", "2026-10-04")).toEqual({ month: "2026-09" });
    expect(P("last_month", "2027-01-15")).toEqual({ month: "2026-12" });
    expect(P("month", "2026-10-01")).toEqual({ month: "2026-10" });
  });
  it("últimos 30 días = hoy y los 29 anteriores (30 días en total)", () => {
    const p = P("last30", "2027-01-10") as { from: string; to: string };
    expect(p).toEqual({ from: "2026-12-12", to: "2027-01-10" });
    expect(rangeDays(p.from, p.to)).toBe(30);
  });
  it("con el reloj real: a las 23:59 CDMX 'hoy' aún es el día local, no el de UTC", () => {
    const today = todayLocal(new Date("2026-10-05T05:59:00Z"));
    expect(P("today", today)).toEqual({ from: "2026-10-04", to: "2026-10-04" });
    expect(P("yesterday", today)).toEqual({ from: "2026-10-03", to: "2026-10-03" });
  });
  it("detectPreset compara fechas: un atajo viejo no resalta nada", () => {
    expect(detectPreset({ from: "2026-10-04", to: "2026-10-04" }, "2026-10-04")).toBe("today");
    expect(detectPreset({ from: "2026-10-04", to: "2026-10-04" }, "2026-10-05")).toBe("yesterday");
    expect(detectPreset({ from: "2026-10-04", to: "2026-10-04" }, "2026-10-09")).toBeNull();
    expect(detectPreset({ from: "2026-09-28", to: "2026-10-04" }, "2026-10-04")).toBe("week");
    expect(detectPreset({ from: "2026-09-05", to: "2026-10-04" }, "2026-10-04")).toBe("last30");
    expect(detectPreset({ month: "2026-10" }, "2026-10-04")).toBe("month");
    expect(detectPreset({ month: "2026-09" }, "2026-10-04")).toBe("last_month");
    expect(detectPreset({ month: "2026-03" }, "2026-10-04")).toBeNull();
    expect(detectPreset({}, "2026-10-04")).toBeNull();
    expect(detectPreset({ from: "2026-10-01", to: null }, "2026-10-04")).toBeNull();
  });
  it("effectiveRange: mes ∩ from/to", () => {
    expect(effectiveRange({})).toEqual({ from: undefined, to: undefined });
    expect(effectiveRange({ month: "2026-02" })).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(effectiveRange({ month: "2028-02" })).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(effectiveRange({ month: "2026-02", from: "2026-02-10", to: "2026-03-05" })).toEqual({ from: "2026-02-10", to: "2026-02-28" });
    expect(effectiveRange({ from: "2026-02-10" })).toEqual({ from: "2026-02-10", to: undefined });
  });
  it("periodLabel", () => {
    expect(periodLabel({}, "2026-10-04")).toBeNull();
    expect(periodLabel({ from: "2026-10-04", to: "2026-10-04" }, "2026-10-04")).toBe("hoy");
    expect(periodLabel({ month: "2026-10" }, "2026-10-04")).toBe("este mes");
    expect(periodLabel({ month: "2026-03" }, "2026-10-04")).toBe("marzo 2026");
    expect(periodLabel({ from: "2026-10-01", to: "2026-10-15" }, "2026-10-04")).toBe("1 oct – 15 oct");
    expect(periodLabel({ from: "2025-12-01", to: "2025-12-01" }, "2026-10-04")).toBe("1 dic 2025");
    expect(periodLabel({ from: "2026-10-01" }, "2026-10-04")).toBe("desde 1 oct");
    expect(periodLabel({ to: "2026-10-01" }, "2026-10-04")).toBe("hasta 1 oct");
  });
});

describe("montos en pesos", () => {
  it.each([["100", 10000], ["99.5", 9950], ["99.50", 9950], ["0.05", 5], ["1234567", 123456700], [" 10 ", 1000]])("parsePesos(%j) → %i", (s, c) => expect(parsePesos(s)).toBe(c));
  it.each(["", "0", "0.00", "-5", "1,000", "1e3", "12.345", ".5", "abc", "$5", "1.", "999999999999", "100000001"])("parsePesos rechaza %j", (s) => expect(parsePesos(s)).toBeNull());
  it("parsePesos: el tope es $100,000,000", () => {
    expect(parsePesos("100000000")).toBe(100_000_000_00);
    expect(parsePesos("100000000.01")).toBeNull();
  });
  it("parsePesosLoose tolera símbolo, comas y espacios", () => {
    expect(parsePesosLoose("$1,500.50")).toBe(150050);
    expect(parsePesosLoose(" 20 ")).toBe(2000);
    expect(parsePesosLoose("abc")).toBeNull();
  });
  it("centsToPesos es el inverso", () => {
    expect(centsToPesos(10000)).toBe("100");
    expect(centsToPesos(9950)).toBe("99.5");
    expect(centsToPesos(9905)).toBe("99.05");
    expect(centsToPesos(5)).toBe("0.05");
    for (const c of [1, 5, 10, 99, 100, 101, 150050, 123456700]) expect(parsePesos(centsToPesos(c))).toBe(c);
  });
  it("parseId y parseFlag", () => {
    expect(parseId("12")).toBe(12);
    for (const s of ["0", "-1", "1.5", "abc", "", "99999999999", "1 2"]) expect(parseId(s)).toBeNull();
    expect(parseId(undefined)).toBeNull();
    expect(parseFlag("1")).toBe(true);
    expect(parseFlag("true")).toBe(true);
    expect(parseFlag("0")).toBe(false);
    expect(parseFlag("yes")).toBeNull();
  });
});

describe("parseTxParams (tolerante)", () => {
  it("sin parámetros = vista por omisión (todo, solo gastos, más recientes, página 1)", () => {
    const { view: v, issues } = parse("");
    expect(v).toEqual(DEFAULT_VIEW);
    expect(issues).toEqual([]);
  });
  it("enlaces de otras pantallas siguen funcionando", () => {
    expect(parse("kind=card_payment&month=2026-09").view).toMatchObject({ kind: "card_payment", month: "2026-09" });
    expect(parse("q=STARBUCKS&month=2026-09").view).toMatchObject({ q: "STARBUCKS", month: "2026-09", kind: "expense" });
    expect(parse("card=3").view.cardIds).toEqual([3]);
    expect(parse("category=none").view.categoryId).toBe("none");
    expect(parse("category=7").view.categoryId).toBe(7);
    expect(parse("q=TIENDITA&category=none").view).toMatchObject({ q: "TIENDITA", categoryId: "none" });
  });
  it("tarjetas repetidas: sin duplicados, solo ids válidos, con tope", () => {
    expect(parse("card=1&card=2&card=1").view.cardIds).toEqual([1, 2]);
    const r = parse("card=1&card=abc&card=-2&card=0&card=3");
    expect(r.view.cardIds).toEqual([1, 3]);
    expect(r.issues.length).toBe(3);
    const many = Array.from({ length: 80 }, (_, i) => `card=${i + 1}`).join("&");
    expect(parse(many).view.cardIds).toHaveLength(MAX_CARDS);
  });
  it("acepta también un objeto de searchParams de Next (valores string | string[])", () => {
    const { view: v } = parseTxParams({ card: ["4", "5"], q: "x", source: "email", month: undefined }, "2026-10-04");
    expect(v).toMatchObject({ cardIds: [4, 5], q: "x", sources: ["email"] });
  });
  it("q: recorta espacios y a 100 caracteres", () => {
    expect(parse("q=%20%20hola%20%20").view.q).toBe("hola");
    expect(parse(`q=${"a".repeat(300)}`).view.q).toHaveLength(100);
  });
  it("fechas: inválidas se ignoran, al revés se intercambian, rango enorme se descarta", () => {
    expect(parse("from=2026-02-30&to=2026-03-01")).toMatchObject({ view: { from: null, to: "2026-03-01" } });
    expect(parse("from=2026-10-10&to=2026-10-01").view).toMatchObject({ from: "2026-10-01", to: "2026-10-10" });
    const huge = parse("from=2015-01-01&to=2026-10-01");
    expect(huge.view).toMatchObject({ from: null, to: null });
    expect(huge.issues.join()).toMatch(/5 años/);
    expect(parse("from=2026-10-01").view).toMatchObject({ from: "2026-10-01", to: null }); // abierto
  });
  it("month tiene prioridad sobre from/to; month inválido se ignora", () => {
    const r = parse("month=2026-09&from=2026-10-01&to=2026-10-02");
    expect(r.view).toMatchObject({ month: "2026-09", from: null, to: null });
    expect(r.issues.length).toBe(1);
    expect(parse("month=2026-13").view.month).toBeNull();
    expect(parse("month=hola").view.month).toBeNull();
  });
  it("preset sola se resuelve contra hoy; con fechas se ignora (se deduce de las fechas)", () => {
    expect(parse("preset=today", "2026-10-04").view).toMatchObject({ from: "2026-10-04", to: "2026-10-04" });
    expect(parse("preset=today", "2026-10-05").view).toMatchObject({ from: "2026-10-05", to: "2026-10-05" });
    expect(parse("preset=month", "2026-10-04").view.month).toBe("2026-10");
    expect(parse("preset=last30", "2026-10-04").view).toMatchObject({ from: "2026-09-05", to: "2026-10-04" });
    expect(parse("preset=today&from=2026-09-01&to=2026-09-02", "2026-10-04").view).toMatchObject({ from: "2026-09-01", to: "2026-09-02" });
    expect(parse("preset=bogus").view).toMatchObject({ from: null, to: null, month: null });
  });
  it("fuentes: lista blanca y sin duplicados", () => {
    const r = parse("source=email&source=shortcut&source=email&source=hack");
    expect(r.view.sources).toEqual(["email", "shortcut"]);
    expect(r.issues).toHaveLength(1);
  });
  it("monto min/max: inválidos fuera, al revés se intercambian", () => {
    expect(parse("min=100&max=500").view).toMatchObject({ minCents: 10000, maxCents: 50000 });
    expect(parse("min=500&max=100").view).toMatchObject({ minCents: 10000, maxCents: 50000 });
    expect(parse("min=abc&max=-5").view).toMatchObject({ minCents: null, maxCents: null });
    expect(parse("min=0").view.minCents).toBeNull();
    expect(parse("max=99.5").view.maxCents).toBe(9950);
  });
  it("banderas, orden y página", () => {
    expect(parse("unconfirmed=1&msi=true&recurring=1").view).toMatchObject({ unconfirmed: true, msi: true, recurring: true });
    expect(parse("unconfirmed=0&msi=no").view).toMatchObject({ unconfirmed: false, msi: false });
    expect(parse("sort=amount_desc").view.sort).toBe("amount_desc");
    expect(parse("sort=precio; DROP TABLE x").view.sort).toBe("recent");
    expect(parse("page=3").view.page).toBe(3);
    expect(parse("page=0").view.page).toBe(1);
    expect(parse("page=abc").view.page).toBe(1);
    expect(parse("page=999999999").view.page).toBe(10000);
  });
  it("kind: cualquier cosa que no sea card_payment es gastos", () => {
    expect(parse("kind=all").view.kind).toBe("expense");
    expect(parse("kind=zzz").view.kind).toBe("expense");
  });
});

describe("serializeTxParams", () => {
  const T = "2026-10-04";
  it("la vista por omisión da URL vacía", () => {
    expect(serializeTxParams(DEFAULT_VIEW, T).toString()).toBe("");
  });
  it("escribe solo lo activo, en orden estable, con tarjetas repetidas", () => {
    const qs = serializeTxParams(view({ q: " cafe ", cardIds: [2, 1, 2], categoryId: "none", sources: ["email", "shortcut"], minCents: 10000, maxCents: 9950 + 40000, unconfirmed: true, sort: "amount_asc", page: 3 }), T).toString();
    expect(qs).toBe("q=cafe&card=2&card=1&category=none&source=shortcut&source=email&min=100&max=499.5&unconfirmed=1&sort=amount_asc&page=3");
  });
  it("los atajos de fechas añaden preset; las fechas libres y los meses no", () => {
    expect(serializeTxParams(view({ from: T, to: T }), T).toString()).toBe(`from=${T}&to=${T}&preset=today`);
    expect(serializeTxParams(view({ from: "2026-09-28", to: T }), T).get("preset")).toBe("week");
    expect(serializeTxParams(view({ from: "2026-09-01", to: "2026-09-02" }), T).has("preset")).toBe(false);
    expect(serializeTxParams(view({ month: "2026-09" }), T).toString()).toBe("month=2026-09");
    expect(serializeTxParams(view({ month: "2026-09", from: "2026-01-01" }), T).has("from")).toBe(false);
  });
  it("kind solo si es pagos de tarjeta; page solo si > 1", () => {
    expect(serializeTxParams(view({ kind: "card_payment" }), T).toString()).toBe("kind=card_payment");
    expect(serializeTxParams(view({ page: 1 }), T).has("page")).toBe(false);
  });
  it("ida y vuelta: parse(serialize(v)) = v", () => {
    const v = view({ q: "uber", cardIds: [3, 9], categoryId: 4, kind: "card_payment", from: "2026-09-01", to: "2026-09-30", sources: ["whatsapp", "manual"], minCents: 150, maxCents: 123456, msi: true, recurring: true, sort: "oldest", page: 2 });
    const back = parse(serializeTxParams(v, T).toString(), T).view;
    expect(back).toEqual({ ...v, sources: ["manual", "whatsapp"] }); // orden canónico de fuentes
    const m = view({ month: "2026-02", unconfirmed: true });
    expect(parse(serializeTxParams(m, T).toString(), T).view).toEqual(m);
  });
  it("viewToCriteria descarta lo vacío", () => {
    expect(viewToCriteria(DEFAULT_VIEW)).toEqual({ kind: "expense", sort: "recent" });
    expect(viewToCriteria(view({ cardIds: [1], from: "2026-10-01", unconfirmed: true }))).toMatchObject({ cardIds: [1], from: "2026-10-01", unconfirmed: true });
  });
});

describe("etiquetas de filtros activos", () => {
  const lookups = { cards: { 1: "Banamex Oro", 2: "Nu" }, categories: { 7: "Súper" } };
  it("una etiqueta por filtro y cada una sabe cómo quitarse", () => {
    const v = view({ q: "uber", cardIds: [1, 2], categoryId: 7, from: "2026-10-04", to: "2026-10-04", sources: ["email"], minCents: 10000, msi: true });
    const tags = activeTags(v, lookups, "2026-10-04");
    expect(tags.map((t) => t.label)).toEqual([
      "Búsqueda: “uber”", "Periodo: hoy", "Tarjeta: Banamex Oro", "Tarjeta: Nu", "Categoría: Súper", "Fuente: Correo", "Monto: desde $100", "Solo MSI",
    ]);
    expect({ ...v, ...tags.find((t) => t.key === "card-1")!.remove }.cardIds).toEqual([2]);
    expect({ ...v, ...tags.find((t) => t.key === "period")!.remove }).toMatchObject({ from: null, to: null, month: null });
    expect({ ...v, ...tags.find((t) => t.key === "amount")!.remove }.minCents).toBeNull();
    // quitar una etiqueta (sobre el estado vigente) deja una menos, hasta dejar la vista limpia
    let cur = v;
    for (let n = tags.length; n > 0; n--) {
      const t = activeTags(cur, lookups, "2026-10-04")[0];
      cur = { ...cur, ...t.remove };
      expect(activeFilterCount(cur)).toBe(n - 1);
    }
  });
  it("montos: rango y tope, con separador de miles", () => {
    expect(activeTags(view({ minCents: 10000, maxCents: 150000 }), lookups, "2026-10-04")[0].label).toBe("Monto: $100 – $1,500");
    expect(activeTags(view({ maxCents: 9950 }), lookups, "2026-10-04")[0].label).toBe("Monto: hasta $99.5");
  });
  it("categoría 'none' y ids desconocidos", () => {
    expect(activeTags(view({ categoryId: "none", cardIds: [99] }), lookups, "2026-10-04").map((t) => t.label)).toEqual(["Tarjeta: #99", "Categoría: Sin categoría"]);
  });
  it("CLEARED conserva tipo y orden; advancedCount cuenta solo los del panel", () => {
    const v = view({ q: "x", kind: "card_payment", sort: "oldest", msi: true, sources: ["email", "manual"], categoryId: 3, minCents: 1, cardIds: [1] });
    const c = { ...v, ...CLEARED };
    expect(c).toMatchObject({ kind: "card_payment", sort: "oldest", q: "", msi: false, cardIds: [], sources: [] });
    expect(advancedCount(v)).toBe(1 + 2 + 1 + 1);
    expect(advancedCount(view({ q: "x", cardIds: [1] }))).toBe(0);
  });
  it("shortCardName quita el banco del nombre", () => {
    expect(shortCardName("Banamex Oro")).toBe("Oro");
    expect(shortCardName("American Express Platinum")).toBe("Platinum");
    expect(shortCardName("Nu Bank")).toBe("Nu Bank");
    expect(shortCardName("Banamex")).toBe("Banamex");
    expect(shortCardName("Débito ···296")).toBe("Débito ···296");
  });
});

describe("deltas y porcentajes", () => {
  it("pctChange: sin NaN ni Infinity", () => {
    expect(pctChange(112, 100)).toBeCloseTo(12);
    expect(pctChange(50, 100)).toBeCloseTo(-50);
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
    expect(pctChange(100, -50)).toBeNull();
    expect(pctChange(-30, 100)).toBeCloseTo(-130); // reembolsos netos
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(100, undefined)).toBeNull();
    expect(pctChange(100, Infinity)).toBeNull();
    expect(pctChange(NaN, 100)).toBeNull();
    expect(pctChange(0, 100)).toBeCloseTo(-100);
  });
  it("compareTotals", () => {
    expect(compareTotals(11200, 10000)).toMatchObject({ trend: "up", diffCents: 1200 });
    expect(compareTotals(5000, 10000)).toMatchObject({ trend: "down", diffCents: -5000 });
    expect(compareTotals(10000, 10000)).toEqual({ pct: 0, diffCents: 0, trend: "same" });
    expect(compareTotals(5000, 0)).toEqual({ pct: null, diffCents: 5000, trend: "up" });
    expect(compareTotals(0, 0)).toEqual({ pct: null, diffCents: 0, trend: "same" });
    expect(compareTotals(-500, 1000)).toMatchObject({ trend: "down" });
    expect(compareTotals(100, null)).toBeNull();
    expect(compareTotals(100, undefined)).toBeNull();
    expect(compareTotals(100, NaN)).toBeNull();
  });
  it("avgTicket y dailyAverage manejan cero", () => {
    expect(avgTicket(10000, 4)).toBe(2500);
    expect(avgTicket(10001, 3)).toBe(3334);
    expect(avgTicket(0, 0)).toBeNull();
    expect(avgTicket(500, 0)).toBeNull();
    expect(dailyAverage(30000, 30, 12)).toBe(1000);
    expect(dailyAverage(0, 30, 0)).toBeNull(); // sin datos: no hay con qué comparar
    expect(dailyAverage(100, 0, 3)).toBeNull();
  });
});

describe("rankShares", () => {
  const it3 = [
    { name: "B", cents: 3000, count: 2 }, { name: "A", cents: 3000, count: 1 }, { name: "C", cents: 1000, count: 5 }, { name: "D", cents: 500, count: 1 },
  ];
  it("top-N con empates por nombre; el % se calcula sobre la suma positiva y suma 100", () => {
    const r = rankShares(it3, 3);
    expect(r.top.map((x) => x.name)).toEqual(["A", "B", "C"]);
    expect(r.baseCents).toBe(7500);
    expect(r.top[0].pct).toBeCloseTo(40);
    expect(r.rest).toEqual({ groups: 1, cents: 500 });
    expect(rankShares(it3, 10).top.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100);
  });
  it("ignora grupos con monto ≤ 0 (reembolsos) y soporta vacío", () => {
    const r = rankShares([{ name: "X", cents: -500, count: 1 }, { name: "Y", cents: 0, count: 1 }, { name: "Z", cents: 200, count: 1 }], 3);
    expect(r.top.map((x) => x.name)).toEqual(["Z"]);
    expect(r.top[0].pct).toBe(100);
    expect(rankShares([], 3)).toEqual({ top: [], rest: { groups: 0, cents: 0 }, baseCents: 0 });
    expect(rankShares([{ name: "X", cents: 100, count: 1 }], 0).top).toEqual([]);
  });
});

describe("periodo anterior equivalente", () => {
  const T = "2026-10-04"; // domingo
  const prev = (p: Parameters<typeof previousPeriod>[0], today = T) => previousPeriod(p, today);
  it("hoy vs ayer, ayer vs anteayer, otro día vs el día anterior", () => {
    expect(prev({ from: T, to: T })).toEqual({ from: "2026-10-03", to: "2026-10-03", label: "vs ayer" });
    expect(prev({ from: "2026-10-03", to: "2026-10-03" })).toEqual({ from: "2026-10-02", to: "2026-10-02", label: "vs anteayer" });
    expect(prev({ from: "2026-09-10", to: "2026-09-10" })).toEqual({ from: "2026-09-09", to: "2026-09-09", label: "vs el día anterior" });
  });
  it("hoy el 1 de marzo compara contra el 28 de febrero (29 en bisiesto)", () => {
    expect(prev({ from: "2026-03-01", to: "2026-03-01" }, "2026-03-01")?.from).toBe("2026-02-28");
    expect(prev({ from: "2028-03-01", to: "2028-03-01" }, "2028-03-01")?.from).toBe("2028-02-29");
    expect(prev({ from: "2027-01-01", to: "2027-01-01" }, "2027-01-01")?.from).toBe("2026-12-31");
  });
  it("esta semana (lunes → hoy) vs los mismos días de la semana pasada; semana completa vs semana completa", () => {
    expect(prev({ from: "2026-09-28", to: T })).toEqual({ from: "2026-09-21", to: "2026-09-27", label: "vs semana pasada" });
    expect(prev({ from: "2026-09-28", to: "2026-09-30" }, "2026-09-30")).toEqual({ from: "2026-09-21", to: "2026-09-23", label: "vs semana pasada" });
    expect(prev({ from: "2026-09-14", to: "2026-09-20" })).toEqual({ from: "2026-09-07", to: "2026-09-13", label: "vs semana pasada" });
  });
  it("este mes (a la fecha) vs mismos días del mes pasado", () => {
    expect(prev({ month: "2026-10" })).toEqual({ from: "2026-09-01", to: "2026-09-04", label: "vs mes pasado" });
    expect(prev({ month: "2026-10" }, "2026-10-01")).toEqual({ from: "2026-09-01", to: "2026-09-01", label: "vs mes pasado" }); // día 1: sigue siendo "mes"
    // 30 de marzo contra febrero (28 días): se recorta al fin de febrero
    expect(prev({ month: "2026-03" }, "2026-03-30")).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "vs mes pasado" });
    expect(prev({ month: "2028-03" }, "2028-03-15")).toEqual({ from: "2028-02-01", to: "2028-02-15", label: "vs mes pasado" });
    expect(prev({ month: "2027-01" }, "2027-01-20")).toEqual({ from: "2026-12-01", to: "2026-12-20", label: "vs mes pasado" });
  });
  it("mes cerrado vs mes completo anterior", () => {
    expect(prev({ month: "2026-09" })).toEqual({ from: "2026-08-01", to: "2026-08-31", label: "vs mes anterior" });
    expect(prev({ month: "2026-03" })).toEqual({ from: "2026-02-01", to: "2026-02-28", label: "vs mes anterior" });
    expect(prev({ month: "2028-03" }, "2028-06-10")).toEqual({ from: "2028-02-01", to: "2028-02-29", label: "vs mes anterior" });
    expect(prev({ month: "2027-01" }, "2027-02-10")).toEqual({ from: "2026-12-01", to: "2026-12-31", label: "vs mes anterior" });
    expect(prev({ from: "2026-09-01", to: "2026-09-30" })?.label).toBe("vs mes anterior");
  });
  it("últimos 30 días vs los 30 previos; rangos libres vs rango anterior de igual longitud", () => {
    expect(prev({ from: "2026-09-05", to: T })).toEqual({ from: "2026-08-06", to: "2026-09-04", label: "vs 30 días previos" });
    const r = prev({ from: "2026-09-10", to: "2026-09-19" });
    expect(r).toEqual({ from: "2026-08-31", to: "2026-09-09", label: "vs periodo anterior" });
    expect(rangeDays(r!.from, r!.to)).toBe(10);
  });
  it("sin periodo, con extremo abierto o futuro → null", () => {
    expect(prev({})).toBeNull();
    expect(prev({ from: "2026-09-01" })).toBeNull();
    expect(prev({ to: "2026-09-01" })).toBeNull();
    expect(prev({ month: "2026-12" })).toBeNull();
    expect(prev({ from: "2026-11-01", to: "2026-11-05" })).toBeNull();
  });
  it("un rango que llega al futuro se recorta a hoy", () => {
    expect(prev({ from: "2026-10-01", to: "2026-10-31" })).toEqual({ from: "2026-09-01", to: "2026-09-04", label: "vs mes pasado" });
  });
  it("isTodayPeriod", () => {
    expect(isTodayPeriod({ from: T, to: T }, T)).toBe(true);
    expect(isTodayPeriod({ from: "2026-10-03", to: T }, T)).toBe(false);
    expect(isTodayPeriod({ month: "2026-10" }, T)).toBe(false);
    expect(isTodayPeriod({}, T)).toBe(false);
  });
});
