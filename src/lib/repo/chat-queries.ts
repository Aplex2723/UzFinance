import { query, t } from "@/lib/db/pool";

/**
 * Consultas de solo lectura que alimentan las herramientas de UzChat (src/lib/chat/tools.ts). Todas agregan en la base por un rango
 * de fechas (YYYY-MM-DD, ambos extremos incluidos), solo sobre gastos (`kind='expense'`, igual que el resto de la app: los pagos de
 * tarjeta no cuentan) y con montos en centavos; los reembolsos (negativos) restan.
 */
const N = (v: unknown) => Number(v ?? 0);
const range = (from: string, to: string) => ({ from: t.date(from), to: t.date(to) });

export type CategoryTotal = { id: number | null; name: string; cents: number; count: number };

export async function categoryTotals(from: string, to: string): Promise<CategoryTotal[]> {
  const rows = await query<{ id: number | null; name: string | null; cents: number; n: number }>(
    `SELECT k.id, k.name, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
     FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
     WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to
     GROUP BY k.id, k.name ORDER BY SUM(x.amount_cents) DESC`,
    range(from, to),
  );
  return rows.map((r) => ({ id: r.id === null ? null : Number(r.id), name: r.name ?? "Sin categoría", cents: N(r.cents), count: N(r.n) }));
}

export type CardTotal = { id: number; name: string; issuer: string; cents: number; count: number };

export async function cardTotals(from: string, to: string): Promise<CardTotal[]> {
  const rows = await query<{ id: number; name: string; issuer: string; cents: number; n: number }>(
    `SELECT c.id, c.name, c.issuer, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id
     WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to
     GROUP BY c.id, c.name, c.issuer ORDER BY SUM(x.amount_cents) DESC`,
    range(from, to),
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, issuer: r.issuer, cents: N(r.cents), count: N(r.n) }));
}

export type MerchantTotal = { merchant: string; category: string | null; cents: number; count: number };

/** Comercios con más gasto en el rango (opcionalmente solo de una categoría; "none" = sin categoría). Solo los de saldo positivo. */
export async function merchantTotals(from: string, to: string, opts: { categoryId?: number | "none"; limit: number }): Promise<MerchantTotal[]> {
  const cat = opts.categoryId === "none" ? "AND x.category_id IS NULL" : opts.categoryId ? "AND x.category_id = @cat" : "";
  const rows = await query<{ merchant: string; category: string | null; cents: number; n: number }>(
    `SELECT TOP (@lim) MIN(x.merchant_raw) AS merchant, MAX(k.name) AS category, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
     FROM dbo.transactions x LEFT JOIN dbo.categories k ON k.id = x.category_id
     WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to ${cat}
     GROUP BY x.merchant_normalized HAVING SUM(x.amount_cents) > 0 ORDER BY SUM(x.amount_cents) DESC, x.merchant_normalized`,
    { ...range(from, to), lim: t.int(opts.limit), ...(typeof opts.categoryId === "number" ? { cat: t.int(opts.categoryId) } : {}) },
  );
  return rows.map((r) => ({ merchant: r.merchant, category: r.category, cents: N(r.cents), count: N(r.n) }));
}

export type Grain = "day" | "week" | "month";
export type SeriesPoint = { period: string; cents: number; count: number };

/** Gasto por día, por semana (la clave es el lunes) o por mes ("YYYY-MM"). Solo periodos con movimientos. */
export async function seriesTotals(from: string, to: string, grain: Grain): Promise<SeriesPoint[]> {
  // Expresión fija elegida de una lista: nunca texto del usuario.
  const key =
    grain === "day" ? "CONVERT(char(10), x.occurred_date, 23)"
    : grain === "week" ? "CONVERT(char(10), DATEADD(day, -(DATEDIFF(day, '19000101', x.occurred_date) % 7), x.occurred_date), 23)"
    : "FORMAT(x.occurred_date, 'yyyy-MM')";
  const rows = await query<{ p: string; cents: number; n: number }>(
    `SELECT ${key} AS p, CAST(SUM(x.amount_cents) AS float) AS cents, COUNT(*) AS n
     FROM dbo.transactions x WHERE x.kind = 'expense' AND x.occurred_date BETWEEN @from AND @to
     GROUP BY ${key} ORDER BY ${key}`,
    range(from, to),
  );
  return rows.map((r) => ({ period: r.p, cents: N(r.cents), count: N(r.n) }));
}
