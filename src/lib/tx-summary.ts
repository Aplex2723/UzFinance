/**
 * Cálculos PUROS de las tarjetitas de resumen de Transacciones: periodo equivalente anterior, deltas y porcentajes con manejo de
 * cero (nunca NaN ni Infinity), participación por tarjeta/categoría y comparación contra el promedio diario.
 * La consulta a la base vive en `getTransactionSummary` (repo/transactions.ts); aquí no hay E/S.
 */
import type { CardArtId, Issuer } from "./types";
import { addDays, effectiveRange, lastDayOfMonth, rangeDays, weekdayIndex } from "./tx-filters";
import { prevMonth } from "./time";

/** (actual − anterior) / anterior × 100. Sin base (anterior ≤ 0 o no finito) → null, nunca Infinity/NaN. */
export function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) return null;
  const p = ((current - previous) / previous) * 100;
  return Number.isFinite(p) ? p : null;
}

export type Comparison = { pct: number | null; diffCents: number; trend: "up" | "down" | "same" };

/** Compara dos totales. `previous` null/undefined (no hay periodo comparable) → null. */
export function compareTotals(current: number, previous: number | null | undefined): Comparison | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || !Number.isFinite(current)) return null;
  const diff = Math.round(current - previous);
  return { pct: pctChange(current, previous), diffCents: diff, trend: diff > 0 ? "up" : diff < 0 ? "down" : "same" };
}

/** Ticket promedio = suma de compras (cargos positivos) / número de compras. Sin compras → null. */
export function avgTicket(purchaseCents: number, purchaseCount: number): number | null {
  return purchaseCount > 0 && Number.isFinite(purchaseCents) ? Math.round(purchaseCents / purchaseCount) : null;
}

export type PreviousPeriod = { from: string; to: string; label: string };

/**
 * Periodo equivalente anterior al filtrado, o null si no hay un periodo cerrado que comparar (sin fechas o con un extremo abierto).
 * Lo que aún no ha pasado se recorta a hoy (mes en curso = "del 1 a hoy"), y se compara contra los MISMOS días del periodo previo:
 *   - un día            → el día anterior (hoy vs ayer, ayer vs anteayer)
 *   - lunes → hoy/domingo → la semana anterior, los mismos días
 *   - mes (o mes a la fecha) → el mes anterior (mismos días si el actual no termina; un mes corto se recorta al fin de mes)
 *   - cualquier otro rango → el rango inmediato anterior de igual longitud (30 días vs los 30 previos)
 */
export function previousPeriod(p: { month?: string | null; from?: string | null; to?: string | null }, today: string): PreviousPeriod | null {
  const r = effectiveRange(p);
  if (!r.from || !r.to) return null;
  const from = r.from;
  const to = r.to > today ? today : r.to;
  if (from > to) return null; // periodo futuro

  // Un `month=` puro es "ese mes" aunque hoy sea día 1 o lunes: se compara contra el mes anterior, no contra ayer/la semana pasada.
  const isMonth = !!p.month && !p.from && !p.to;

  if (from === to && !isMonth) {
    const label = from === today ? "vs ayer" : from === addDays(today, -1) ? "vs anteayer" : "vs el día anterior";
    const prev = addDays(from, -1);
    return { from: prev, to: prev, label };
  }

  const len = rangeDays(from, to);
  if (!isMonth && weekdayIndex(from) === 0 && len <= 7 && (to === today || len === 7)) {
    return { from: addDays(from, -7), to: addDays(to, -7), label: "vs semana pasada" };
  }

  if (from.endsWith("-01") && from.slice(0, 7) === to.slice(0, 7)) {
    const month = from.slice(0, 7);
    // (Un rango libre que cae justo en un mes también se trata como mes.)
    const pm = prevMonth(month);
    const pmLast = lastDayOfMonth(pm);
    // Mes completo → mes completo; mes a la fecha → mismos días (sin pasarse del fin del mes previo).
    const fullMonth = to === lastDayOfMonth(month);
    const pTo = fullMonth ? pmLast : `${pm}-${String(Math.min(Number(to.slice(8, 10)), Number(pmLast.slice(8, 10)))).padStart(2, "0")}`;
    return { from: `${pm}-01`, to: pTo, label: month === today.slice(0, 7) ? "vs mes pasado" : "vs mes anterior" };
  }

  return { from: addDays(from, -len), to: addDays(from, -1), label: len === 30 ? "vs 30 días previos" : "vs periodo anterior" };
}

export type ShareItem = { id: number | null; name: string; color: string; cents: number; count: number; /** % de la suma de los grupos positivos (0-100). */ pct: number };

/**
 * Los `topN` grupos con más monto y su participación. El % es sobre la suma de los grupos con monto positivo (los reembolsos de un
 * grupo no inflan a los demás), así que las barras nunca pasan de 100 %. Empates: por nombre, para que el orden sea estable.
 */
export function rankShares<T extends { name: string; cents: number; count: number }>(items: T[], topN: number): { top: (T & { pct: number })[]; rest: { groups: number; cents: number }; baseCents: number } {
  const sorted = [...items].filter((i) => i.cents > 0).sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name, "es"));
  const base = sorted.reduce((a, i) => a + i.cents, 0);
  const top = sorted.slice(0, Math.max(0, topN)).map((i) => ({ ...i, pct: base > 0 ? (i.cents / base) * 100 : 0 }));
  const rest = sorted.slice(top.length);
  return { top, rest: { groups: rest.length, cents: rest.reduce((a, i) => a + i.cents, 0) }, baseCents: base };
}

/** Promedio diario de una ventana de `days` días; sin movimientos en la ventana → null (no hay con qué comparar). */
export function dailyAverage(totalCents: number, days: number, count: number): number | null {
  return count > 0 && days > 0 && Number.isFinite(totalCents) ? Math.round(totalCents / days) : null;
}

export type TxSummary = {
  kind: "expense" | "card_payment" | "all";
  /** Suma neta: los reembolsos (monto negativo) restan. */
  totalCents: number;
  /** Todos los movimientos del conjunto filtrado (incluye reembolsos). */
  count: number;
  /** Cargos positivos: base del ticket promedio (los reembolsos no son compras). */
  purchaseCount: number;
  purchaseCents: number;
  refundCents: number;
  avgTicketCents: number | null;
  cards: (ShareItem & { issuer: Issuer; art: CardArtId | null })[];
  /** Tarjetas fuera del top. */
  cardsRest: { groups: number; cents: number };
  categories: ShareItem[];
  topPurchase: { id: number; merchant: string; cents: number; date: string; card: string } | null;
  topMerchant: { merchant: string; cents: number; count: number } | null;
  /** Periodo efectivo del filtro (recortado a hoy si aún no termina). */
  period: { from: string; to: string } | null;
  previous: (PreviousPeriod & { totalCents: number; count: number; comparison: Comparison | null }) | null;
  /** Solo cuando el periodo es exactamente hoy: promedio diario de los 30 días anteriores, si hubo movimientos. */
  avg30: { avgCents: number; diffCents: number; pct: number | null } | null;
};

/** ¿El periodo del filtro es exactamente "hoy"? */
export function isTodayPeriod(p: { month?: string | null; from?: string | null; to?: string | null }, today: string): boolean {
  const r = effectiveRange(p);
  return r.from === today && r.to === today;
}
