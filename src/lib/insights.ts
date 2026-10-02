import { monthLabel } from "./format";
import { formatMXN } from "./money";
import { prevMonth } from "./time";

export type Tone = "good" | "warn" | "info";
export type InsightMessage = { tone: Tone; text: string };

export type InsightInput = {
  month: string;
  isCurrent: boolean;
  income: number;
  spent: number;
  prevSamePeriod: number;
  elapsedDays: number;
  daysInMonth: number;
  projected: number;
  avgPerDay: number;
  prevAvgPerDay: number;
  topDay: { date: string; cents: number } | null;
  topWeekday: { name: string; cents: number } | null;
  categoryDeltas: { name: string; cents: number; prevCents: number }[];
};

const pct = (n: number) => `${Math.abs(n).toFixed(0)}%`;
const shortMoney = (c: number) => formatMXN(c, { compact: true });

/** Frases cortas y accionables a partir de las cifras del mes (sin IA: reglas fijas). */
export function buildInsights(i: InsightInput): InsightMessage[] {
  const out: InsightMessage[] = [];
  const prev = monthLabel(prevMonth(i.month)).split(" ")[0].toLowerCase();

  if (i.income > 0 && i.spent > 0) {
    const used = (i.spent / i.income) * 100;
    const elapsed = (i.elapsedDays / i.daysInMonth) * 100;
    if (i.isCurrent) {
      out.push({
        tone: used > elapsed + 5 ? "warn" : "good",
        text: `Llevas ${pct(used)} de tu ingreso gastado y va ${pct(elapsed)} del mes${used > elapsed + 5 ? ": vas más rápido que el calendario" : ": vas dentro del ritmo"}.`,
      });
      const proj = (i.projected / i.income) * 100;
      out.push({
        tone: i.projected > i.income ? "warn" : "info",
        text: i.projected > i.income
          ? `A este ritmo cerrarás en ${shortMoney(i.projected)} (${pct(proj)} del ingreso): superarías tu ingreso por ${shortMoney(i.projected - i.income)}.`
          : `A este ritmo cerrarás en ${shortMoney(i.projected)} (${pct(proj)} del ingreso) y ahorrarías ${shortMoney(i.income - i.projected)}.`,
      });
    } else {
      const saved = i.income - i.spent;
      out.push({
        tone: saved >= 0 ? "good" : "warn",
        text: saved >= 0 ? `Gastaste ${pct(used)} de tu ingreso y ahorraste ${shortMoney(saved)} (${pct((saved / i.income) * 100)}).` : `Gastaste ${shortMoney(-saved)} más de lo que ingresó.`,
      });
    }
  }

  if (i.prevSamePeriod > 0 && i.spent > 0) {
    const d = ((i.spent - i.prevSamePeriod) / i.prevSamePeriod) * 100;
    if (Math.abs(d) >= 3) {
      out.push({ tone: d > 0 ? "warn" : "good", text: `Gastas ${pct(d)} ${d > 0 ? "más" : "menos"} que en el mismo periodo de ${prev} (${shortMoney(Math.abs(i.spent - i.prevSamePeriod))} ${d > 0 ? "de diferencia" : "menos"}).` });
    } else out.push({ tone: "info", text: `Tu gasto va casi igual que en ${prev} (${d >= 0 ? "+" : "−"}${pct(d)}).` });
  }

  if (i.prevAvgPerDay > 0 && i.avgPerDay > 0) {
    const d = ((i.avgPerDay - i.prevAvgPerDay) / i.prevAvgPerDay) * 100;
    if (Math.abs(d) >= 5) out.push({ tone: d > 0 ? "warn" : "good", text: `Tu gasto diario promedio (${shortMoney(i.avgPerDay)}) está ${pct(d)} ${d > 0 ? "arriba" : "abajo"} del de ${prev} (${shortMoney(i.prevAvgPerDay)}).` });
  }

  const growth = i.categoryDeltas
    .filter((c) => c.prevCents > 0 && c.cents - c.prevCents > 0)
    .map((c) => ({ ...c, diff: c.cents - c.prevCents, pct: ((c.cents - c.prevCents) / c.prevCents) * 100 }))
    .sort((a, b) => b.diff - a.diff)[0];
  if (growth && growth.diff >= 50_00) out.push({ tone: "warn", text: `${growth.name} es lo que más subió: +${shortMoney(growth.diff)} (+${pct(growth.pct)}) contra ${prev}.` });
  const drop = i.categoryDeltas
    .filter((c) => c.prevCents > c.cents)
    .map((c) => ({ ...c, diff: c.prevCents - c.cents }))
    .sort((a, b) => b.diff - a.diff)[0];
  if (drop && drop.diff >= 50_00) out.push({ tone: "good", text: `${drop.name} bajó ${shortMoney(drop.diff)} contra ${prev}.` });

  if (i.topWeekday && i.topWeekday.cents > 0) out.push({ tone: "info", text: `Tu día más caro de la semana es el ${i.topWeekday.name} (${shortMoney(i.topWeekday.cents)} en el mes).` });
  if (i.topDay && i.topDay.cents > 0) out.push({ tone: "info", text: `Tu día de mayor gasto fue el ${Number(i.topDay.date.slice(8))}: ${shortMoney(i.topDay.cents)}.` });

  return out.slice(0, 6);
}
