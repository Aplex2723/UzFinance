import { query, t } from "@/lib/db/pool";
import { currentMonth, daysInMonth, localDate, prevMonth } from "@/lib/time";
import type { Issuer } from "@/lib/types";

const N = (v: unknown) => Number(v ?? 0);

/** Día hasta el que se compara: hoy si es el mes en curso; si no, todo el mes. */
export function cutoffDay(month: string, now = new Date()): number {
  return month === currentMonth(now) ? Number(localDate(now).slice(8, 10)) : daysInMonth(month);
}

async function dailyTotals(from: string, to: string, cardId?: number): Promise<Map<string, number>> {
  const rows = await query<{ d: string; cents: number }>(
    `SELECT CONVERT(char(10), occurred_date, 23) AS d, CAST(SUM(amount_cents) AS float) AS cents
     FROM dbo.transactions WHERE kind = 'expense' AND occurred_date BETWEEN @from AND @to ${cardId ? "AND card_id=@card" : ""}
     GROUP BY occurred_date`,
    { from: t.date(from), to: t.date(to), ...(cardId ? { card: t.int(cardId) } : {}) },
  );
  return new Map(rows.map((r) => [r.d, N(r.cents)]));
}

const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;

export async function getOverview(month: string, now = new Date()) {
  const cut = cutoffDay(month, now);
  const prev = prevMonth(month);
  const prevCut = Math.min(cut, daysInMonth(prev));
  const sumQ = (m: string, c: number) =>
    query<{ issuer: Issuer; cents: number; n: number }>(
      `SELECT c.issuer, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
       FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id
       WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to GROUP BY c.issuer`,
      { from: t.date(day(m, 1)), to: t.date(day(m, c)) },
    );
  const [cur, prv] = await Promise.all([sumQ(month, cut), sumQ(prev, prevCut)]);
  const total = cur.reduce((a, r) => a + N(r.cents), 0);
  const prevTotal = prv.reduce((a, r) => a + N(r.cents), 0);
  return {
    month,
    total,
    prevTotal,
    deltaPct: prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null,
    count: cur.reduce((a, r) => a + N(r.n), 0),
    byIssuer: (["amex", "banamex", "nu", "other"] as Issuer[]).map((issuer) => ({
      issuer,
      cents: N(cur.find((r) => r.issuer === issuer)?.cents),
      prevCents: N(prv.find((r) => r.issuer === issuer)?.cents),
    })),
  };
}

export async function getCardSummaries(month: string, now = new Date()) {
  const cut = cutoffDay(month, now);
  const prev = prevMonth(month);
  const prevCut = Math.min(cut, daysInMonth(prev));
  const rows = await query<{ id: number; name: string; issuer: Issuer; last4: string | null; color: string; cur: number; prv: number }>(
    `SELECT c.id, c.name, c.issuer, c.last4, c.color,
       CAST(ISNULL(SUM(CASE WHEN x.occurred_date BETWEEN @cf AND @ct THEN x.amount_cents END), 0) AS float) AS cur,
       CAST(ISNULL(SUM(CASE WHEN x.occurred_date BETWEEN @pf AND @pt THEN x.amount_cents END), 0) AS float) AS prv
     FROM dbo.cards c LEFT JOIN dbo.transactions x ON x.card_id = c.id AND x.kind = 'expense'
     WHERE c.active = 1 GROUP BY c.id, c.name, c.issuer, c.last4, c.color ORDER BY c.issuer, c.name`,
    { cf: t.date(day(month, 1)), ct: t.date(day(month, cut)), pf: t.date(day(prev, 1)), pt: t.date(day(prev, prevCut)) },
  );
  return Promise.all(
    rows.map(async (r) => {
      const daily = await dailyTotals(day(month, 1), day(month, cut), r.id);
      const spark = Array.from({ length: cut }, (_, i) => daily.get(day(month, i + 1)) ?? 0);
      return {
        id: r.id, name: r.name, issuer: r.issuer, last4: r.last4, color: r.color,
        cents: N(r.cur), prevCents: N(r.prv),
        deltaPct: N(r.prv) > 0 ? ((N(r.cur) - N(r.prv)) / N(r.prv)) * 100 : null,
        spark,
      };
    }),
  );
}

/** Gasto acumulado por día: mes seleccionado vs. mes anterior. */
export async function getCumulative(month: string, now = new Date()) {
  const cut = cutoffDay(month, now);
  const prev = prevMonth(month);
  const len = Math.max(daysInMonth(month), daysInMonth(prev));
  const [cur, prv] = await Promise.all([
    dailyTotals(day(month, 1), day(month, daysInMonth(month))),
    dailyTotals(day(prev, 1), day(prev, daysInMonth(prev))),
  ]);
  let a = 0;
  let b = 0;
  const points: { day: number; current: number | null; previous: number | null }[] = [];
  for (let d = 1; d <= len; d++) {
    if (d <= daysInMonth(prev)) b += prv.get(day(prev, d)) ?? 0;
    if (d <= daysInMonth(month) && d <= cut) a += cur.get(day(month, d)) ?? 0;
    points.push({
      day: d,
      current: d <= daysInMonth(month) && d <= cut ? a : null,
      previous: d <= daysInMonth(prev) ? b : null,
    });
  }
  return { points, cutoff: cut };
}

/** Lunes=0 … Domingo=6, independiente de DATEFIRST (1-ene-1900 fue lunes). */
export async function getWeekdayTotals(month: string) {
  const rows = await query<{ wd: number; cents: number }>(
    `SELECT DATEDIFF(day, '19000101', occurred_date) % 7 AS wd, CAST(SUM(amount_cents) AS float) AS cents
     FROM dbo.transactions WHERE kind = 'expense' AND occurred_date BETWEEN @from AND @to GROUP BY DATEDIFF(day, '19000101', occurred_date) % 7`,
    { from: t.date(day(month, 1)), to: t.date(day(month, daysInMonth(month))) },
  );
  return Array.from({ length: 7 }, (_, i) => N(rows.find((r) => N(r.wd) === i)?.cents));
}

export async function getSankey(month: string) {
  const rows = await query<{ card: string; category: string | null; color: string | null; cents: number }>(
    `SELECT c.name AS card, k.name AS category, k.color, CAST(SUM(x.amount_cents) AS float) AS cents
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id LEFT JOIN dbo.categories k ON k.id = x.category_id
     WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to GROUP BY c.name, k.name, k.color HAVING SUM(x.amount_cents) > 0`,
    { from: t.date(day(month, 1)), to: t.date(day(month, daysInMonth(month))) },
  );
  return rows.map((r) => ({ card: r.card, category: r.category ?? "Sin categoría", color: r.color ?? "#6b7280", cents: N(r.cents) }));
}

export async function getHeatmap(weeks = 12, now = new Date()) {
  const today = localDate(now);
  const end = new Date(`${today}T00:00:00Z`);
  // Alinear a semanas lunes-domingo: la última columna termina en el domingo de esta semana.
  const dow = (end.getUTCDay() + 6) % 7;
  const lastSunday = new Date(end.getTime() + (6 - dow) * 86400000);
  const start = new Date(lastSunday.getTime() - (weeks * 7 - 1) * 86400000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const totals = await dailyTotals(iso(start), iso(lastSunday));
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const date = iso(new Date(start.getTime() + i * 86400000));
    return { date, cents: totals.get(date) ?? 0, future: date > today };
  });
  return { cells, weeks };
}

export async function getCategoryBreakdown(month: string) {
  const rows = await query<{ name: string | null; color: string | null; cents: number; n: number }>(
    `SELECT k.name, k.color, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
     FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
     WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to GROUP BY k.name, k.color ORDER BY SUM(x.amount_cents) DESC`,
    { from: t.date(day(month, 1)), to: t.date(day(month, daysInMonth(month))) },
  );
  return rows.map((r) => ({ name: r.name ?? "Sin categoría", color: r.color ?? "#6b7280", cents: N(r.cents), count: N(r.n) }));
}

export async function getMonthlyTrend(months = 12, now = new Date()) {
  const rows = await query<{ m: string; cents: number }>(
    `SELECT FORMAT(occurred_date, 'yyyy-MM') AS m, CAST(SUM(amount_cents) AS float) AS cents
     FROM dbo.transactions WHERE kind = 'expense' AND occurred_date >= DATEADD(month, -@n, DATEFROMPARTS(YEAR(@today), MONTH(@today), 1))
     GROUP BY FORMAT(occurred_date, 'yyyy-MM') ORDER BY m`,
    { n: t.int(months - 1), today: t.date(localDate(now)) },
  );
  return rows.map((r) => ({ month: r.m, cents: N(r.cents) }));
}

/** Comercios que aparecen en ≥3 de los últimos 6 meses, con monto parecido. */
export async function getRecurring(now = new Date()) {
  const rows = await query<{ merchant: string; card: string; months: number; avg: number; last: string; last_amount: number; mn: number; mx: number }>(
    `WITH x AS (
       SELECT merchant_normalized AS merchant, card_id, FORMAT(occurred_date,'yyyy-MM') AS m, amount_cents, occurred_date
       FROM dbo.transactions WHERE kind = 'expense' AND amount_cents > 0 AND occurred_date >= DATEADD(month, -5, DATEFROMPARTS(YEAR(@today), MONTH(@today), 1))
     )
     SELECT x.merchant, c.name AS card, COUNT(DISTINCT x.m) AS months, CAST(AVG(CAST(x.amount_cents AS float)) AS float) AS avg,
            CONVERT(char(10), MAX(x.occurred_date), 23) AS last, CAST(MIN(x.amount_cents) AS float) AS mn, CAST(MAX(x.amount_cents) AS float) AS mx,
            CAST((SELECT TOP 1 y.amount_cents FROM x y WHERE y.merchant = x.merchant AND y.card_id = x.card_id ORDER BY y.occurred_date DESC) AS float) AS last_amount
     FROM x JOIN dbo.cards c ON c.id = x.card_id
     GROUP BY x.merchant, x.card_id, c.name HAVING COUNT(DISTINCT x.m) >= 3 ORDER BY AVG(CAST(x.amount_cents AS float)) DESC`,
    { today: t.date(localDate(now)) },
  );
  // Monto "parecido": variación ≤ 25% respecto al promedio.
  return rows
    .filter((r) => N(r.avg) > 0 && (N(r.mx) - N(r.mn)) / N(r.avg) <= 0.25)
    .map((r) => ({ merchant: r.merchant, card: r.card, months: N(r.months), avgCents: N(r.avg), last: r.last, lastCents: N(r.last_amount) }));
}
