import { query, t } from "@/lib/db/pool";
import { buildInsights, type InsightMessage } from "@/lib/insights";
import { currentMonth, daysInMonth, prevMonth } from "@/lib/time";
import { shiftMonth } from "@/lib/format";
import { getMonthlyIncome } from "./settings";
import { cutoffDay, dailyTotals, getWeekdayTotals } from "./stats";

const N = (v: unknown) => Number(v ?? 0);
const day = (m: string, d: number) => `${m}-${String(d).padStart(2, "0")}`;
export const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

export type HistoryRow = { month: string; spent: number; income: number; saved: number; savedPct: number | null; usedPct: number | null; avgPerDay: number; days: number; deltaPct: number | null };

export type Insights = {
  month: string;
  isCurrent: boolean;
  income: number;
  spent: number;
  saved: number;
  usedPct: number | null;
  savedPct: number | null;
  elapsedDays: number;
  daysInMonth: number;
  remainingDays: number;
  avgPerDay: number;
  prevAvgPerDay: number;
  projected: number;
  projectedPct: number | null;
  dailyAllowance: number | null;
  noSpendDays: number;
  avgTicket: number;
  count: number;
  topDay: { date: string; cents: number } | null;
  history: HistoryRow[];
  categoryDeltas: { name: string; color: string; cents: number; prevCents: number }[];
  topMerchants: { merchant: string; cents: number; count: number }[];
  messages: InsightMessage[];
};

/** Cifras del mes contra el ingreso mensual y contra meses anteriores. El ingreso es uno solo (el vigente) para todos los meses. */
export async function getInsights(month: string, now = new Date()): Promise<Insights> {
  const isCurrent = month === currentMonth(now);
  const cut = cutoffDay(month, now);
  const dim = daysInMonth(month);
  const prev = prevMonth(month);
  const prevCut = Math.min(cut, daysInMonth(prev));
  const firstHistory = shiftMonth(month, -11);

  const [income, daily, prevDaily, hist, purchases, cats, merchants, weekday] = await Promise.all([
    getMonthlyIncome(),
    dailyTotals(day(month, 1), day(month, cut)),
    dailyTotals(day(prev, 1), day(prev, prevCut)),
    query<{ m: string; cents: number; n: number }>(
      `SELECT FORMAT(occurred_date,'yyyy-MM') AS m, CAST(SUM(amount_cents) AS float) AS cents, COUNT(*) AS n
       FROM dbo.transactions WHERE kind='expense' AND occurred_date BETWEEN @from AND @to GROUP BY FORMAT(occurred_date,'yyyy-MM')`,
      { from: t.date(day(firstHistory, 1)), to: t.date(day(month, dim)) },
    ),
    query<{ n: number; cents: number }>(
      `SELECT COUNT(*) AS n, CAST(ISNULL(SUM(amount_cents), 0) AS float) AS cents
       FROM dbo.transactions WHERE kind='expense' AND amount_cents > 0 AND occurred_date BETWEEN @from AND @to`,
      { from: t.date(day(month, 1)), to: t.date(day(month, cut)) },
    ),
    query<{ name: string | null; color: string | null; cur: number; prv: number }>(
      `SELECT k.name, k.color,
         CAST(ISNULL(SUM(CASE WHEN x.occurred_date BETWEEN @cf AND @ct THEN x.amount_cents END),0) AS float) AS cur,
         CAST(ISNULL(SUM(CASE WHEN x.occurred_date BETWEEN @pf AND @pt THEN x.amount_cents END),0) AS float) AS prv
       FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
       WHERE x.kind='expense' AND x.occurred_date BETWEEN @pf AND @ct GROUP BY k.name, k.color`,
      { cf: t.date(day(month, 1)), ct: t.date(day(month, cut)), pf: t.date(day(prev, 1)), pt: t.date(day(prev, prevCut)) },
    ),
    query<{ merchant: string; cents: number; n: number }>(
      `SELECT TOP 6 merchant_normalized AS merchant, CAST(SUM(amount_cents) AS float) AS cents, COUNT(*) AS n
       FROM dbo.transactions WHERE kind='expense' AND occurred_date BETWEEN @from AND @to
       GROUP BY merchant_normalized HAVING SUM(amount_cents) > 0 ORDER BY SUM(amount_cents) DESC`,
      { from: t.date(day(month, 1)), to: t.date(day(month, cut)) },
    ),
    getWeekdayTotals(month),
  ]);

  const spent = [...daily.values()].reduce((a, b) => a + b, 0);
  const prevSamePeriod = [...prevDaily.values()].reduce((a, b) => a + b, 0);
  const histMap = new Map(hist.map((r) => [r.m, r]));
  // Compras = cargos positivos hasta hoy (los reembolsos no cuentan como compra).
  const count = N(purchases[0]?.n);
  const purchasesTotal = N(purchases[0]?.cents);
  const avgPerDay = cut > 0 ? spent / cut : 0;
  const projected = isCurrent ? Math.round(avgPerDay * dim) : spent;
  const prevFull = N(histMap.get(prev)?.cents);
  const prevAvgPerDay = prevFull / daysInMonth(prev);
  const remainingDays = isCurrent ? dim - cut : 0;

  const history: HistoryRow[] = [];
  for (let k = 11; k >= 0; k--) {
    const m = shiftMonth(month, -k);
    const days = m === month ? cut : daysInMonth(m);
    const s = m === month ? spent : N(histMap.get(m)?.cents);
    const before = history[history.length - 1];
    const saved = income - s;
    history.push({
      month: m, spent: s, income, saved,
      savedPct: income > 0 ? (saved / income) * 100 : null,
      usedPct: income > 0 ? (s / income) * 100 : null,
      avgPerDay: days > 0 ? s / days : 0, days,
      deltaPct: before && before.spent > 0 ? ((s - before.spent) / before.spent) * 100 : null,
    });
  }

  const dayEntries = [...daily.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const topDay = dayEntries[0] ? { date: dayEntries[0][0], cents: dayEntries[0][1] } : null;
  const noSpendDays = Array.from({ length: cut }, (_, i) => day(month, i + 1)).filter((d) => !((daily.get(d) ?? 0) > 0)).length;

  const categoryDeltas = cats
    .map((r) => ({ name: r.name ?? "Sin categoría", color: r.color ?? "#6b7280", cents: N(r.cur), prevCents: N(r.prv) }))
    .filter((r) => r.cents !== 0 || r.prevCents !== 0)
    .sort((a, b) => Math.max(b.cents, b.prevCents) - Math.max(a.cents, a.prevCents));

  const wdMax = weekday.reduce((best, c, i) => (c > weekday[best] ? i : best), 0);
  const topWeekday = weekday[wdMax] > 0 ? { name: WEEKDAYS[wdMax], cents: weekday[wdMax] } : null;

  const messages = buildInsights({
    month, isCurrent, income, spent, prevSamePeriod, elapsedDays: cut, daysInMonth: dim, projected,
    avgPerDay, prevAvgPerDay, topDay, topWeekday, categoryDeltas,
  });

  return {
    month, isCurrent, income, spent, saved: income - spent,
    usedPct: income > 0 ? (spent / income) * 100 : null,
    savedPct: income > 0 ? ((income - spent) / income) * 100 : null,
    elapsedDays: cut, daysInMonth: dim, remainingDays, avgPerDay, prevAvgPerDay, projected,
    projectedPct: income > 0 ? (projected / income) * 100 : null,
    dailyAllowance: isCurrent && income > 0 && remainingDays > 0 ? Math.max(0, Math.round((income - spent) / remainingDays)) : null,
    noSpendDays,
    avgTicket: count > 0 ? Math.round(purchasesTotal / count) : 0,
    count, topDay, history, categoryDeltas, topMerchants: merchants.map((r) => ({ merchant: r.merchant, cents: N(r.cents), count: N(r.n) })), messages,
  };
}
