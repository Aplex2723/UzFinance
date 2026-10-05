/**
 * Filtros de la pantalla Transacciones: módulo PURO (sin base de datos ni React) que comparten la página, la barra de filtros del
 * cliente, la API y las pruebas. La URL es la fuente de verdad: aquí se interpreta (`parseTxParams`, tolerante: lo inválido se ignora)
 * y se escribe (`serializeTxParams`, estable y sin valores por omisión). La API usa los mismos validadores primitivos pero ESTRICTOS
 * (ver `listQuery` en schemas.ts): un parámetro inválido es 400.
 *
 * Todas las fechas son YYYY-MM-DD en hora de Ciudad de México; "hoy" siempre llega como argumento (`today`), nunca se lee el reloj
 * aquí dentro, así las fronteras (23:59 CDMX = día siguiente en UTC) se prueban sin trucos.
 */
import { DATED_SUFFIX, SOURCE_UI_LABELS } from "./chat-sources";
import { monthRange, MONTH_RE, localDate, prevMonth } from "./time";

/* ---------------------------------------------------------------- fechas ---- */

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Tope de un rango from→to (5 años): evita consultas absurdas. */
export const MAX_RANGE_DAYS = 5 * 366;

const parts = (s: string) => s.split("-").map(Number);
const iso = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** ¿Es una fecha de calendario real (no 2026-02-30) y de un año razonable? */
export function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = parts(s);
  if (y < 1900 || y > 2100) return false;
  return iso(new Date(Date.UTC(y, m - 1, d))) === s;
}

export const isRealMonth = (s: string): boolean => MONTH_RE.test(s) && isRealDate(`${s}-01`);

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return iso(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Días entre dos fechas (b − a). */
export function diffDays(a: string, b: string): number {
  const ms = (s: string) => { const [y, m, d] = parts(s); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** Días que abarca un rango, ambos extremos incluidos. */
export const rangeDays = (from: string, to: string): number => diffDays(from, to) + 1;

/** Lunes = 0 … domingo = 6. */
export function weekdayIndex(date: string): number {
  const [y, m, d] = parts(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export const todayLocal = (now = new Date()): string => localDate(now);

export const lastDayOfMonth = (month: string): string => monthRange(month).to;

/** ¿from ≤ to y el rango cabe en el tope? (ambos opcionales: un extremo abierto siempre es válido). */
export function rangeError(from?: string | null, to?: string | null): string | null {
  if (from && to) {
    if (from > to) return "'from' no puede ser posterior a 'to'";
    if (rangeDays(from, to) > MAX_RANGE_DAYS) return "El rango no puede pasar de 5 años";
  }
  return null;
}

/* ------------------------------------------------------------- periodos ----- */

export type PeriodPreset = "today" | "yesterday" | "week" | "month" | "last_month" | "last30";
export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "today", label: "Hoy" },
  { id: "yesterday", label: "Ayer" },
  { id: "week", label: "Esta semana" },
  { id: "month", label: "Este mes" },
  { id: "last_month", label: "Mes pasado" },
  { id: "last30", label: "Últimos 30 días" },
];
/** Atajos que se guardan como from/to (los de mes se guardan como `month`). */
const DATE_PRESETS: readonly PeriodPreset[] = ["today", "yesterday", "week", "last30"];

export type Period = { month: string } | { from: string; to: string };

/** Periodo de un atajo según el día de hoy (hora de CDMX). Semana = lunes → hoy; 30 días = hoy y los 29 anteriores. */
export function presetPeriod(preset: PeriodPreset, today: string): Period {
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = addDays(today, -1); return { from: y, to: y }; }
    case "week": return { from: addDays(today, -weekdayIndex(today)), to: today };
    case "month": return { month: today.slice(0, 7) };
    case "last_month": return { month: prevMonth(today.slice(0, 7)) };
    case "last30": return { from: addDays(today, -29), to: today };
  }
}

type PeriodFields = { month?: string | null; from?: string | null; to?: string | null };

/** Rango efectivo (month ∩ from/to). Sin periodo → {}. Un extremo abierto queda como undefined. */
export function effectiveRange(p: PeriodFields): { from?: string; to?: string } {
  let from = p.from || undefined;
  let to = p.to || undefined;
  if (p.month) {
    const r = monthRange(p.month);
    if (!from || from < r.from) from = r.from;
    if (!to || to > r.to) to = r.to;
  }
  return { from, to };
}

/** Atajo activo: se deduce COMPARANDO FECHAS con el hoy actual (un `preset` viejo en la URL no resalta nada). */
export function detectPreset(p: PeriodFields, today: string): PeriodPreset | null {
  if (p.month && !p.from && !p.to) {
    if (p.month === today.slice(0, 7)) return "month";
    if (p.month === prevMonth(today.slice(0, 7))) return "last_month";
    return null;
  }
  if (p.from && p.to && !p.month) {
    for (const id of DATE_PRESETS) {
      const per = presetPeriod(id, today);
      if ("from" in per && per.from === p.from && per.to === p.to) return id;
    }
  }
  return null;
}

export const hasPeriod = (p: PeriodFields): boolean => !!(p.month || p.from || p.to);

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_LONG = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "4 oct" (con el año si no es el de hoy). */
export function shortDate(date: string, today: string): string {
  const [y, m, d] = parts(date);
  return `${d} ${MONTHS_SHORT[m - 1]}${y === Number(today.slice(0, 4)) ? "" : ` ${y}`}`;
}

/** Nombre corto del periodo para etiquetas y títulos ("hoy", "este mes", "1 oct – 15 oct"…). Sin periodo → null. */
export function periodLabel(p: PeriodFields, today: string): string | null {
  if (!hasPeriod(p)) return null;
  const preset = detectPreset(p, today);
  if (preset) return PERIOD_PRESETS.find((x) => x.id === preset)!.label.toLowerCase();
  if (p.month && !p.from && !p.to) {
    const [y, m] = parts(`${p.month}-01`);
    return `${MONTHS_LONG[m - 1]} ${y}`;
  }
  const r = effectiveRange(p);
  if (r.from && r.to) return r.from === r.to ? shortDate(r.from, today) : `${shortDate(r.from, today)} – ${shortDate(r.to, today)}`;
  return r.from ? `desde ${shortDate(r.from, today)}` : `hasta ${shortDate(r.to!, today)}`;
}

/* ---------------------------------------------------------------- fuentes --- */

export const SOURCE_IDS = ["shortcut", "email", "statement", "receipt", "manual", "whatsapp", "telegram"] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/**
 * Qué significa cada opción de "Fuente" = el movimiento tiene esa etiqueta en `transactions.sources` (lista separada por comas).
 * Un movimiento FUSIONADO ("shortcut,email") cuenta para ambas opciones. WhatsApp/Telegram incluyen también el gasto tecleado con
 * fecha explícita (`whatsapp-d`). "Manual" es solo lo capturado en la app (no lo tecleado por chat). Varias fuentes elegidas = O.
 * Filas antiguas con `sources` vacío caen a la columna `source`.
 */
export const SOURCE_TOKENS: Record<SourceId, readonly string[]> = {
  shortcut: ["shortcut"],
  email: ["email"],
  statement: ["statement"],
  receipt: ["receipt"],
  manual: ["manual"],
  whatsapp: ["whatsapp", `whatsapp${DATED_SUFFIX}`],
  telegram: ["telegram", `telegram${DATED_SUFFIX}`],
};

export const SOURCE_FILTER_LABEL: Record<SourceId, string> = {
  shortcut: SOURCE_UI_LABELS.shortcut,
  email: SOURCE_UI_LABELS.email,
  statement: SOURCE_UI_LABELS.statement,
  receipt: SOURCE_UI_LABELS.receipt,
  manual: SOURCE_UI_LABELS.manual,
  whatsapp: SOURCE_UI_LABELS.whatsapp,
  telegram: SOURCE_UI_LABELS.telegram,
};

export const SOURCE_FILTER_HINT: Record<SourceId, string> = {
  shortcut: "Llegó por el Atajo del iPhone (incluye los que luego confirmó el correo del banco)",
  email: "Lo registró o confirmó un correo del banco",
  statement: "Viene de un estado de cuenta en PDF",
  receipt: "Viene de un comprobante de transferencia en PDF",
  manual: "Lo capturaste a mano en la app",
  whatsapp: "Lo tecleaste por WhatsApp",
  telegram: "Lo tecleaste por Telegram",
};

export const isSourceId = (s: string): s is SourceId => (SOURCE_IDS as readonly string[]).includes(s);

/* ------------------------------------------------------------------ orden --- */

export const SORT_IDS = ["recent", "oldest", "amount_desc", "amount_asc"] as const;
export type TxSort = (typeof SORT_IDS)[number];
export const SORT_LABEL: Record<TxSort, string> = {
  recent: "Más recientes",
  oldest: "Más antiguos",
  amount_desc: "Mayor monto",
  amount_asc: "Menor monto",
};
export const isSort = (s: string): s is TxSort => (SORT_IDS as readonly string[]).includes(s);

/* ------------------------------------------------------------------ montos -- */

/** Tope de un monto de filtro (el mismo que acepta parseAmountToCents): $100,000,000. */
export const MAX_FILTER_CENTS = 100_000_000_00;

/** "99", "99.5", "99.50" → centavos. Estricto (es lo que viaja en la URL); 0, negativos y basura → null. Sin aritmética flotante. */
export function parsePesos(s: string | null | undefined): number | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 && cents <= MAX_FILTER_CENTS ? cents : null;
}

/** Lo que teclea la persona: tolera "$1,500.50" y espacios. */
export const parsePesosLoose = (s: string): number | null => parsePesos(s.replace(/[$,\s]/g, ""));

/** Centavos → texto de la URL / del campo ("100", "99.5", "99.05"). */
export function centsToPesos(cents: number): string {
  const w = Math.floor(cents / 100);
  const f = cents % 100;
  return f === 0 ? String(w) : `${w}.${String(f).padStart(2, "0").replace(/0$/, "")}`;
}

/* -------------------------------------------------------- criterios y vista -- */

export type TxKindFilter = "expense" | "card_payment" | "all";

/** Criterios de filtrado (todos opcionales). `TxFilter` del repositorio los extiende con paginación. */
export type TxCriteria = {
  q?: string;
  cardIds?: number[];
  categoryId?: number | "none";
  /** Por omisión solo gastos (los pagos de tarjeta no cuentan como gasto). */
  kind?: TxKindFilter;
  month?: string;
  from?: string;
  to?: string;
  sources?: SourceId[];
  /** Sobre el monto ABSOLUTO (un reembolso de −$500 cuenta como 500). */
  minCents?: number;
  maxCents?: number;
  /** Solo "sin confirmación bancaria" (la columna calculada `unconfirmed`). */
  unconfirmed?: boolean;
  /** Solo compras a meses (MSI). */
  msi?: boolean;
  recurring?: boolean;
  sort?: TxSort;
};

/** Estado normalizado de la pantalla (serializable: viaja del servidor al cliente). */
export type TxView = {
  q: string;
  cardIds: number[];
  categoryId: number | "none" | null;
  kind: "expense" | "card_payment";
  month: string | null;
  from: string | null;
  to: string | null;
  sources: SourceId[];
  minCents: number | null;
  maxCents: number | null;
  unconfirmed: boolean;
  msi: boolean;
  recurring: boolean;
  sort: TxSort;
  page: number;
};

export const DEFAULT_VIEW: TxView = {
  q: "", cardIds: [], categoryId: null, kind: "expense", month: null, from: null, to: null, sources: [],
  minCents: null, maxCents: null, unconfirmed: false, msi: false, recurring: false, sort: "recent", page: 1,
};

export const MAX_CARDS = 50;
export const MAX_Q = 100;
const MAX_PAGE = 10_000;
const INT_MAX = 2_147_483_647;

export type ParamsLike = URLSearchParams | Record<string, string | string[] | undefined>;

function allOf(sp: ParamsLike, key: string): string[] {
  if (sp instanceof URLSearchParams) return sp.getAll(key);
  const v = sp[key];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
const firstOf = (sp: ParamsLike, key: string): string | undefined => allOf(sp, key).find((v) => v !== "");

/** Entero positivo de 32 bits en forma canónica ("12"), si no null. */
export function parseId(s: string | null | undefined): number | null {
  if (typeof s !== "string" || !/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= INT_MAX ? n : null;
}

export function parseFlag(s: string | null | undefined): boolean | null {
  return s === "1" || s === "true" ? true : s === "0" || s === "false" ? false : null;
}

export type ParsedView = { view: TxView; issues: string[] };

/**
 * URL → estado. Tolerante: un valor inválido se descarta (y se anota en `issues`), nunca rompe la página.
 * Compatibilidad: `?card=3`, `?category=none|7`, `?month=2026-09`, `?q=`, `?kind=card_payment` siguen igual.
 * `?preset=today` SOLA (sin fechas) se resuelve contra `today`: sirve de enlace "siempre hoy". Con fechas, el preset se ignora.
 */
export function parseTxParams(sp: ParamsLike, today: string): ParsedView {
  const issues: string[] = [];
  const v: TxView = { ...DEFAULT_VIEW, cardIds: [], sources: [] };

  const q = firstOf(sp, "q");
  if (q !== undefined) v.q = q.trim().slice(0, MAX_Q);

  for (const raw of allOf(sp, "card")) {
    const id = parseId(raw);
    if (id === null) { if (raw !== "") issues.push(`card inválida: ${raw}`); continue; }
    if (!v.cardIds.includes(id) && v.cardIds.length < MAX_CARDS) v.cardIds.push(id);
  }

  const cat = firstOf(sp, "category");
  if (cat !== undefined) {
    if (cat === "none") v.categoryId = "none";
    else {
      const id = parseId(cat);
      if (id === null) issues.push(`category inválida: ${cat}`);
      else v.categoryId = id;
    }
  }

  if (firstOf(sp, "kind") === "card_payment") v.kind = "card_payment";

  const month = firstOf(sp, "month");
  let from = firstOf(sp, "from");
  let to = firstOf(sp, "to");
  if (month !== undefined) {
    if (isRealMonth(month)) v.month = month;
    else issues.push(`month inválido: ${month}`);
  }
  if (from !== undefined && !isRealDate(from)) { issues.push(`from inválida: ${from}`); from = undefined; }
  if (to !== undefined && !isRealDate(to)) { issues.push(`to inválida: ${to}`); to = undefined; }
  if (v.month) {
    if (from || to) issues.push("month tiene prioridad sobre from/to");
  } else {
    if (from && to && from > to) { issues.push("from > to: se intercambiaron"); [from, to] = [to, from]; }
    if (rangeError(from, to)) { issues.push(rangeError(from, to)!); from = undefined; to = undefined; }
    v.from = from ?? null;
    v.to = to ?? null;
  }
  const preset = firstOf(sp, "preset");
  if (!hasPeriod(v) && preset && PERIOD_PRESETS.some((p) => p.id === preset)) {
    const per = presetPeriod(preset as PeriodPreset, today);
    if ("month" in per) v.month = per.month;
    else { v.from = per.from; v.to = per.to; }
  }

  for (const raw of allOf(sp, "source")) {
    if (isSourceId(raw)) { if (!v.sources.includes(raw)) v.sources.push(raw); } else if (raw !== "") issues.push(`source inválida: ${raw}`);
  }

  const min = firstOf(sp, "min");
  const max = firstOf(sp, "max");
  if (min !== undefined) { v.minCents = parsePesos(min); if (v.minCents === null) issues.push(`min inválido: ${min}`); }
  if (max !== undefined) { v.maxCents = parsePesos(max); if (v.maxCents === null) issues.push(`max inválido: ${max}`); }
  if (v.minCents !== null && v.maxCents !== null && v.minCents > v.maxCents) {
    issues.push("min > max: se intercambiaron");
    [v.minCents, v.maxCents] = [v.maxCents, v.minCents];
  }

  v.unconfirmed = parseFlag(firstOf(sp, "unconfirmed")) === true;
  v.msi = parseFlag(firstOf(sp, "msi")) === true;
  v.recurring = parseFlag(firstOf(sp, "recurring")) === true;

  const sort = firstOf(sp, "sort");
  if (sort !== undefined) { if (isSort(sort)) v.sort = sort; else issues.push(`sort inválido: ${sort}`); }

  const page = firstOf(sp, "page");
  if (page !== undefined) {
    const n = parseId(page);
    v.page = n === null ? 1 : Math.min(n, MAX_PAGE);
  }
  return { view: v, issues };
}

/**
 * Estado → parámetros de URL, estables y sin valores por omisión (así la URL limpia es /transacciones). Los atajos de fechas
 * añaden `preset` solo como ayuda de lectura; lo que cuenta son from/to. La página (`page`) solo se escribe si es > 1.
 */
export function serializeTxParams(v: Partial<TxView>, today: string): URLSearchParams {
  const u = new URLSearchParams();
  const q = (v.q ?? "").trim().slice(0, MAX_Q);
  if (q) u.set("q", q);
  if (v.kind === "card_payment") u.set("kind", "card_payment");
  for (const id of [...new Set(v.cardIds ?? [])].slice(0, MAX_CARDS)) u.append("card", String(id));
  if (v.categoryId) u.set("category", String(v.categoryId));
  if (v.month) u.set("month", v.month);
  else {
    if (v.from) u.set("from", v.from);
    if (v.to) u.set("to", v.to);
    const preset = detectPreset({ from: v.from, to: v.to }, today);
    if (preset && DATE_PRESETS.includes(preset)) u.set("preset", preset);
  }
  for (const s of SOURCE_IDS) if (v.sources?.includes(s)) u.append("source", s);
  if (v.minCents) u.set("min", centsToPesos(v.minCents));
  if (v.maxCents) u.set("max", centsToPesos(v.maxCents));
  if (v.unconfirmed) u.set("unconfirmed", "1");
  if (v.msi) u.set("msi", "1");
  if (v.recurring) u.set("recurring", "1");
  if (v.sort && v.sort !== "recent") u.set("sort", v.sort);
  if (v.page && v.page > 1) u.set("page", String(v.page));
  return u;
}

/** Estado → criterios para el repositorio (descarta lo vacío). */
export function viewToCriteria(v: TxView): TxCriteria {
  return {
    q: v.q || undefined,
    cardIds: v.cardIds.length ? v.cardIds : undefined,
    categoryId: v.categoryId ?? undefined,
    kind: v.kind,
    month: v.month ?? undefined,
    from: v.from ?? undefined,
    to: v.to ?? undefined,
    sources: v.sources.length ? v.sources : undefined,
    minCents: v.minCents ?? undefined,
    maxCents: v.maxCents ?? undefined,
    unconfirmed: v.unconfirmed || undefined,
    msi: v.msi || undefined,
    recurring: v.recurring || undefined,
    sort: v.sort,
  };
}

/** Filtros que "Limpiar filtros" quita (el tipo de movimiento y el orden se conservan). */
export const CLEARED: Partial<TxView> = {
  q: "", cardIds: [], categoryId: null, month: null, from: null, to: null, sources: [],
  minCents: null, maxCents: null, unconfirmed: false, msi: false, recurring: false, page: 1,
};

/** Cuántos filtros hay activos (sin contar tipo, orden ni página). */
export function activeFilterCount(v: TxView): number {
  return activeTags(v, { cards: {}, categories: {} }, "2000-01-01").length;
}

/** Los "avanzados" (los que viven en el panel Más filtros). */
export function advancedCount(v: TxView): number {
  return (v.categoryId ? 1 : 0) + v.sources.length + (v.minCents !== null || v.maxCents !== null ? 1 : 0) + (v.unconfirmed ? 1 : 0) + (v.msi ? 1 : 0) + (v.recurring ? 1 : 0);
}

/* -------------------------------------------------------------- etiquetas ---- */

export type FilterTag = { key: string; label: string; /** Cambios al estado que QUITAN este filtro. */ remove: Partial<TxView> };

const money = (c: number) => `$${centsToPesos(c).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/** Una etiqueta removible por cada filtro activo, en el orden en que se muestran. */
export function activeTags(
  v: TxView,
  lookups: { cards: Record<number, string>; categories: Record<number, string> },
  today: string,
): FilterTag[] {
  const tags: FilterTag[] = [];
  if (v.q) tags.push({ key: "q", label: `Búsqueda: “${v.q}”`, remove: { q: "" } });
  const per = periodLabel(v, today);
  if (per) tags.push({ key: "period", label: `Periodo: ${per}`, remove: { month: null, from: null, to: null } });
  for (const id of v.cardIds) tags.push({ key: `card-${id}`, label: `Tarjeta: ${lookups.cards[id] ?? `#${id}`}`, remove: { cardIds: v.cardIds.filter((x) => x !== id) } });
  if (v.categoryId) tags.push({ key: "category", label: `Categoría: ${v.categoryId === "none" ? "Sin categoría" : lookups.categories[v.categoryId] ?? `#${v.categoryId}`}`, remove: { categoryId: null } });
  for (const s of v.sources) tags.push({ key: `source-${s}`, label: `Fuente: ${SOURCE_FILTER_LABEL[s]}`, remove: { sources: v.sources.filter((x) => x !== s) } });
  if (v.minCents !== null || v.maxCents !== null) {
    const label = v.minCents !== null && v.maxCents !== null ? `Monto: ${money(v.minCents)} – ${money(v.maxCents)}` : v.minCents !== null ? `Monto: desde ${money(v.minCents)}` : `Monto: hasta ${money(v.maxCents!)}`;
    tags.push({ key: "amount", label, remove: { minCents: null, maxCents: null } });
  }
  if (v.unconfirmed) tags.push({ key: "unconfirmed", label: "Sin confirmar", remove: { unconfirmed: false } });
  if (v.msi) tags.push({ key: "msi", label: "Solo MSI", remove: { msi: false } });
  if (v.recurring) tags.push({ key: "recurring", label: "Solo recurrentes", remove: { recurring: false } });
  return tags;
}

/* ------------------------------------------------------------ nombre corto -- */

/** "Banamex Oro" → "Oro", "American Express Platinum" → "Platinum" (el banco ya va como encabezado del grupo). */
export function shortCardName(name: string): string {
  const rest = name.replace(/^(american express|amex|citibanamex|banamex)\s+/i, "").trim();
  return rest.length >= 2 ? rest : name;
}
