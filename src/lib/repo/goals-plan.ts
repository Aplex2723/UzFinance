import { query, t } from "@/lib/db/pool";
import { shiftMonth } from "@/lib/format";
import { capacityFrom, planGoals, scenarios, type Capacity, type CategoryAvg, type GoalRow, type PlanSummary, type Scenario } from "@/lib/goals";
import { currentMonth, daysInMonth, localDate } from "@/lib/time";
import { listGoals } from "./goals";
import { getMonthlyIncome } from "./settings";

const N = (v: unknown) => Number(v ?? 0);

export type GoalsOverview = {
  today: string;
  goals: GoalRow[];
  capacity: Capacity;
  summary: PlanSummary;
  scenarios: Scenario[];
  /** Gasto mensual promedio por categoría en los meses usados (de mayor a menor). */
  categories: CategoryAvg[];
  /** Meses de gasto del historial usados (para explicar de dónde sale la predicción). */
  monthsUsed: string[];
};

/**
 * Metas + predicción. El gasto "típico" es el promedio de los últimos 3 meses cerrados con gasto; si el primer mes con datos
 * empezó ya avanzado (el registro arrancó a mitad de mes) se descarta por incompleto.
 */
export async function getGoalsOverview(now = new Date()): Promise<GoalsOverview> {
  const today = localDate(now);
  const month = currentMonth(now);
  const [goals, income, hist, first] = await Promise.all([
    listGoals(),
    getMonthlyIncome(),
    query<{ m: string; cents: number }>(
      `SELECT FORMAT(occurred_date,'yyyy-MM') AS m, CAST(SUM(amount_cents) AS float) AS cents
       FROM dbo.transactions WHERE kind='expense' AND occurred_date BETWEEN @from AND @to GROUP BY FORMAT(occurred_date,'yyyy-MM')`,
      { from: t.date(`${shiftMonth(month, -6)}-01`), to: t.date(today) },
    ),
    query<{ d: string | null }>("SELECT CONVERT(char(10), MIN(occurred_date), 23) AS d FROM dbo.transactions WHERE kind='expense'"),
  ]);

  const firstDate = first[0]?.d ?? null;
  const partialMonth = firstDate && Number(firstDate.slice(8)) > 7 ? firstDate.slice(0, 7) : null;
  const byMonth = new Map(hist.map((r) => [r.m, N(r.cents)]));
  const closed = [...byMonth.keys()].filter((m) => m < month && m !== partialMonth && N(byMonth.get(m)) > 0).sort();
  const used = closed.slice(-3);

  const elapsed = Number(today.slice(8));
  const cur = N(byMonth.get(month));
  const currentProjected = elapsed >= 7 && cur > 0 ? Math.round((cur / elapsed) * daysInMonth(month)) : null;
  const capacity = capacityFrom({ income, completeMonths: used.map((m) => N(byMonth.get(m))), currentProjected });

  let categories: CategoryAvg[] = [];
  if (used.length) {
    const rows = await query<{ name: string | null; cents: number }>(
      `SELECT k.name, CAST(SUM(x.amount_cents) AS float) AS cents
       FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
       WHERE x.kind='expense' AND FORMAT(x.occurred_date,'yyyy-MM') IN (${used.map((_, i) => `@m${i}`).join(",")})
       GROUP BY k.name HAVING SUM(x.amount_cents) > 0`,
      Object.fromEntries(used.map((m, i) => [`m${i}`, t.str(m)])),
    );
    categories = rows
      .map((r) => ({ name: r.name ?? "Sin categoría", avg: Math.round(N(r.cents) / used.length) }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 8);
  }

  return { today, goals, capacity, summary: planGoals(goals, capacity, today), scenarios: scenarios(goals, capacity, today), categories, monthsUsed: used };
}
