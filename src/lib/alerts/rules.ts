/**
 * Reglas de alerta PURAS: reciben datos ya leídos y devuelven candidatos. Sin base de datos, sin reloj, sin red.
 * Todo monto en centavos enteros; cualquier entrada no finita simplemente no dispara nada (nunca NaN en un texto).
 */
import type { AlertConfig } from "./config";
import { daysBetween, isoWeekKey, longDay } from "./dates";
import { formatMoney as money, safeText } from "./text";
import { MAX_ALERT_AGE_DAYS, SEVERITY_RANK, type AlertCandidate, type AlertSeverity } from "./types";

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export const maxSeverity = (a: AlertSeverity, b: AlertSeverity): AlertSeverity => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

// ── Utilidades ──────────────────────────────────────────────────────────────────

/** Mediana; null si no hay datos válidos. Ignora no finitos. */
export function median(xs: number[]): number | null {
  const v = xs.filter(fin).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Movimiento demasiado viejo para alertar (importaciones de estados de cuenta, correos tardíos). */
export function isStale(occurredDate: string, today: string, maxDays = MAX_ALERT_AGE_DAYS): boolean {
  const d = daysBetween(occurredDate, today);
  return !Number.isFinite(d) || d > maxDays;
}

export type TxFacts = {
  id: number;
  cents: number;
  kind: string;
  occurredDate: string;
  merchantNormalized: string;
  merchantRaw: string;
  categoryId: number | null;
  cardName: string;
  isRecurring: boolean;
};

export function isMuted(tx: Pick<TxFacts, "merchantNormalized" | "categoryId">, cfg: Pick<AlertConfig, "mutedMerchants" | "mutedCategoryIds">): boolean {
  if (tx.categoryId !== null && cfg.mutedCategoryIds.includes(tx.categoryId)) return true;
  const m = tx.merchantNormalized;
  return !!m && cfg.mutedMerchants.some((p) => p && m.includes(p));
}

/** ¿Este movimiento puede generar una alerta por transacción? Solo gastos positivos, recientes y no silenciados. */
export function isAlertableExpense(tx: TxFacts, cfg: AlertConfig, today: string): boolean {
  return tx.kind === "expense" && fin(tx.cents) && tx.cents > 0 && !isStale(tx.occurredDate, today) && !isMuted(tx, cfg);
}

/** Cargo igual (±5 %) del mismo comercio entre 20 y 70 días antes → ya es parte de la rutina (renta, suscripciones). */
export function isRecurringTx(cents: number, isRecurring: boolean, prior: { cents: number; daysAgo: number }[]): boolean {
  if (isRecurring) return true;
  return prior.some((p) => fin(p.cents) && p.cents > 0 && p.daysAgo >= 20 && p.daysAgo <= 70 && Math.abs(p.cents - cents) <= 0.05 * Math.max(cents, p.cents));
}

// ── 1 y 2. Compra fuerte / comercio nuevo ───────────────────────────────────────

export type TxHistory = {
  /** Montos de los últimos 90 días (sin la propia transacción). */
  merchantSamples: number[];
  categorySamples: number[];
  /** ¿Ya había comprado alguna vez en este comercio? */
  merchantSeen: boolean;
  /** Cuántos gastos previos hay en total (tope: basta con saber si ≥ MIN_HISTORY_FOR_NEW_MERCHANT). */
  priorExpenseCount: number;
  priorSameMerchant: { cents: number; daysAgo: number }[];
};

export const MIN_SAMPLES = 5;
/** Sin historial suficiente "todo comercio es nuevo": la regla de comercio nuevo no se activa. */
export const MIN_HISTORY_FOR_NEW_MERCHANT = 20;

export type LargeSignal = {
  severity: AlertSeverity;
  /** Superó el umbral absoluto. */
  absolute: boolean;
  /** Superó N veces lo habitual (con ≥5 muestras). */
  typical: { median: number; threshold: number; scope: "merchant" | "category" } | null;
};

/** Compra fuerte: ≥ umbral absoluto, o ≥ factor × mediana (comercio; si no hay muestras, categoría) con ≥5 muestras y mínimo razonable. */
export function largePurchaseSignal(cents: number, hist: Pick<TxHistory, "merchantSamples" | "categorySamples">, cfg: AlertConfig): LargeSignal | null {
  if (!fin(cents) || cents <= 0) return null;
  const absolute = cents >= cfg.largePurchaseCents;
  const absSev: AlertSeverity | null = absolute ? (cents >= 2 * cfg.largePurchaseCents ? "high" : "warn") : null;

  const valid = (xs: number[]) => xs.filter((x) => fin(x) && x > 0);
  const m = valid(hist.merchantSamples);
  const c = valid(hist.categorySamples);
  const scope = m.length >= MIN_SAMPLES ? "merchant" : c.length >= MIN_SAMPLES ? "category" : null;
  let typical: LargeSignal["typical"] = null;
  let typSev: AlertSeverity | null = null;
  if (scope) {
    const med = median(scope === "merchant" ? m : c)!;
    const threshold = Math.max(cfg.largeVsTypicalFactor * med, cfg.largeRelativeMinCents);
    if (med > 0 && cents >= threshold) {
      typical = { median: med, threshold, scope };
      // Solo por ser "raro" para ti sube a high cuando además pesa (≥ la mitad del umbral absoluto) y duplica el umbral relativo.
      typSev = cents >= 2 * threshold && cents >= cfg.largePurchaseCents / 2 ? "high" : "warn";
    }
  }
  const sev = absSev && typSev ? maxSeverity(absSev, typSev) : absSev ?? typSev;
  return sev ? { severity: sev, absolute, typical } : null;
}

/** Comercio nunca visto con monto alto (solo con historial suficiente). */
export function newMerchantSignal(cents: number, hist: Pick<TxHistory, "merchantSeen" | "priorExpenseCount">, cfg: AlertConfig): { severity: AlertSeverity } | null {
  if (!fin(cents) || cents < cfg.newMerchantCents) return null;
  if (hist.merchantSeen || hist.priorExpenseCount < MIN_HISTORY_FOR_NEW_MERCHANT) return null;
  return { severity: cents >= cfg.largePurchaseCents ? "high" : "warn" };
}

/**
 * Una sola alerta por movimiento para toda la familia "compra fuerte": junta compra fuerte y comercio nuevo.
 * Lo recurrente baja a `info`. La clave incluye la severidad: una edición que cruce a un nivel mayor genera aviso nuevo
 * (el repositorio descarta un nivel igual o menor dentro del grupo `large:<id>:`).
 */
export function largeAlertCandidate(tx: TxFacts, hist: TxHistory, cfg: AlertConfig, today: string): AlertCandidate | null {
  if (!isAlertableExpense(tx, cfg, today)) return null;
  const large = cfg.enabled.large_purchase ? largePurchaseSignal(tx.cents, hist, cfg) : null;
  const fresh = cfg.enabled.new_merchant_large ? newMerchantSignal(tx.cents, hist, cfg) : null;
  if (!large && !fresh) return null;

  const recurring = isRecurringTx(tx.cents, tx.isRecurring, hist.priorSameMerchant);
  let severity = maxSeverity(large?.severity ?? "info", fresh?.severity ?? "info");
  if (recurring) severity = "info";

  const who = safeText(tx.merchantRaw || tx.merchantNormalized, 40) || "un comercio";
  const amount = money(tx.cents);
  const reasons: string[] = [];
  if (large?.absolute) reasons.push(`Supera tu umbral de ${money(cfg.largePurchaseCents)}.`);
  if (large?.typical) {
    reasons.push(`Es ${(tx.cents / large.typical.median).toFixed(1)} veces lo habitual ${large.typical.scope === "merchant" ? "en este comercio" : "en esta categoría"} (mediana ${money(large.typical.median)}).`);
  }
  if (fresh) reasons.push("Es la primera vez que compras en este comercio.");
  if (recurring) reasons.push("Parece un cargo recurrente, por eso solo es informativo.");

  const rule = large ? "large_purchase" : "new_merchant_large";
  return {
    rule,
    severity,
    title: `${recurring ? "Cargo grande" : large ? "Compra fuerte" : "Comercio nuevo con monto alto"}: ${amount} en ${who}`,
    body: `${amount} en ${who} con ${safeText(tx.cardName, 40)} el ${longDay(tx.occurredDate)}. ${reasons.join(" ")}`.trim(),
    dedupeKey: `large:${tx.id}:${severity}`,
    txId: tx.id,
    data: { cents: tx.cents, merchant: tx.merchantNormalized, recurring, newMerchant: !!fresh, ...(large?.typical ? { median: large.typical.median } : {}) },
  };
}

// ── 3. Ritmo del mes ────────────────────────────────────────────────────────────

export const PACE_MIN_DAY = 5;
/** Con pocos días, "gasto × días del mes" es ruido (la renta del día 1 lo dispara): la proyección contra ingreso espera al día 10. */
export const PACE_PROJECTION_MIN_DAY = 10;

export type PaceInput = {
  month: string;
  isCurrent: boolean;
  elapsedDays: number;
  daysInMonth: number;
  spent: number;
  prevSamePeriod: number;
  income: number;
  projected: number;
};

/** Gasto del mes en curso contra el mismo periodo del mes anterior y la proyección contra el ingreso. Una alerta por mes por nivel. */
export function paceCandidate(i: PaceInput, cfg: AlertConfig): AlertCandidate | null {
  if (![i.elapsedDays, i.daysInMonth, i.spent, i.prevSamePeriod, i.income, i.projected].every(fin)) return null;
  if (!i.isCurrent || i.elapsedDays < PACE_MIN_DAY || i.spent <= 0) return null;

  let severity: AlertSeverity | null = null;
  const lines: string[] = [];
  const data: Record<string, unknown> = { month: i.month, spent: i.spent };

  if (i.prevSamePeriod > 0) {
    const diff = i.spent - i.prevSamePeriod;
    const pct = (diff / i.prevSamePeriod) * 100;
    if (diff >= cfg.paceMinDiffCents && pct >= cfg.paceTolerancePct) {
      severity = pct >= 2 * cfg.paceTolerancePct ? "high" : "warn";
      lines.push(`Llevas ${money(i.spent)}: ${pct.toFixed(0)}% más que en el mismo periodo del mes pasado (${money(i.prevSamePeriod)}).`);
      data.prevSamePeriod = i.prevSamePeriod;
      data.deltaPct = Math.round(pct);
    }
  }

  if (i.income > 0 && i.elapsedDays >= PACE_PROJECTION_MIN_DAY && i.projected >= i.income) {
    const sev: AlertSeverity = i.projected >= 1.2 * i.income ? "high" : "warn";
    severity = severity ? maxSeverity(severity, sev) : sev;
    lines.push(`A este ritmo cerrarás en ${money(i.projected)}, ${((i.projected / i.income) * 100).toFixed(0)}% de tu ingreso (${money(i.income)}).`);
    data.projected = i.projected;
    data.income = i.income;
  }

  if (!severity) return null;
  return {
    rule: "spending_pace",
    severity,
    title: severity === "high" ? "Tu gasto del mes va muy por encima de lo normal" : "Tu gasto del mes va más rápido de lo normal",
    body: lines.join(" "),
    dedupeKey: `pace:${i.month}:${severity}`,
    data,
  };
}

// ── 4. Pico del día ─────────────────────────────────────────────────────────────

export type SpikeInput = {
  today: string;
  todayCents: number;
  /** Suma de gasto de los 30 días ANTERIORES a hoy y cuántos días distintos tuvieron gasto. */
  windowTotalCents: number;
  windowDays: number;
  daysWithSpend: number;
  /** La compra más grande de hoy ya generó su propia alerta y explica casi todo el pico. */
  topAlreadyAlerted: boolean;
};

export const SPIKE_MIN_DAYS_WITH_SPEND = 5;

export function dailySpikeCandidate(i: SpikeInput, cfg: AlertConfig): AlertCandidate | null {
  if (![i.todayCents, i.windowTotalCents, i.windowDays, i.daysWithSpend].every(fin) || i.windowDays <= 0) return null;
  // Arranque en frío: sin historial el "promedio" no significa nada (y dividiría entre cero).
  if (i.daysWithSpend < SPIKE_MIN_DAYS_WITH_SPEND || i.windowTotalCents <= 0) return null;
  if (i.topAlreadyAlerted) return null;
  const avg = i.windowTotalCents / i.windowDays;
  if (!(avg > 0) || i.todayCents < cfg.dailySpikeMinCents || i.todayCents < cfg.dailySpikeFactor * avg) return null;
  const high = i.todayCents >= 2 * cfg.dailySpikeFactor * avg && i.todayCents >= 2 * cfg.dailySpikeMinCents;
  const severity: AlertSeverity = high ? "high" : "warn";
  return {
    rule: "daily_spike",
    severity,
    title: `Hoy llevas ${money(i.todayCents)}: ${(i.todayCents / avg).toFixed(1)} veces tu día normal`,
    body: `Tu gasto de hoy (${money(i.todayCents)}) supera ${(i.todayCents / avg).toFixed(1)} veces tu promedio diario de los últimos 30 días (${money(Math.round(avg))}).`,
    dedupeKey: `spike:${i.today}:${severity}`,
    data: { today: i.today, todayCents: i.todayCents, avgCents: Math.round(avg) },
  };
}

// ── 5. Posible duplicado ────────────────────────────────────────────────────────

export type DupFacts = { id: number; cardId: number; cents: number; merchantNormalized: string; occurredAtMs: number; kind: string };
export const DUP_WINDOW_MS = 10 * 60 * 1000;

/** Misma tarjeta + mismo monto + mismo comercio normalizado a ≤10 min (sin importar la fuente). */
export function isDuplicatePair(a: DupFacts, b: DupFacts): boolean {
  if (a.id === b.id) return false;
  if (a.kind !== "expense" || b.kind !== "expense") return false;
  if (!fin(a.cents) || a.cents <= 0 || a.cents !== b.cents || a.cardId !== b.cardId) return false;
  if (!a.merchantNormalized || a.merchantNormalized !== b.merchantNormalized) return false;
  return fin(a.occurredAtMs) && fin(b.occurredAtMs) && Math.abs(a.occurredAtMs - b.occurredAtMs) <= DUP_WINDOW_MS;
}

export function duplicateCandidate(a: TxFacts, otherId: number): AlertCandidate {
  const lo = Math.min(a.id, otherId);
  const hi = Math.max(a.id, otherId);
  const who = safeText(a.merchantRaw || a.merchantNormalized, 40) || "un comercio";
  return {
    rule: "duplicate_suspect",
    severity: "warn",
    title: `Posible cobro duplicado: ${money(a.cents)} en ${who}`,
    body: `Hay dos movimientos de ${money(a.cents)} en ${who} con ${safeText(a.cardName, 40)} con minutos de diferencia. Revisa si fue un cobro doble; no se borró nada.`,
    dedupeKey: `dup:${lo}:${hi}`,
    txId: a.id,
    data: { ids: [lo, hi], cents: a.cents },
  };
}

// ── 6. Sin confirmar ────────────────────────────────────────────────────────────

export type UnconfirmedRow = { id: number; cents: number; merchant: string };

/** Un resumen (no una alerta por fila). Se vuelve a avisar solo cuando aparece una compra sin confirmar más reciente. */
export function unconfirmedCandidate(rows: UnconfirmedRow[], cfg: AlertConfig): AlertCandidate | null {
  const ok = rows.filter((r) => fin(r.cents) && r.cents > 0 && Number.isSafeInteger(r.id));
  if (!ok.length) return null;
  void cfg;
  const total = ok.reduce((a, r) => a + r.cents, 0);
  const maxId = Math.max(...ok.map((r) => r.id));
  const top = [...ok].sort((a, b) => b.cents - a.cents)[0];
  return {
    rule: "unconfirmed",
    severity: ok.length >= 3 ? "warn" : "info",
    title: ok.length === 1 ? "1 compra sin confirmar por el banco" : `${ok.length} compras sin confirmar por el banco`,
    body: `${ok.length === 1 ? "Una compra de Banamex lleva" : `${ok.length} compras de Banamex (${money(total)} en total) llevan`} más de 24 horas solo con el aviso del Atajo o lo que registraste por chat, sin correo del banco. La más grande: ${money(top.cents)} en ${safeText(top.merchant, 40) || "un comercio"}. Revisa que sean tuyas.`,
    dedupeKey: `unconfirmed:${maxId}`,
    data: { count: ok.length, totalCents: total, ids: ok.slice(0, 20).map((r) => r.id) },
  };
}

// ── 7. Meta de ahorro ───────────────────────────────────────────────────────────

export type GoalAlertInput = {
  /** Id de la meta: con varias metas cada una tiene su propio aviso semanal. */
  id?: number;
  name: string;
  remaining: number;
  perMonth: number;
  done: boolean;
  overdue: boolean;
  daysLeft: number;
  /** Ingreso − gasto proyectado del mes en curso; null si aún no se puede proyectar. */
  projectedSaving: number | null;
  today: string;
};

/** Meta de ahorro: avisa cuando el ahorro proyectado del mes queda por debajo de lo que la meta pide. Máximo 1 por semana ISO. */
export function goalCandidate(i: GoalAlertInput, cfg: AlertConfig): AlertCandidate | null {
  if (![i.remaining, i.perMonth, i.daysLeft].every(fin) || i.done || i.remaining <= 0) return null;
  const name = safeText(i.name, 50) || "tu meta";
  const key = `goal:${i.id !== undefined ? `${i.id}:` : ""}${isoWeekKey(i.today)}`;
  if (i.overdue) {
    return {
      rule: "goal_off_track", severity: "warn",
      title: `La fecha de “${name}” ya pasó`,
      body: `La fecha límite de “${name}” ya pasó y todavía faltan ${money(i.remaining)}. Ajusta la fecha o el monto de la meta.`,
      dedupeKey: key, data: { remaining: i.remaining, overdue: true },
    };
  }
  if (i.perMonth <= 0 || i.projectedSaving === null || !fin(i.projectedSaving)) return null;
  const saving = Math.max(0, i.projectedSaving);
  const shortfall = i.perMonth - saving;
  if (shortfall <= (cfg.goalTolerancePct / 100) * i.perMonth) return null;
  const severity: AlertSeverity = shortfall >= 0.5 * i.perMonth ? "high" : "warn";
  return {
    rule: "goal_off_track",
    severity,
    title: `Tu meta “${name}” se está alejando`,
    body: `Para llegar a “${name}” necesitas apartar ${money(i.perMonth)} al mes y, a tu ritmo de gasto, este mes te sobrarían ${money(saving)}: faltarían ${money(shortfall)}.`,
    dedupeKey: key,
    data: { perMonth: i.perMonth, projectedSaving: saving, shortfall },
  };
}
