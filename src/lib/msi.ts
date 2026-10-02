import { monthLabel } from "./format";
import type { InsightMessage } from "./insights";
import { formatMXN } from "./money";

/**
 * Meses sin intereses (MSI) y planes a meses. Cada plan es la foto que imprime el estado de cuenta (as_of = fecha de corte):
 * cuántas mensualidades ya se cobraron (nCurrent) y cuántas faltan. Las mensualidades se cargan al INICIO de cada periodo
 * (el día siguiente al corte: Banamex y Amex lo hacen así), así que el calendario futuro es determinista y se calcula aquí
 * (puro, sin base de datos).
 */
export type PlanLike = {
  id: number;
  cardId: number;
  cardName: string;
  merchant: string;
  kind: "purchase" | "cash_advance";
  withInterest: boolean;
  originalCents: number;
  monthlyCents: number;
  pendingCents: number;
  nTotal: number;
  nCurrent: number;
  /** YYYY-MM-DD del corte del estado del que salen los datos. */
  asOf: string;
  startedOn: string;
};

const parse = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const pad = (n: number) => String(n).padStart(2, "0");

/** Suma meses a una fecha ISO; si el día no existe en el mes destino cae al último día (31-ene + 1 = 28/29-feb). */
export function addMonthsIso(iso: string, n: number): string {
  const { y, m, d } = parse(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

export const monthOf = (iso: string) => iso.slice(0, 7);

const addDaysIso = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Fecha en que se carga la mensualidad número i: la nCurrent se cargó al inicio del periodo del estado (corte + 1 día − 1 mes)
 * y cada siguiente un mes después.
 */
export function billDate(p: Pick<PlanLike, "asOf" | "nCurrent">, i: number): string {
  return addMonthsIso(addDaysIso(p.asOf, 1), i - p.nCurrent - 1);
}

/** Mensualidades ya cargadas en esta fecha (el estado de cuenta más reciente que tienes puede ser anterior a hoy). */
export function installmentsNow(p: Pick<PlanLike, "asOf" | "nCurrent" | "nTotal">, today: string): number {
  let n = p.nCurrent;
  while (n < p.nTotal && billDate(p, n + 1) <= today) n++;
  return n;
}

export type PlanView<T extends PlanLike = PlanLike> = T & {
  /** Mensualidades cobradas a hoy (estimado a partir del corte). */
  paid: number;
  remaining: number;
  pendingNow: number;
  /** Fecha del siguiente cobro, o null si ya terminó. */
  nextBillOn: string | null;
  /** Fecha del último cobro. */
  endOn: string;
  endMonth: string;
  active: boolean;
};

export function projectPlan<T extends PlanLike>(p: T, today: string): PlanView<T> {
  const paid = installmentsNow(p, today);
  const remaining = p.nTotal - paid;
  const endOn = billDate(p, p.nTotal);
  return {
    ...p,
    paid,
    remaining,
    pendingNow: Math.max(0, p.pendingCents - (paid - p.nCurrent) * p.monthlyCents),
    nextBillOn: remaining > 0 ? billDate(p, paid + 1) : null,
    endOn,
    endMonth: monthOf(endOn),
    active: remaining > 0,
  };
}

export type ScheduleRow = { month: string; total: number; byCard: Record<number, number>; past: boolean };

/**
 * Cuánto se cobra por MSI en cada mes natural: la mensualidad de cada plan en la fecha en que se carga.
 * Va desde el mes anterior al actual hasta la última mensualidad (máx. 24 meses hacia adelante).
 */
export function buildSchedule(plans: PlanLike[], today: string, ahead = 24): ScheduleRow[] {
  const cur = monthOf(today);
  const start = monthOf(addMonthsIso(`${cur}-01`, -1));
  const end = monthOf(addMonthsIso(`${cur}-01`, ahead));
  const rows = new Map<string, ScheduleRow>();
  for (let m = start; m <= end; m = monthOf(addMonthsIso(`${m}-01`, 1))) rows.set(m, { month: m, total: 0, byCard: {}, past: m < cur });
  for (const p of plans) {
    for (let idx = Math.max(p.nCurrent, 1); idx <= p.nTotal; idx++) {
      const row = rows.get(monthOf(billDate(p, idx)));
      if (!row) continue;
      row.total += p.monthlyCents;
      row.byCard[p.cardId] = (row.byCard[p.cardId] ?? 0) + p.monthlyCents;
    }
  }
  const out = [...rows.values()];
  // Se recorta la cola vacía: la gráfica termina en la última mensualidad.
  let last = out.length - 1;
  while (last > 0 && out[last].total === 0) last--;
  return out.slice(0, Math.max(last + 1, 3));
}

export type StartedRow = { month: string; count: number; cents: number };

/** Compras a MSI por mes de compra (solo planes que siguen vigentes en tus estados: los ya liquidados no aparecen). */
export function startedByMonth(plans: PlanLike[], today: string, months = 12): StartedRow[] {
  const cur = monthOf(today);
  const out: StartedRow[] = [];
  for (let i = months - 1; i >= 0; i--) out.push({ month: monthOf(addMonthsIso(`${cur}-01`, -i)), count: 0, cents: 0 });
  for (const p of plans) {
    if (p.kind !== "purchase") continue;
    const row = out.find((r) => r.month === monthOf(p.startedOn));
    if (row) {
      row.count++;
      row.cents += p.originalCents;
    }
  }
  return out;
}

export type MsiSummary<T extends PlanLike = PlanLike> = {
  income: number;
  today: string;
  plans: PlanView<T>[];
  active: PlanView<T>[];
  /** Lo que se cobra por MSI en el mes en curso. */
  loadNow: number;
  loadPct: number | null;
  /** Saldo pendiente por pagar (estimado a hoy). */
  remainingTotal: number;
  schedule: ScheduleRow[];
  started: StartedRow[];
  /** Plan que termina primero. */
  nextEnding: PlanView<T> | null;
  /** Mes en que terminas el último plan. */
  freeMonth: string | null;
  interestPending: number;
};

export function summarize<T extends PlanLike>(plans: T[], income: number, today: string): MsiSummary<T> {
  const views = plans.map((p) => projectPlan(p, today)).sort((a, b) => a.endOn.localeCompare(b.endOn) || b.monthlyCents - a.monthlyCents);
  const active = views.filter((p) => p.active);
  const schedule = buildSchedule(active, today);
  const cur = monthOf(today);
  const loadNow = schedule.find((r) => r.month === cur)?.total ?? 0;
  return {
    income,
    today,
    plans: views,
    active,
    loadNow,
    loadPct: income > 0 ? (loadNow / income) * 100 : null,
    remainingTotal: active.reduce((a, p) => a + p.pendingNow, 0),
    schedule,
    started: startedByMonth(plans, today),
    nextEnding: active[0] ?? null,
    freeMonth: active.length ? active.reduce((m, p) => (p.endMonth > m ? p.endMonth : m), active[0].endMonth) : null,
    interestPending: active.filter((p) => p.withInterest).reduce((a, p) => a + p.pendingNow, 0),
  };
}

const money = (c: number) => formatMXN(c, { compact: true });
const pct = (n: number) => `${Math.abs(n).toFixed(0)}%`;
const monthsUntil = (from: string, to: string) => (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5)) - Number(from.slice(5));

/** Frases cortas sobre tus MSI (reglas fijas, sin IA). */
export function buildMsiMessages(s: MsiSummary): InsightMessage[] {
  const out: InsightMessage[] = [];
  if (s.active.length === 0) return [{ tone: "good", text: "No tienes planes a meses vigentes. Todo lo que gastas es de contado." }];
  const cur = monthOf(s.today);

  out.push({
    tone: s.loadPct !== null && s.loadPct > 30 ? "warn" : "info",
    text: `Este mes se te cobran ${money(s.loadNow)} en ${s.active.length} plan${s.active.length === 1 ? "" : "es"} a meses${s.loadPct !== null ? ` (${pct(s.loadPct)} de tu ingreso)` : ""}. Aún debes ${money(s.remainingTotal)} en total.`,
  });

  const first = s.nextEnding;
  if (first) {
    const left = first.remaining;
    out.push({
      tone: "good",
      text: `El primero en terminar es ${first.merchant} (${first.cardName}): ${left === 1 ? "te queda 1 pago" : `te quedan ${left} pagos`}, termina en ${monthLabel(first.endMonth)} y libera ${money(first.monthlyCents)} al mes.`,
    });
  }

  // Primer mes en que la carga baja de forma notable (≥10%): cuándo "respiras".
  const future = s.schedule.filter((r) => r.month >= cur);
  for (let i = 1; i < future.length; i++) {
    const a = future[i - 1].total;
    const b = future[i].total;
    if (a > 0 && (a - b) / a >= 0.1) {
      out.push({ tone: "good", text: `En ${monthLabel(future[i].month)} tu carga de MSI baja de ${money(a)} a ${money(b)} al mes.` });
      break;
    }
  }

  if (s.freeMonth) {
    const n = monthsUntil(cur, s.freeMonth);
    out.push({ tone: "info", text: `Terminas de pagar todos tus MSI en ${monthLabel(s.freeMonth)}${n > 0 ? ` (en ${n} ${n === 1 ? "mes" : "meses"})` : ""}.` });
  }

  // Tendencia de compras a MSI (mes en curso contra el anterior, por mes de compra).
  const mCur = s.started.find((r) => r.month === cur);
  const mPrev = s.started.find((r) => r.month === monthOf(addMonthsIso(`${cur}-01`, -1)));
  if (mCur && mPrev && (mCur.cents > 0 || mPrev.cents > 0)) {
    if (mPrev.cents === 0) out.push({ tone: "warn", text: `Este mes llevas ${money(mCur.cents)} en compras nuevas a MSI; el mes pasado no hiciste ninguna.` });
    else if (mCur.cents === 0) out.push({ tone: "info", text: `Este mes no llevas compras nuevas a MSI (el mes pasado fueron ${money(mPrev.cents)}).` });
    else {
      const d = ((mCur.cents - mPrev.cents) / mPrev.cents) * 100;
      out.push({
        tone: d > 10 ? "warn" : "info",
        text: `Tus compras nuevas a MSI ${d >= 0 ? "suben" : "bajan"} ${pct(d)} contra el mes pasado (${money(mCur.cents)} vs ${money(mPrev.cents)}).`,
      });
    }
  }

  if (s.interestPending > 0) out.push({ tone: "warn", text: `Tienes ${money(s.interestPending)} en planes a meses CON intereses (disposiciones): son los más caros, conviene liquidarlos primero.` });

  // Concentración: tarjeta que carga con más de la mitad.
  const byCard = new Map<string, number>();
  for (const p of s.active) byCard.set(p.cardName, (byCard.get(p.cardName) ?? 0) + p.monthlyCents);
  const total = [...byCard.values()].reduce((a, b) => a + b, 0);
  const top = [...byCard.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && byCard.size > 1 && total > 0 && top[1] / total >= 0.5) out.push({ tone: "info", text: `${top[0]} concentra ${pct((top[1] / total) * 100)} de tu carga mensual de MSI.` });

  return out.slice(0, 7);
}
