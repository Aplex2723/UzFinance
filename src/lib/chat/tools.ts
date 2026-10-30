import { z } from "zod";
import { cleanLabel, STATUS_TEXT } from "@/lib/goals-recap";
import { goalWhen, isFixedCategory, KIND_LABEL, PRIORITY_LABEL } from "@/lib/goals";
import { ISSUER_LABEL, shiftMonth } from "@/lib/format";
import type { ToolSpec } from "@/lib/llm/stream";
import { addMonthsIso } from "@/lib/msi";
import { normalizeMerchant } from "@/lib/merchant";
import { getRecurring } from "@/lib/repo/stats";
import { matchCard } from "@/lib/repo/cards";
import { cardTotals, categoryTotals, merchantTotals, seriesTotals } from "@/lib/repo/chat-queries";
import { getGoalsOverview } from "@/lib/repo/goals-plan";
import { getInsights } from "@/lib/repo/insights";
import { getMsi } from "@/lib/repo/plans";
import { getMonthlyIncome } from "@/lib/repo/settings";
import { getTransactionSummary, listTransactions } from "@/lib/repo/transactions";
import { currentMonth, localDate, monthRange } from "@/lib/time";
import { diffDays, isRealDate, isRealMonth, rangeDays, rangeError, SORT_IDS } from "@/lib/tx-filters";
import { previousPeriod, pctChange } from "@/lib/tx-summary";
import type { Card, Category } from "@/lib/types";
import { calculate, CalcError } from "./calc";

/**
 * Herramientas de UzChat: el modelo NO ve la base de datos, solo pide estas consultas (de solo lectura) y recibe su resultado. Todo
 * monto sale en PESOS (número con 2 decimales) y toda fecha como YYYY-MM-DD, para que pueda citarlos tal cual o pasarlos a `calculate`.
 * Lo que puede ver (comercios, montos por movimiento) lo decidió el dueño: ver docs/GUIA.md. Nunca notas, códigos de autorización
 * ni números de cuenta.
 */
export type ToolCtx = { now: Date; categories: Category[]; cards: Card[] };

type Tool<S extends z.ZodType> = {
  name: string;
  /** Texto en español que ve la persona mientras la herramienta corre. */
  label: string;
  description: string;
  schema: S;
  run: (args: z.output<S>, ctx: ToolCtx) => Promise<unknown>;
};
type AnyTool = { name: string; label: string; description: string; schema: z.ZodType; run: (args: never, ctx: ToolCtx) => Promise<unknown> };
const defineTool = <S extends z.ZodType>(t: Tool<S>): AnyTool => t as unknown as AnyTool;

/** Centavos → pesos con 2 decimales. */
const pesos = (cents: number) => Math.round(cents) / 100;
const pct = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const share = (part: number, whole: number) => (whole > 0 ? pct((part / whole) * 100) : null);

/* ------------------------------------------------------------------ periodo -- */

const dateStr = z.string().refine(isRealDate, "fecha inválida (usa YYYY-MM-DD)");
const monthStr = z.string().refine(isRealMonth, "mes inválido (usa YYYY-MM)");

const periodFields = {
  month: monthStr.optional().describe("Un mes completo, 'YYYY-MM'. Si es el mes en curso cubre del día 1 a hoy."),
  from: dateStr.optional().describe("Inicio del rango, 'YYYY-MM-DD'."),
  to: dateStr.optional().describe("Fin del rango (incluido), 'YYYY-MM-DD'. Por omisión, hoy."),
};

export class ToolArgError extends Error {}

/** month | from/to | nada (= mes en curso a la fecha). Lo que aún no llega se recorta a hoy. */
export function resolvePeriod(a: { month?: string; from?: string; to?: string }, today: string): { from: string; to: string } {
  if (a.month && (a.from || a.to)) throw new ToolArgError("Usa 'month' o 'from'/'to', no ambos");
  let from: string;
  let to: string;
  if (a.month) {
    ({ from, to } = monthRange(a.month));
  } else if (a.from || a.to) {
    if (!a.from) throw new ToolArgError("Si das 'to' también da 'from'");
    from = a.from;
    to = a.to ?? today;
  } else {
    from = `${currentMonth(new Date(`${today}T12:00:00Z`))}-01`;
    to = today;
  }
  if (from > today) throw new ToolArgError("Ese periodo aún no llega");
  if (to > today) to = today;
  const err = rangeError(from, to);
  if (err) throw new ToolArgError(err);
  return { from, to };
}

const periodOut = (r: { from: string; to: string }) => ({ desde: r.from, hasta: r.to, dias: rangeDays(r.from, r.to) });

/** Una sola coincidencia o error: exacta primero; si no, parcial solo cuando es única (nunca "la primera que se parezca"). */
function pickOne<T extends { name: string }>(ref: string, items: T[], what: string): T {
  const n = normalizeMerchant(ref);
  if (n.length < 2) throw new ToolArgError(`${what} inválida: "${cleanLabel(ref)}". Opciones: ${items.map((c) => c.name).join(", ")}`);
  const exact = items.filter((c) => normalizeMerchant(c.name) === n);
  const partial = exact.length ? exact : items.filter((c) => normalizeMerchant(c.name).includes(n));
  if (partial.length === 1) return partial[0];
  throw new ToolArgError(
    partial.length
      ? `"${cleanLabel(ref)}" coincide con varias (${partial.map((c) => c.name).join(", ")}); elige una`
      : `No existe ${what.toLowerCase()} "${cleanLabel(ref)}". Opciones: ${items.map((c) => c.name).join(", ")}`,
  );
}

/** Categoría por nombre (sin acentos ni mayúsculas). "sin categoría" = ninguna. */
function findCategory(name: string, cats: Category[]): { id: number | "none"; name: string } {
  if (/^sin categor/i.test(name.trim())) return { id: "none", name: "Sin categoría" };
  const c = pickOne(name, cats, "Categoría");
  return { id: c.id, name: c.name };
}

function findCard(ref: string, cards: Card[]): Card {
  return matchCard(cards, ref) ?? pickOne(ref, cards, "Tarjeta");
}

/* ------------------------------------------------------------ herramientas -- */

const TOOLS: AnyTool[] = [
  defineTool({
    name: "spending_summary",
    label: "Revisando tus gastos",
    description: "Resumen del gasto en un periodo: total, número de compras, ticket y promedio diario, compra más grande, comercio con más gasto y comparación con el periodo equivalente anterior. Úsala para '¿cuánto gasté…?'.",
    schema: z.object(periodFields),
    run: async (a, ctx) => {
      const today = localDate(ctx.now);
      const r = resolvePeriod(a, today);
      const s = await getTransactionSummary({ from: r.from, to: r.to, kind: "expense" }, { today });
      const days = rangeDays(r.from, r.to);
      return {
        periodo: periodOut(r),
        total_gastado: pesos(s.totalCents),
        movimientos: s.count,
        compras: s.purchaseCount,
        reembolsos: pesos(s.refundCents),
        ticket_promedio: s.avgTicketCents === null ? null : pesos(s.avgTicketCents),
        promedio_diario: pesos(s.totalCents / days),
        compra_mas_grande: s.topPurchase && { comercio: cleanLabel(s.topPurchase.merchant), monto: pesos(s.topPurchase.cents), fecha: s.topPurchase.date, tarjeta: s.topPurchase.card },
        comercio_con_mas_gasto: s.topMerchant && { comercio: cleanLabel(s.topMerchant.merchant), gastado: pesos(s.topMerchant.cents), compras: s.topMerchant.count },
        periodo_anterior_comparable: s.previous && {
          desde: s.previous.from, hasta: s.previous.to, total_gastado: pesos(s.previous.totalCents),
          diferencia: pesos(s.totalCents - s.previous.totalCents), cambio_porcentual: pct(s.previous.comparison?.pct ?? null),
        },
      };
    },
  }),

  defineTool({
    name: "month_overview",
    label: "Analizando el mes",
    description: "Cómo va un mes frente al ingreso mensual: gastado, % del ingreso, ahorro o déficit, proyección al cierre, cuánto puedes gastar al día lo que resta, días sin gasto, día y día de la semana más caros, e historial de los últimos meses. Úsala para '¿cómo voy este mes?'.",
    schema: z.object({ month: monthStr.optional().describe("'YYYY-MM'. Por omisión, el mes en curso.") }),
    run: async (a, ctx) => {
      const i = await getInsights(a.month ?? currentMonth(ctx.now), ctx.now);
      const prevSame = i.categoryDeltas.reduce((s, c) => s + c.prevCents, 0);
      return {
        mes: i.month,
        situacion: i.isCurrent ? `mes en curso, va el día ${i.elapsedDays} de ${i.daysInMonth}` : "mes cerrado",
        ingreso_mensual: i.income > 0 ? pesos(i.income) : null,
        gastado: pesos(i.spent),
        porcentaje_del_ingreso_gastado: pct(i.usedPct),
        ahorro_o_deficit_hasta_hoy: i.income > 0 ? pesos(i.saved) : null,
        ...(i.isCurrent ? { proyeccion_al_cierre: pesos(i.projected), porcentaje_del_ingreso_proyectado: pct(i.projectedPct), puedes_gastar_al_dia_lo_que_resta: i.dailyAllowance === null ? null : pesos(i.dailyAllowance), dias_restantes: i.remainingDays } : {}),
        gasto_mismo_periodo_mes_anterior: prevSame > 0 ? pesos(prevSame) : null,
        promedio_por_dia: pesos(i.avgPerDay),
        compras: i.count,
        ticket_promedio: pesos(i.avgTicket),
        dias_sin_gasto: i.noSpendDays,
        dia_de_mayor_gasto: i.topDay && { fecha: i.topDay.date, monto: pesos(i.topDay.cents) },
        dia_de_la_semana_mas_caro: i.topWeekday && { dia: i.topWeekday.name, monto: pesos(i.topWeekday.cents) },
        ultimos_meses: i.history.slice(-7).filter((h) => h.spent > 0).map((h) => ({ mes: h.month, gastado: pesos(h.spent), porcentaje_del_ingreso: pct(h.usedPct) })),
      };
    },
  }),

  defineTool({
    name: "spending_by_category",
    label: "Agrupando por categoría",
    description: "Gasto por categoría en un periodo, de mayor a menor, con porcentaje del total y cambio contra el periodo equivalente anterior. Úsala para '¿en qué gasto más?'.",
    schema: z.object({ ...periodFields, limit: z.coerce.number().int().min(1).max(30).default(12).describe("Cuántas categorías listar (por omisión 12).") }),
    run: async (a, ctx) => {
      const today = localDate(ctx.now);
      const r = resolvePeriod(a, today);
      const prevP = previousPeriod({ from: r.from, to: r.to }, today);
      const [cur, prev] = await Promise.all([categoryTotals(r.from, r.to), prevP ? categoryTotals(prevP.from, prevP.to) : Promise.resolve([])]);
      const prevBy = new Map(prev.map((c) => [c.name, c.cents]));
      const total = cur.reduce((s, c) => s + c.cents, 0);
      const shown = cur.filter((c) => c.cents !== 0).slice(0, a.limit);
      const rest = cur.filter((c) => c.cents !== 0).slice(a.limit);
      return {
        periodo: periodOut(r),
        total_gastado: pesos(total),
        periodo_anterior: prevP && { desde: prevP.from, hasta: prevP.to },
        categorias: shown.map((c) => ({
          categoria: cleanLabel(c.name), gastado: pesos(c.cents), movimientos: c.count, porcentaje_del_total: share(c.cents, total),
          ...(prevP ? { periodo_anterior: pesos(prevBy.get(c.name) ?? 0), cambio_porcentual: pct(pctChange(c.cents, prevBy.get(c.name) ?? 0)) } : {}),
        })),
        ...(rest.length ? { otras_categorias: { cantidad: rest.length, gastado: pesos(rest.reduce((s, c) => s + c.cents, 0)) } } : {}),
      };
    },
  }),

  defineTool({
    name: "spending_by_card",
    label: "Comparando tarjetas",
    description: "Gasto por tarjeta en un periodo (cuánto cargaste a cada una y qué porcentaje del total).",
    schema: z.object(periodFields),
    run: async (a, ctx) => {
      const r = resolvePeriod(a, localDate(ctx.now));
      const rows = await cardTotals(r.from, r.to);
      const total = rows.reduce((s, c) => s + c.cents, 0);
      return {
        periodo: periodOut(r), total_gastado: pesos(total),
        tarjetas: rows.map((c) => ({ tarjeta: cleanLabel(c.name), emisor: ISSUER_LABEL[c.issuer as keyof typeof ISSUER_LABEL] ?? c.issuer, gastado: pesos(c.cents), movimientos: c.count, porcentaje_del_total: share(c.cents, total) })),
      };
    },
  }),

  defineTool({
    name: "top_merchants",
    label: "Buscando comercios",
    description: "Comercios donde más gastaste en un periodo (opcionalmente solo de una categoría), con total y número de compras. Úsala para '¿dónde gasto más?' o '¿cuánto gasté en <comercio>?' junto con search_transactions.",
    schema: z.object({
      ...periodFields,
      category: z.string().max(60).optional().describe("Nombre de una categoría para limitar la lista (ver la lista de categorías en el contexto)."),
      limit: z.coerce.number().int().min(1).max(25).default(10),
    }),
    run: async (a, ctx) => {
      const r = resolvePeriod(a, localDate(ctx.now));
      const cat = a.category ? findCategory(a.category, ctx.categories) : undefined;
      const rows = await merchantTotals(r.from, r.to, { categoryId: cat?.id, limit: a.limit });
      return { periodo: periodOut(r), ...(cat ? { categoria_filtrada: cleanLabel(cat.name) } : {}), comercios: rows.map((m) => ({ comercio: cleanLabel(m.merchant), categoria: m.category ? cleanLabel(m.category) : null, gastado: pesos(m.cents), compras: m.count })) };
    },
  }),

  defineTool({
    name: "spending_over_time",
    label: "Revisando la tendencia",
    description: "Serie del gasto por mes, semana (empieza en lunes) o día, para ver tendencias y compararlos. Por omisión: los últimos 6 meses por mes (con ingreso y ahorro estimado de cada mes). Solo aparecen periodos con movimientos.",
    schema: z.object({ ...periodFields, grain: z.enum(["month", "week", "day"]).optional().describe("Agrupar por mes, semana o día. Por omisión se elige según el largo del periodo.") }),
    run: async (a, ctx) => {
      const today = localDate(ctx.now);
      const noPeriod = !a.month && !a.from && !a.to;
      const r = noPeriod ? { from: `${shiftMonth(currentMonth(ctx.now), -5)}-01`, to: today } : resolvePeriod(a, today);
      const days = rangeDays(r.from, r.to);
      const grain = a.grain ?? (noPeriod ? "month" : days <= 31 ? "day" : days <= 120 ? "week" : "month");
      if (grain === "day" && days > 93) throw new ToolArgError("Por día solo hasta 93 días; usa grain 'week' o 'month'");
      if (grain === "week" && days > 400) throw new ToolArgError("Por semana solo hasta ~13 meses; usa grain 'month'");
      const [pts, income] = await Promise.all([seriesTotals(r.from, r.to, grain), grain === "month" ? getMonthlyIncome() : Promise.resolve(0)]);
      const total = pts.reduce((s, p) => s + p.cents, 0);
      return {
        periodo: periodOut(r), agrupado_por: grain, total_gastado: pesos(total),
        promedio_por_periodo_con_gasto: pts.length ? pesos(total / pts.length) : 0,
        ...(grain === "month" && income > 0 ? { ingreso_mensual_vigente: pesos(income), nota: "El ingreso es una sola cifra vigente (no el de cada mes); el mes en curso está incompleto." } : {}),
        serie: pts.map((p) => ({ periodo: p.period, gastado: pesos(p.cents), movimientos: p.count, ...(grain === "month" && income > 0 ? { ahorro_estimado: pesos(income - p.cents) } : {}) })),
      };
    },
  }),

  defineTool({
    name: "search_transactions",
    label: "Buscando movimientos",
    description: "Busca movimientos concretos por comercio, categoría, tarjeta, monto o periodo. Devuelve cuántos coinciden, el monto TOTAL de todos los que coinciden y los primeros N. Úsala para '¿cuánto gasté en Uber?', '¿cuál fue mi compra más grande?', '¿cuándo fue la última vez que…?'.",
    schema: z.object({
      ...periodFields,
      q: z.string().trim().max(100).optional().describe("Texto a buscar en el nombre del comercio (nunca en las notas)."),
      category: z.string().max(60).optional().describe("Nombre de la categoría."),
      card: z.string().max(60).optional().describe("Nombre, alias o últimos 4 dígitos de la tarjeta."),
      min_amount: z.coerce.number().min(0).max(100_000_000).optional().describe("Monto mínimo en pesos (se compara sin signo: un reembolso de -500 cuenta como 500)."),
      max_amount: z.coerce.number().min(0).max(100_000_000).optional().describe("Monto máximo en pesos (sin signo)."),
      only_purchases: z.boolean().optional().describe("true = solo cargos, sin reembolsos (los reembolsos tienen monto negativo). Por omisión es true al ordenar por monto."),
      sort: z.enum(SORT_IDS).default("recent").describe("recent = más recientes, oldest, amount_desc = más caros primero, amount_asc."),
      limit: z.coerce.number().int().min(1).max(25).default(10),
    }),
    run: async (a, ctx) => {
      const today = localDate(ctx.now);
      const hasPeriod = !!(a.month || a.from || a.to);
      const r = hasPeriod ? resolvePeriod(a, today) : null;
      const cat = a.category ? findCategory(a.category, ctx.categories) : undefined;
      const card = a.card ? findCard(a.card, ctx.cards) : undefined;
      const purchasesOnly = a.only_purchases ?? a.sort.startsWith("amount");
      const filter = {
        kind: "expense" as const,
        qMerchantOnly: true,
        purchasesOnly,
        ...(r ? { from: r.from, to: r.to } : {}),
        ...(a.q ? { q: a.q } : {}),
        ...(cat ? { categoryId: cat.id } : {}),
        ...(card ? { cardIds: [card.id] } : {}),
        ...(a.min_amount !== undefined ? { minCents: Math.round(a.min_amount * 100) } : {}),
        ...(a.max_amount !== undefined ? { maxCents: Math.round(a.max_amount * 100) } : {}),
      };
      const [list, sum] = await Promise.all([listTransactions({ ...filter, sort: a.sort, limit: a.limit }), getTransactionSummary(filter, { today })]);
      return {
        periodo: r ? periodOut(r) : "todo el historial",
        filtros_aplicados: { comercio_contiene: a.q ?? null, categoria: cat ? cleanLabel(cat.name) : null, tarjeta: card ? cleanLabel(card.name) : null, solo_cargos_sin_reembolsos: purchasesOnly },
        coincidencias: list.total,
        monto_total_de_todas_las_coincidencias: pesos(sum.totalCents),
        mostrando: list.rows.length,
        movimientos: list.rows.map((x) => ({
          fecha: x.occurred_date, monto: pesos(x.amount_cents), comercio: cleanLabel(x.merchant_raw), categoria: x.category_name ? cleanLabel(x.category_name) : null,
          tarjeta: cleanLabel(x.card_name), a_meses_sin_intereses: x.plan_id !== null,
        })),
      };
    },
  }),

  defineTool({
    name: "installments_msi",
    label: "Revisando tus MSI",
    description: "Compras a meses sin intereses (MSI) y planes a meses: cuánto se cobra este mes, saldo por pagar, cuándo terminas de pagar todo, cada plan vigente y el calendario de cobros de los próximos meses.",
    schema: z.object({}),
    run: async (_a, ctx) => {
      const m = await getMsi(ctx.now);
      return {
        se_cobra_este_mes: pesos(m.loadNow),
        porcentaje_del_ingreso: pct(m.loadPct),
        saldo_total_por_pagar: pesos(m.remainingTotal),
        saldo_con_intereses: pesos(m.interestPending),
        terminas_de_pagar_todo: m.freeMonth,
        planes_vigentes: m.active.map((p) => ({
          comercio: cleanLabel(p.merchant), tarjeta: cleanLabel(p.cardName), mensualidad: pesos(p.monthlyCents), mensualidades_cobradas: p.paid, mensualidades_totales: p.nTotal,
          saldo_pendiente: pesos(p.pendingNow), monto_original: pesos(p.originalCents), con_intereses: p.withInterest, siguiente_cobro: p.nextBillOn, ultimo_cobro: p.endOn,
        })),
        calendario_proximos_meses: m.schedule.filter((s) => !s.past && s.total > 0).slice(0, 8).map((s) => ({ mes: s.month, se_cobra: pesos(s.total) })),
      };
    },
  }),

  defineTool({
    name: "savings_goals",
    label: "Revisando tus metas",
    description: "Metas de ahorro del usuario con su avance y predicción (¿llega a tiempo?, ¿cuánto falta liberar al mes?), más su capacidad de ahorro mensual (ingreso − gasto típico), escenarios de recortar gasto y las categorías con más gasto promedio.",
    schema: z.object({}),
    run: async (_a, ctx) => {
      const o = await getGoalsOverview(ctx.now);
      const c = o.capacity;
      return {
        ingreso_mensual: pesos(c.income),
        gasto_tipico_mensual: pesos(c.avgSpend),
        excedente_mensual_tipico: pesos(c.surplus),
        excedente_en_un_mes_de_gasto_alto: pesos(c.surplusLow),
        meses_de_historial_usados: c.months,
        base_de_la_estimacion: c.basis === "history" ? "promedio de meses cerrados" : c.basis === "current" ? "proyección del mes en curso" : "sin datos suficientes (falta ingreso o gastos)",
        metas: o.summary.plans.map((p) => ({
          nombre: cleanLabel(p.goal.name), tipo: KIND_LABEL[p.goal.kind], prioridad: PRIORITY_LABEL[p.goal.priority], monto_meta: pesos(p.goal.targetCents), ahorrado: pesos(p.goal.savedCents),
          falta: pesos(p.progress.remaining), fecha_limite: goalWhen(p.goal), apartar_al_mes_para_llegar: pesos(p.needPerMonth), estado: STATUS_TEXT[p.status],
          fecha_estimada_con_tu_excedente: p.projectedDate, meses_de_atraso: p.monthsLate, falta_liberar_al_mes: pesos(p.gapPerMonth),
        })),
        para_cumplir_todas_a_tiempo: o.summary.extraNeeded > 0 ? { liberar_al_mes: pesos(o.summary.extraNeeded), porcentaje_del_gasto: pct(o.summary.cutPct) } : null,
        si_recortas_gasto: o.scenarios.filter((s) => s.cutPct > 0).map((s) => ({ recorte: `${s.cutPct}%`, metas_a_tiempo: `${s.onTime} de ${s.active}`, termina_la_ultima: s.lastDate })),
        categorias_de_mayor_gasto_al_mes: o.categories.slice(0, 6).map((k) => ({ categoria: cleanLabel(k.name), promedio_mensual: pesos(k.avg) })),
      };
    },
  }),

  defineTool({
    name: "savings_simulation",
    label: "Simulando tu ahorro",
    description: "Simula una meta de ahorro nueva ('quiero ahorrar $X en N meses / para tal fecha'): cuánto hay que apartar al mes, si alcanza con lo que sobra hoy, cuánto falta liberar, en cuánto tiempo llegarías sin recortar y de qué categorías se puede recortar. Da 'months' o 'target_date'.",
    schema: z.object({
      target_amount: z.coerce.number().positive().max(1_000_000_000).describe("Monto que se quiere juntar, en pesos."),
      months: z.coerce.number().int().min(1).max(240).optional().describe("En cuántos meses."),
      target_date: dateStr.optional().describe("Fecha límite 'YYYY-MM-DD' (alternativa a months)."),
      already_saved: z.coerce.number().min(0).max(1_000_000_000).default(0).describe("Lo que ya se tiene ahorrado para esta meta, en pesos."),
    }),
    run: async (a, ctx) => {
      const today = localDate(ctx.now);
      if (a.months === undefined && !a.target_date) throw new ToolArgError("Falta 'months' o 'target_date'");
      let months = a.months;
      if (months === undefined) {
        const left = diffDays(today, a.target_date!);
        if (left <= 0) throw new ToolArgError("La fecha límite ya pasó");
        months = Math.max(1, Math.ceil(left / 30.4375));
      }
      const [o, msi] = await Promise.all([getGoalsOverview(ctx.now), getMsi(ctx.now)]);
      const c = o.capacity;
      const remaining = Math.max(0, Math.round(a.target_amount * 100) - Math.round(a.already_saved * 100));
      const need = Math.ceil(remaining / months);
      const base = {
        meta: pesos(a.target_amount), ya_ahorrado: pesos(a.already_saved), falta: pesos(remaining), meses: months,
        hay_que_apartar_al_mes: pesos(need), porcentaje_del_ingreso: c.income > 0 ? pct((need / c.income) * 100) : null,
      };
      if (c.basis === "none") return { ...base, sin_datos: "Falta el ingreso mensual o no hay gastos registrados: no se puede estimar cuánto te sobra al mes." };
      const shortfall = Math.max(0, need - c.surplus);
      const monthsAtSurplus = c.surplus > 0 ? Math.ceil(remaining / c.surplus) : null;
      const disc = o.categories.filter((k) => k.avg > 0 && !isFixedCategory(k.name)).slice(0, 5);
      const discTotal = disc.reduce((s, k) => s + k.avg, 0);
      return {
        ...base,
        ingreso_mensual: pesos(c.income),
        gasto_tipico_mensual: pesos(c.avgSpend),
        excedente_mensual_tipico: pesos(c.surplus),
        excedente_en_un_mes_de_gasto_alto: pesos(c.surplusLow),
        alcanza_sin_recortar: c.surplus >= need,
        alcanza_incluso_en_un_mes_de_gasto_alto: c.surplusLow >= need,
        falta_liberar_al_mes: pesos(shortfall),
        falta_liberar_como_porcentaje_del_gasto: c.avgSpend > 0 ? pct((shortfall / c.avgSpend) * 100) : null,
        sin_recortar_llegarias_en_meses: monthsAtSurplus,
        sin_recortar_llegarias_hacia: monthsAtSurplus !== null && monthsAtSurplus <= 240 ? addMonthsIso(today, monthsAtSurplus).slice(0, 7) : null,
        se_cobra_por_msi_este_mes: pesos(msi.loadNow),
        terminas_de_pagar_msi: msi.freeMonth,
        donde_recortar: disc.map((k) => ({ categoria: cleanLabel(k.name), promedio_mensual: pesos(k.avg), liberas_con_10_por_ciento: pesos(k.avg * 0.1), liberas_con_20_por_ciento: pesos(k.avg * 0.2), liberas_con_30_por_ciento: pesos(k.avg * 0.3) })),
        recortando_todas_esas_categorias: discTotal > 0 ? { al_10_por_ciento: pesos(discTotal * 0.1), al_20_por_ciento: pesos(discTotal * 0.2), al_30_por_ciento: pesos(discTotal * 0.3) } : null,
        nota: "El excedente no considera otras metas ya registradas; revisa savings_goals si importa. Las categorías fijas (servicios, salud, impuestos…) no se sugieren para recorte.",
      };
    },
  }),

  defineTool({
    name: "recurring_charges",
    label: "Buscando cargos recurrentes",
    description: "Cargos que se repiten (suscripciones, servicios, domiciliaciones): comercios con cargo en al menos 3 de los últimos 6 meses y monto parecido, con su promedio y total mensual aproximado.",
    schema: z.object({}),
    run: async (_a, ctx) => {
      const rows = await getRecurring(ctx.now);
      return {
        total_mensual_aproximado: pesos(rows.reduce((s, r) => s + r.avgCents, 0)),
        cargos: rows.map((r) => ({ comercio: cleanLabel(r.merchant), tarjeta: cleanLabel(r.card), meses_con_cargo_de_los_ultimos_6: r.months, monto_promedio: pesos(r.avgCents), ultimo_cargo: r.last, ultimo_monto: pesos(r.lastCents) })),
      };
    },
  }),

  defineTool({
    name: "calculate",
    label: "Calculando",
    description: "Calculadora exacta. ÚSALA para cualquier cuenta (sumas, restas, divisiones, porcentajes, interés compuesto, plazos) en vez de calcular de cabeza. Operadores + - * / ^ ( ) y % posfijo (el % solo divide entre 100: 50+10% da 50.1; para sumar un 10% usa 50*1.1); funciones round(x,n), ceil, floor, abs, sqrt, min, max. Números sin comas de miles: 1500, no 1,500.",
    schema: z.object({ expression: z.string().min(1).max(200).describe("Ejemplo: (50000-12000)/6  o  10000*(1+0.08/12)^24") }),
    run: async (a) => ({ expresion: a.expression, resultado: calculate(a.expression) }),
  }),
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Definiciones en el formato de OpenRouter (JSON Schema generado desde los esquemas de zod). */
export const TOOL_SPECS: ToolSpec[] = TOOLS.map((t) => {
  const parameters = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
  delete parameters.$schema;
  return { name: t.name, description: t.description, parameters };
});

export const toolLabel = (name: string) => BY_NAME.get(name)?.label ?? "Consultando tus datos";

/** Tope de lo que se le devuelve al modelo por herramienta (protege el contexto y el costo). */
export const MAX_TOOL_RESULT_CHARS = 12_000;

export type ToolOutcome = { ok: boolean; content: string };

/** Ejecuta una llamada del modelo. Nunca lanza: un error se le devuelve al modelo como texto para que corrija o se lo explique a la persona. */
export async function executeTool(name: string, rawArgs: string, ctx: ToolCtx): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, content: JSON.stringify({ error: `Herramienta desconocida: ${name}` }) };
  let args: unknown = {};
  if (rawArgs.trim()) {
    try { args = JSON.parse(rawArgs); } catch { return { ok: false, content: JSON.stringify({ error: "Los argumentos no son JSON válido" }) }; }
  }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, content: JSON.stringify({ error: "Argumentos inválidos", detalle: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`) }) };
  }
  try {
    const out = JSON.stringify(await tool.run(parsed.data as never, ctx));
    if (out.length <= MAX_TOOL_RESULT_CHARS) return { ok: true, content: out };
    return { ok: true, content: JSON.stringify({ aviso: "El resultado era demasiado largo y se recortó; pide un periodo o un límite menor.", parcial: out.slice(0, MAX_TOOL_RESULT_CHARS - 200) }) };
  } catch (e) {
    if (e instanceof ToolArgError || e instanceof CalcError) return { ok: false, content: JSON.stringify({ error: e.message }) };
    console.error(`[chat] herramienta ${name} falló:`, (e as Error)?.message);
    return { ok: false, content: JSON.stringify({ error: "No pude consultar ese dato en este momento" }) };
  }
}
