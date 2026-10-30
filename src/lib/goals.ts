import { formatMXN } from "./money";
import type { InsightMessage } from "./insights";
import { monthLabel } from "./format";
import { daysInMonth } from "./time";

export type Goal = { name: string; targetCents: number; targetDate: string; savedCents: number; savedAsOf: string };

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const money = (c: number) => formatMXN(c, { compact: true });

export type GoalProgress = {
  pct: number;
  remaining: number;
  daysLeft: number;
  /** Meses que faltan (fraccionario; 0 si ya pasó la fecha). */
  monthsLeft: number;
  /** Lo que hay que apartar cada mes para llegar (todo lo que falta si ya no queda tiempo). */
  perMonth: number;
  perMonthPct: number | null;
  done: boolean;
  overdue: boolean;
  staleDays: number;
};

/** Cuánto falta y cuánto hay que apartar al mes. Puro: sin base de datos. */
export function goalProgress(g: Goal, today: string, income: number): GoalProgress {
  const remaining = Math.max(0, g.targetCents - g.savedCents);
  const daysLeft = Math.round(day(g.targetDate) - day(today));
  const monthsLeft = daysLeft > 0 ? daysLeft / 30.4375 : 0;
  const perMonth = remaining === 0 ? 0 : monthsLeft > 1 ? Math.ceil(remaining / monthsLeft) : remaining;
  return {
    pct: Math.min(100, (g.savedCents / g.targetCents) * 100),
    remaining,
    daysLeft,
    monthsLeft,
    perMonth,
    perMonthPct: income > 0 ? (perMonth / income) * 100 : null,
    done: remaining === 0,
    overdue: daysLeft <= 0 && remaining > 0,
    staleDays: Math.max(0, Math.round(day(today) - day(g.savedAsOf))),
  };
}

// ── Varias metas: tipo, prioridad y predicción ─────────────────────────────────

export const GOAL_KINDS = ["casa", "auto", "viaje", "emergencia", "educacion", "otro"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const KIND_LABEL: Record<GoalKind, string> = { casa: "Casa o departamento", auto: "Auto", viaje: "Viaje", emergencia: "Fondo de emergencia", educacion: "Educación", otro: "Otra meta" };
export type GoalPriority = 1 | 2 | 3;
export const PRIORITY_LABEL: Record<GoalPriority, string> = { 1: "Alta", 2: "Normal", 3: "Baja" };
export const MAX_GOALS = 20;

/** Una meta guardada. `monthOnly`: la fecha se pidió solo como mes y se guarda como el último día de ese mes. */
export type GoalRow = Goal & { id: number; kind: GoalKind; priority: GoalPriority; monthOnly: boolean };

/** Horizonte máximo de la predicción: más allá de 10 años se considera que la meta no se alcanza. */
export const HORIZON_MONTHS = 120;
const MONTH_DAYS = 30.4375;

export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Último día de un mes "YYYY-MM". */
export const endOfMonth = (month: string) => `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;

/** "11 de abril 2027" o, si la meta es "para abril", "abril 2027". */
export function goalWhen(g: Pick<Goal, "targetDate"> & { monthOnly?: boolean }): string {
  const m = monthLabel(g.targetDate.slice(0, 7));
  return g.monthOnly ? m.toLowerCase() : `${Number(g.targetDate.slice(8))} de ${m.toLowerCase()}`;
}

/** Lo que el ingreso y el gasto reciente dejan libre cada mes. Todo en centavos. */
export type Capacity = {
  income: number;
  /** Gasto mensual típico (promedio de los últimos meses completos) y el peor/mejor de ellos. */
  avgSpend: number;
  maxSpend: number;
  minSpend: number;
  /** Meses completos que sustentan el promedio. */
  months: number;
  /** history = meses completos; current = solo hay mes en curso (proyectado); none = no hay base para predecir. */
  basis: "history" | "current" | "none";
  /** Ingreso − gasto: típico, en un mes malo y en uno bueno. Puede ser negativo. */
  surplus: number;
  surplusLow: number;
  surplusHigh: number;
};

/**
 * Capacidad de ahorro mensual. `completeMonths`: gasto de meses cerrados (viejo → reciente, sin ceros); se usan los últimos 3.
 * Sin meses cerrados se apoya en la proyección del mes en curso. Sin ingreso o sin gasto no hay base para predecir.
 */
export function capacityFrom(i: { income: number; completeMonths: number[]; currentProjected: number | null }): Capacity {
  const recent = i.completeMonths.filter((c) => Number.isFinite(c) && c > 0).slice(-3);
  const base = recent.length ? recent : i.currentProjected && i.currentProjected > 0 ? [i.currentProjected] : [];
  const none = i.income <= 0 || base.length === 0;
  const avg = base.length ? Math.round(base.reduce((a, b) => a + b, 0) / base.length) : 0;
  const max = base.length ? Math.max(...base) : 0;
  const min = base.length ? Math.min(...base) : 0;
  return {
    income: i.income, avgSpend: avg, maxSpend: max, minSpend: min, months: recent.length,
    basis: none ? "none" : recent.length ? "history" : "current",
    surplus: i.income - avg, surplusLow: i.income - max, surplusHigh: i.income - min,
  };
}

export type GoalStatus =
  | "done"        // ya juntaste todo
  | "on_track"    // llegas a tiempo, también en un mes de gasto alto
  | "tight"       // llegas a tiempo al ritmo típico, pero un mes de gasto alto te atrasa
  | "late"        // llegas después de la fecha
  | "unreachable" // con lo que te sobra no se alcanza en 10 años
  | "overdue"     // la fecha ya pasó y falta dinero
  | "no_data";    // sin ingreso o sin gastos: no se puede predecir

export type GoalPlan = {
  goal: GoalRow;
  progress: GoalProgress;
  status: GoalStatus;
  /** Lugar en la fila de financiamiento (1 = se financia primero); 0 si ya está lograda. */
  order: number;
  /** Fecha estimada en que el excedente completa la meta (después de las metas que van antes). */
  projectedDate: string | null;
  monthsLate: number;
  /** Lo que habría que apartar al mes solo para esta meta. */
  needPerMonth: number;
  /** Excedente mensual que hace falta para cumplir ESTA meta y las que van antes. */
  cumulativeNeedPerMonth: number;
  /** Cuánto falta liberar al mes (0 si ya alcanza). */
  gapPerMonth: number;
};

export type PlanSummary = {
  plans: GoalPlan[];
  /** Excedente mensual que se reparte (≥ 0). */
  surplus: number;
  /** Excedente mensual necesario para cumplir TODAS a tiempo, y lo que falta liberar. */
  neededSurplus: number;
  extraNeeded: number;
  /** extraNeeded como % del gasto mensual típico (null sin gasto). */
  cutPct: number | null;
  /** Suma de lo que cada meta pide por separado al mes. */
  totalPerMonth: number;
  counts: Record<GoalStatus, number>;
  /** Fecha estimada de la última meta pendiente (null si alguna no se alcanza). */
  lastDate: string | null;
};

/** Orden de financiamiento: prioridad (1 primero), luego la fecha más próxima. */
export const fundingOrder = (a: GoalRow, b: GoalRow) => a.priority - b.priority || a.targetDate.localeCompare(b.targetDate) || a.id - b.id;

/**
 * Predicción por "cascada": cada mes el excedente (ingreso − gasto típico) se destina a la primera meta pendiente en el orden
 * de financiamiento y, cuando se completa, a la siguiente. Una meta llega a tiempo si lo acumulado hasta ella cabe antes de su fecha.
 * Pura: sin base de datos ni reloj.
 */
export function planGoals(goals: GoalRow[], cap: Capacity, today: string): PlanSummary {
  const surplus = Math.max(0, cap.surplus);
  const counts: Record<GoalStatus, number> = { done: 0, on_track: 0, tight: 0, late: 0, unreachable: 0, overdue: 0, no_data: 0 };
  const sorted = [...goals].sort(fundingOrder);
  const withProgress = sorted.map((goal) => ({ goal, progress: goalProgress(goal, today, cap.income) }));
  const active = withProgress.filter((x) => !x.progress.done);
  const done = withProgress.filter((x) => x.progress.done);
  const usable = cap.basis !== "none";

  let cumulative = 0;
  let neededSurplus = 0;
  let lastMs = 0;
  let anyUnreachable = false;
  const plans: GoalPlan[] = [];

  active.forEach(({ goal, progress }, idx) => {
    cumulative += progress.remaining;
    // Con menos de un mes por delante se pide todo en un mes (igual que goalProgress.perMonth).
    const window = Math.max(progress.monthsLeft, 1);
    const cumulativeNeed = Math.ceil(cumulative / window);
    neededSurplus = Math.max(neededSurplus, cumulativeNeed);
    const months = usable && surplus > 0 ? cumulative / surplus : null;
    const reachable = months !== null && months <= HORIZON_MONTHS;
    const projectedDate = reachable ? addDays(today, Math.ceil(months * MONTH_DAYS)) : null;
    let status: GoalStatus;
    if (!usable) status = "no_data";
    else if (progress.overdue) status = "overdue";
    else if (!reachable) status = "unreachable";
    else if (months > progress.monthsLeft + 1e-9) status = "late";
    else {
      const low = Math.max(0, cap.surplusLow);
      status = low > 0 && cumulative / low <= progress.monthsLeft + 1e-9 ? "on_track" : "tight";
    }
    if (status === "unreachable") anyUnreachable = true;
    if (projectedDate) lastMs = Math.max(lastMs, Date.parse(`${projectedDate}T00:00:00Z`));
    counts[status]++;
    plans.push({
      goal, progress, status, order: idx + 1, projectedDate,
      monthsLate: months !== null && status === "late" ? Math.max(1, Math.ceil(months - progress.monthsLeft - 1e-9)) : 0,
      needPerMonth: progress.perMonth,
      cumulativeNeedPerMonth: cumulativeNeed,
      gapPerMonth: Math.max(0, cumulativeNeed - Math.max(0, cap.surplus)),
    });
  });
  for (const { goal, progress } of done) {
    counts.done++;
    plans.push({ goal, progress, status: "done", order: 0, projectedDate: null, monthsLate: 0, needPerMonth: 0, cumulativeNeedPerMonth: 0, gapPerMonth: 0 });
  }

  const extraNeeded = usable ? Math.max(0, neededSurplus - Math.max(0, cap.surplus)) : 0;
  return {
    plans, surplus, neededSurplus, extraNeeded,
    cutPct: usable && cap.avgSpend > 0 ? (extraNeeded / cap.avgSpend) * 100 : null,
    totalPerMonth: active.reduce((a, x) => a + x.progress.perMonth, 0),
    counts,
    lastDate: active.length && usable && !anyUnreachable && lastMs ? new Date(lastMs).toISOString().slice(0, 10) : null,
  };
}

export type Scenario = { cutPct: number; freed: number; surplus: number; onTime: number; active: number; lastDate: string | null };

/** "¿Y si recortara X% de mi gasto?": cuántas metas llegan a tiempo y cuándo termina la última. */
export function scenarios(goals: GoalRow[], cap: Capacity, today: string, cuts = [0, 10, 20]): Scenario[] {
  return cuts.map((cutPct) => {
    const freed = Math.round((cap.avgSpend * cutPct) / 100);
    const s = planGoals(goals, { ...cap, surplus: cap.surplus + freed, surplusLow: cap.surplusLow + freed, surplusHigh: cap.surplusHigh + freed }, today);
    const active = goals.length - s.counts.done;
    return { cutPct, freed, surplus: s.surplus, onTime: s.counts.on_track + s.counts.tight, active, lastDate: s.lastDate };
  });
}

const monthYear = (iso: string) => monthLabel(iso.slice(0, 7)).toLowerCase();

export type CategoryAvg = { name: string; avg: number };

/** Gastos fijos o inevitables: no se sugiere recortarlos. */
const FIXED_CATEGORY = /servicios|salud|impuestos|gobierno|comisiones|intereses|educaci|sin categor/i;
export const isFixedCategory = (name: string) => FIXED_CATEGORY.test(name);
const TRIM_PCT = 15;

/** Dónde recortar: las categorías discrecionales más grandes y cuánto liberaría quitarles 15%. */
export function trimIdeas(cats: CategoryAvg[], max = 3): { picks: CategoryAvg[]; pct: number; freed: number } | null {
  const picks = cats.filter((c) => c.avg > 0 && !isFixedCategory(c.name)).sort((a, b) => b.avg - a.avg).slice(0, max);
  if (!picks.length) return null;
  return { picks, pct: TRIM_PCT, freed: Math.round(picks.reduce((a, c) => a + c.avg, 0) * (TRIM_PCT / 100)) };
}

/** Frases deterministas (sin IA) sobre la capacidad de ahorro y cada meta. */
export function planMessages(s: PlanSummary, cap: Capacity, cats: CategoryAvg[] = []): InsightMessage[] {
  const out: InsightMessage[] = [];
  if (!s.plans.length) return out;
  if (cap.basis === "none") {
    return [{ tone: "info", text: cap.income <= 0 ? "Configura tu ingreso mensual para predecir si alcanzas tus metas." : "Aún no hay gastos registrados para estimar cuánto te sobra al mes." }];
  }
  const since = cap.basis === "history" ? `promedio de ${cap.months === 1 ? "tu último mes" : `tus últimos ${cap.months} meses`}` : "proyección del mes en curso";
  out.push({
    tone: cap.surplus > 0 ? "info" : "warn",
    text: cap.surplus > 0
      ? `Te sobran unos ${money(cap.surplus)} al mes (ingreso ${money(cap.income)} − gasto típico ${money(cap.avgSpend)}, ${since}).`
      : `Con tu gasto típico (${money(cap.avgSpend)}, ${since}) no te sobra nada al mes frente a tu ingreso de ${money(cap.income)}: ninguna meta avanza.`,
  });
  const pending = s.plans.filter((p) => p.status !== "done");
  if (pending.length) {
    const ok = s.counts.on_track + s.counts.tight;
    out.push({
      tone: ok === pending.length ? "good" : "warn",
      text: ok === pending.length ? `A este ritmo alcanzas a tiempo ${pending.length === 1 ? "tu meta" : `las ${pending.length} metas`}.` : `A este ritmo alcanzas a tiempo ${ok} de ${pending.length} metas pendientes.`,
    });
  }
  for (const p of s.plans) {
    const n = `“${p.goal.name}”`;
    const when = goalWhen(p.goal);
    switch (p.status) {
      case "done": out.push({ tone: "good", text: `${n}: ¡meta lograda! Ya tienes ${money(p.goal.savedCents)}.` }); break;
      case "on_track": out.push({ tone: "good", text: `${n}: vas a tiempo para el ${when}; la completarías hacia ${monthYear(p.projectedDate!)}.` }); break;
      case "tight": out.push({ tone: "info", text: `${n}: llegas a tiempo para el ${when} al ritmo típico, pero un mes de gasto alto te atrasaría; apartar ${money(p.needPerMonth)} al mes te da holgura.` }); break;
      case "late": out.push({ tone: "warn", text: `${n}: con tu excedente la completarías hacia ${monthYear(p.projectedDate!)}, ~${p.monthsLate} ${p.monthsLate === 1 ? "mes" : "meses"} después del ${when}; para llegar a tiempo faltan ${money(p.gapPerMonth)} al mes por liberar.` }); break;
      case "unreachable": out.push({ tone: "warn", text: `${n}: con lo que te sobra hoy no se alcanza en 10 años; pide ${money(p.needPerMonth)} al mes. Conviene bajar el monto, mover la fecha o liberar gasto.` }); break;
      case "overdue": out.push({ tone: "warn", text: `${n}: la fecha (${when}) ya pasó y faltan ${money(p.progress.remaining)}${p.projectedDate ? `; al ritmo actual llegarías hacia ${monthYear(p.projectedDate)}` : ""}. Ajusta la fecha.` }); break;
      case "no_data": break;
    }
    if (p.progress.staleDays > 35 && p.status !== "done") out.push({ tone: "info", text: `${n}: tu ahorro lleva ${p.progress.staleDays} días sin actualizarse; ponlo al día para que la predicción sea exacta.` });
  }
  if (s.extraNeeded > 0) {
    out.push({ tone: "warn", text: `Para cumplir todas a tiempo necesitas liberar ${money(s.extraNeeded)} más al mes${s.cutPct !== null ? ` (${s.cutPct.toFixed(0)}% de tu gasto típico)` : ""}.` });
    const idea = trimIdeas(cats);
    if (idea) out.push({ tone: "info", text: `Una idea: recortar ${idea.pct}% en ${idea.picks.map((c) => `${c.name} (${money(c.avg)} al mes)`).join(", ")} liberaría unos ${money(idea.freed)} al mes${idea.freed >= s.extraNeeded ? ", suficiente para cubrir la diferencia" : ""}.` });
  }
  return out;
}
