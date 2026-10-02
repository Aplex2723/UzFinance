import { formatMXN } from "./money";
import type { InsightMessage } from "./insights";
import { monthLabel } from "./format";

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

/** Frases sobre la meta. `projectedSaving` = ingreso − gasto proyectado del mes en curso (null si el mes no es el actual). */
export function goalMessages(g: Goal, p: GoalProgress, projectedSaving: number | null): InsightMessage[] {
  if (p.done) return [{ tone: "good", text: `¡Meta lograda! Ya tienes ${money(g.savedCents)} para “${g.name}”.` }];
  const out: InsightMessage[] = [];
  const when = `${Number(g.targetDate.slice(8))} de ${monthLabel(g.targetDate.slice(0, 7)).toLowerCase()}`;
  if (p.overdue) {
    out.push({ tone: "warn", text: `La fecha de la meta (${when}) ya pasó y faltan ${money(p.remaining)}.` });
    return out;
  }
  const meses = p.monthsLeft >= 1.5 ? `${p.monthsLeft.toFixed(1)} meses` : p.monthsLeft >= 1 ? "1 mes" : `${p.daysLeft} días`;
  out.push({
    tone: p.perMonthPct !== null && p.perMonthPct > 40 ? "warn" : "info",
    text: `Faltan ${money(p.remaining)} para el ${when} (${meses}): necesitas apartar ${money(p.perMonth)} al mes${p.perMonthPct !== null ? `, ${p.perMonthPct.toFixed(0)}% de tu ingreso` : ""}.`,
  });
  if (projectedSaving !== null) {
    out.push(
      projectedSaving >= p.perMonth
        ? { tone: "good", text: `A tu ritmo de gasto este mes te sobrarían ${money(projectedSaving)}: alcanza para apartar los ${money(p.perMonth)} de la meta.` }
        : { tone: "warn", text: `A tu ritmo de gasto este mes te sobrarían ${money(Math.max(projectedSaving, 0))} y la meta pide ${money(p.perMonth)}: faltarían ${money(p.perMonth - Math.max(projectedSaving, 0))}.` },
    );
  }
  if (p.staleDays > 35) out.push({ tone: "info", text: `Tu ahorro lleva ${p.staleDays} días sin actualizarse: pon la cifra al día para que el cálculo sea exacto.` });
  return out;
}
