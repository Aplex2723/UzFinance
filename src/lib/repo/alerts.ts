import { applyAlertConfigPatch, DEFAULT_ALERT_CONFIG, parseAlertConfig, type AlertConfig } from "@/lib/alerts/config";
import { addDays, daysBetween } from "@/lib/alerts/dates";
import {
  dailySpikeCandidate, duplicateCandidate, goalCandidate, isDuplicatePair, isMuted, isAlertableExpense, largeAlertCandidate, paceCandidate,
  PACE_PROJECTION_MIN_DAY, unconfirmedCandidate, type TxFacts, type TxHistory,
} from "@/lib/alerts/rules";
import { scheduleAlertWork } from "@/lib/alerts/background";
import { clampBody, clampTitle, shortHash, whatsappText } from "@/lib/alerts/text";
import { isSeverity, MAX_NEW_ALERTS_PER_RUN, SEVERITY_RANK, type AlertCandidate, type AlertRow, type AlertRule } from "@/lib/alerts/types";
import { SQL as CHAT_SQL } from "@/lib/chat-sources";
import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { fundingOrder, goalProgress } from "@/lib/goals";
import { currentMonth, localDate } from "@/lib/time";
import { listGoals } from "./goals";
import { getInsights } from "./insights";

export { whatsappText };
export { DEFAULT_ALERT_CONFIG };
export type { AlertConfig };
export type { AlertCandidate, AlertRow, AlertSeverity } from "@/lib/alerts/types";
export { statementDiffCandidate, transferRegisteredCandidate } from "@/lib/alerts/text";

const CONFIG_KEY = "alerts_config";
const LAST_RUN_KEY = "alerts_last_run";
/** Mínimo entre corridas periódicas. */
export const PERIODIC_MIN_INTERVAL_MS = 15 * 60 * 1000;

const warn = (what: string, e: unknown) => console.error(`[alerts] ${what}:`, (e as Error)?.message);

// ── Configuración ───────────────────────────────────────────────────────────────

/** Configuración vigente. Si lo guardado está corrupto o fuera de rango, cada campo malo cae a su valor por defecto. */
export async function getAlertConfig(): Promise<AlertConfig> {
  const rows = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key] = @k", { k: t.varchar(CONFIG_KEY) });
  return parseAlertConfig(rows[0]?.value ?? null);
}

/** Aplica un parche parcial validado (lanza ZodError si algo está fuera de rango) y guarda el resultado completo. */
export async function setAlertConfig(patch: unknown): Promise<AlertConfig> {
  const next = applyAlertConfigPatch(await getAlertConfig(), patch);
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(CONFIG_KEY), v: t.str(JSON.stringify(next)) },
  );
  return next;
}

// ── Crear alertas ───────────────────────────────────────────────────────────────

type Budget = { left: number; created: number };
const newBudget = (): Budget => ({ left: MAX_NEW_ALERTS_PER_RUN, created: 0 });

/** Prefijo de grupo escapado para LIKE (las claves son nuestras, pero por si acaso). */
const likePrefix = (p: string) => `${p.replace(/[\\%_[]/g, "\\$&")}%`;

/** Mayor severidad (rango) ya registrada —incluso descartada— bajo un prefijo de clave; 0 si no hay. */
async function groupRank(prefix: string): Promise<number> {
  const rows = await query<{ severity: keyof typeof SEVERITY_RANK }>("SELECT severity FROM dbo.alerts WHERE dedupe_key LIKE @p ESCAPE '\\'", { p: t.varchar(likePrefix(prefix)) });
  return rows.reduce((m, r) => Math.max(m, SEVERITY_RANK[r.severity] ?? 0), 0);
}

type Inserted = { created: boolean; id?: number; telegram?: boolean };

async function insertAlert(c: AlertCandidate, cfg: AlertConfig, group?: string): Promise<Inserted> {
  if (!/^[a-z][a-z_]{0,29}$/.test(c.rule)) throw new RangeError("regla inválida");
  if (!isSeverity(c.severity)) throw new RangeError("severidad inválida");
  let key = String(c.dedupeKey ?? "").trim();
  if (!key) throw new RangeError("dedupeKey vacío");
  if (key.length > 120) key = `${key.slice(0, 100)}~${shortHash(key)}`; // determinístico: la misma clave larga da la misma corta

  if (cfg.enabled[c.rule as AlertRule] === false) return { created: false };
  const txId = c.txId ?? null;
  if (txId !== null) {
    const tx = await query<{ m: string; cat: number | null }>("SELECT merchant_normalized AS m, category_id AS cat FROM dbo.transactions WHERE id=@id", { id: t.big(txId) });
    if (!tx[0]) return { created: false };
    if (isMuted({ merchantNormalized: tx[0].m, categoryId: tx[0].cat }, cfg)) return { created: false };
  }
  // Una edición solo vuelve a avisar si cruza a un nivel mayor del que ya se avisó (aunque se haya descartado).
  if (group && (await groupRank(group)) >= SEVERITY_RANK[c.severity]) return { created: false };

  let data: string | null = null;
  if (c.data) {
    try {
      const j = JSON.stringify(c.data);
      data = j.length <= 8000 ? j : null;
    } catch {
      data = null;
    }
  }
  let id: number;
  try {
    const r = await query<{ id: number }>(
      `INSERT dbo.alerts ([rule], severity, title, body, dedupe_key, tx_id, document_id, data)
       OUTPUT INSERTED.id VALUES (@rule, @sev, @title, @body, @key, @tx, @doc, @data)`,
      {
        rule: t.varchar(c.rule), sev: t.varchar(c.severity), title: t.str(clampTitle(c.title)), body: t.str(clampBody(c.body)),
        key: t.varchar(key), tx: t.big(txId), doc: t.int(c.documentId ?? null), data: t.str(data),
      },
    );
    id = Number(r[0].id);
  } catch (e) {
    // Misma clave (o carrera con otra evaluación simultánea): ya existe, no es un error.
    if (isUniqueViolation(e)) return { created: false };
    throw e;
  }

  // Colas de avisos: un canal solo si está activado y la severidad alcanza su mínimo. Nada se envía aquí (lo hace el emisor del canal).
  const queued: Record<OutboxChannel, boolean> = { whatsapp: false, telegram: false };
  for (const channel of ["whatsapp", "telegram"] as const) {
    const ch = cfg[channel];
    if (!ch.enabled || SEVERITY_RANK[c.severity] < SEVERITY_RANK[ch.minSeverity]) continue;
    try {
      await query("INSERT dbo.alert_outbox (alert_id, channel) VALUES (@id, @ch)", { id: t.big(id), ch: t.varchar(channel) });
      queued[channel] = true;
    } catch (e) {
      if (!isUniqueViolation(e)) warn(`no se pudo encolar en alert_outbox (${channel})`, e);
    }
  }
  return { created: true, id, telegram: queued.telegram };
}

type OutboxChannel = "whatsapp" | "telegram";

/** Manda lo pendiente de Telegram. Import diferido: el emisor lee la configuración de este módulo (evita el ciclo). Nunca lanza. */
export async function flushTelegram(now?: Date): Promise<void> {
  try {
    const { flushTelegramOutbox } = await import("@/lib/alerts/telegram-sender");
    await flushTelegramOutbox({ now });
  } catch (e) {
    warn("flushTelegram", e);
  }
}

/** Crea una alerta (idempotente por `dedupe_key`). Respeta reglas apagadas y comercios/categorías silenciados. */
export async function createAlert(c: AlertCandidate): Promise<{ created: boolean; id?: number }> {
  const r = await insertAlert(c, await getAlertConfig());
  // El aviso por Telegram sale tras la respuesta (best effort: un fallo de red no rompe esto ni lo retrasa).
  if (r.telegram) scheduleAlertWork(() => flushTelegram());
  return { created: r.created, id: r.id };
}

/** Freno global contra inundaciones (un bug, una importación): las evaluaciones automáticas no crean más de esto por hora. */
export const HOURLY_ALERT_CAP = 30;

async function emit(cfg: AlertConfig, budget: Budget, c: AlertCandidate | null, group?: string): Promise<void> {
  if (!c || budget.left <= 0) return;
  const recent = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.alerts WHERE created_at >= DATEADD(hour, -1, SYSUTCDATETIME())");
  if (Number(recent[0].n) >= HOURLY_ALERT_CAP) {
    budget.left = 0;
    warn("tope por hora alcanzado", new Error(`${HOURLY_ALERT_CAP} alertas en la última hora`));
    return;
  }
  if ((await insertAlert(c, cfg, group)).created) {
    budget.left--;
    budget.created++;
  }
}

// ── Evaluación por transacción ──────────────────────────────────────────────────

type TxRow = {
  id: number; cents: number; kind: string; occurred_at: Date; d: string; raw: string; norm: string; card_id: number;
  card_name: string; category_id: number | null; is_recurring: boolean | number;
};

const sum = (xs: { c: number }[]) => xs.map((x) => Number(x.c));

async function loadTx(id: number): Promise<TxRow | null> {
  const r = await query<TxRow>(
    `SELECT x.id, CAST(x.amount_cents AS float) AS cents, x.kind, x.occurred_at, CONVERT(char(10), x.occurred_date, 23) AS d,
            x.merchant_raw AS raw, x.merchant_normalized AS norm, x.card_id, c.name AS card_name, x.category_id, x.is_recurring
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id WHERE x.id = @id`,
    { id: t.big(id) },
  );
  return r[0] ?? null;
}

async function loadHistory(tx: TxRow): Promise<TxHistory> {
  const p = { id: t.big(tx.id), m: t.str(tx.norm), d: t.date(tx.d), cat: t.int(tx.category_id) };
  const [ms, cs, seen, prior, count] = await Promise.all([
    query<{ c: number }>(
      `SELECT TOP 500 CAST(amount_cents AS float) AS c FROM dbo.transactions
       WHERE id<>@id AND kind='expense' AND amount_cents>0 AND merchant_normalized=@m AND occurred_date BETWEEN DATEADD(day,-90,@d) AND @d ORDER BY occurred_date DESC`, p),
    tx.category_id === null
      ? Promise.resolve([] as { c: number }[])
      : query<{ c: number }>(
          `SELECT TOP 500 CAST(amount_cents AS float) AS c FROM dbo.transactions
           WHERE id<>@id AND kind='expense' AND amount_cents>0 AND category_id=@cat AND occurred_date BETWEEN DATEADD(day,-90,@d) AND @d ORDER BY occurred_date DESC`, p),
    query("SELECT TOP 1 1 AS x FROM dbo.transactions WHERE id<>@id AND kind='expense' AND merchant_normalized=@m", p),
    query<{ c: number; ago: number }>(
      `SELECT CAST(amount_cents AS float) AS c, DATEDIFF(day, occurred_date, @d) AS ago FROM dbo.transactions
       WHERE id<>@id AND kind='expense' AND amount_cents>0 AND merchant_normalized=@m AND occurred_date BETWEEN DATEADD(day,-70,@d) AND DATEADD(day,-20,@d)`, p),
    query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM (SELECT TOP 20 id FROM dbo.transactions WHERE id<>@id AND kind='expense' AND amount_cents>0 AND occurred_date < @d) q", p),
  ]);
  return {
    merchantSamples: sum(ms), categorySamples: sum(cs), merchantSeen: seen.length > 0, priorExpenseCount: Number(count[0]?.n ?? 0),
    priorSameMerchant: prior.map((r) => ({ cents: Number(r.c), daysAgo: Number(r.ago) })),
  };
}

const facts = (r: TxRow): TxFacts => ({
  id: Number(r.id), cents: Number(r.cents), kind: r.kind, occurredDate: r.d, merchantNormalized: r.norm, merchantRaw: r.raw,
  categoryId: r.category_id === null ? null : Number(r.category_id), cardName: r.card_name, isRecurring: !!r.is_recurring,
});

/**
 * Evalúa una transacción recién registrada (o editada): compra fuerte, comercio nuevo, posible duplicado y pico del día.
 * NUNCA lanza (la ingesta no puede fallar por una alerta). Devuelve cuántas alertas nuevas creó.
 */
export async function evaluateTransactionAlerts(txId: number, now: Date = new Date()): Promise<number> {
  try {
    if (!Number.isSafeInteger(txId) || txId <= 0) return 0;
    const row = await loadTx(txId);
    if (!row) return 0;
    const cfg = await getAlertConfig();
    const today = localDate(now);
    const tx = facts(row);
    // Reembolsos, pagos de tarjeta, silenciados y movimientos viejos (importaciones, correos tardíos): ninguna alerta.
    if (!isAlertableExpense(tx, cfg, today)) return 0;
    const budget = newBudget();

    if (cfg.enabled.large_purchase || cfg.enabled.new_merchant_large) {
      await emit(cfg, budget, largeAlertCandidate(tx, await loadHistory(row), cfg, today), `large:${tx.id}:`);
    }
    if (cfg.enabled.duplicate_suspect) await checkDuplicates(row, tx, cfg, budget);
    if (cfg.enabled.daily_spike && tx.occurredDate === today) await checkDailySpike(cfg, today, budget);
    return budget.created;
  } catch (e) {
    warn("evaluateTransactionAlerts", e);
    return 0;
  }
}

async function checkDuplicates(row: TxRow, tx: TxFacts, cfg: AlertConfig, budget: Budget) {
  const others = await query<{ id: number; card_id: number; c: number; m: string; at: Date; kind: string }>(
    `SELECT id, card_id, CAST(amount_cents AS float) AS c, merchant_normalized AS m, occurred_at AS at, kind FROM dbo.transactions
     WHERE id<>@id AND card_id=@card AND amount_cents=@amt AND kind='expense' AND occurred_at BETWEEN DATEADD(minute,-10,@at) AND DATEADD(minute,10,@at)`,
    { id: t.big(tx.id), card: t.int(row.card_id), amt: t.big(Math.round(tx.cents)), at: t.dt(row.occurred_at) },
  );
  const me = { id: tx.id, cardId: Number(row.card_id), cents: tx.cents, merchantNormalized: tx.merchantNormalized, occurredAtMs: row.occurred_at.getTime(), kind: tx.kind };
  for (const o of others) {
    if (isDuplicatePair(me, { id: Number(o.id), cardId: Number(o.card_id), cents: Number(o.c), merchantNormalized: o.m, occurredAtMs: o.at.getTime(), kind: o.kind })) {
      await emit(cfg, budget, duplicateCandidate(tx, Number(o.id)));
    }
  }
}

// ── Pico del día ────────────────────────────────────────────────────────────────

async function checkDailySpike(cfg: AlertConfig, today: string, budget: Budget) {
  const rows = await query<{ id: number; d: string; c: number; cat: number | null; m: string; rec: boolean | number }>(
    `SELECT id, CONVERT(char(10), occurred_date, 23) AS d, CAST(amount_cents AS float) AS c, category_id AS cat, merchant_normalized AS m, is_recurring AS rec
     FROM dbo.transactions WHERE kind='expense' AND amount_cents>0 AND occurred_date BETWEEN @from AND @to`,
    { from: t.date(addDays(today, -30)), to: t.date(today) },
  );
  // Lo silenciado y lo recurrente (renta, suscripciones) no cuenta como "gasto del día".
  const used = rows.filter((r) => !r.rec && !isMuted({ merchantNormalized: r.m, categoryId: r.cat === null ? null : Number(r.cat) }, cfg));
  const todayRows = used.filter((r) => r.d === today);
  const past = used.filter((r) => r.d !== today && daysBetween(r.d, today) <= 30 && daysBetween(r.d, today) >= 1);
  const todayCents = todayRows.reduce((a, r) => a + Number(r.c), 0);
  const top = todayRows.reduce<(typeof todayRows)[number] | null>((b, r) => (!b || Number(r.c) > Number(b.c) ? r : b), null);
  let topAlreadyAlerted = false;
  if (top && Number(top.c) >= 0.8 * todayCents) {
    topAlreadyAlerted = (await query("SELECT TOP 1 1 AS x FROM dbo.alerts WHERE tx_id=@id AND dedupe_key LIKE 'large:%'", { id: t.big(Number(top.id)) })).length > 0;
  }
  const cand = dailySpikeCandidate(
    { today, todayCents, windowTotalCents: past.reduce((a, r) => a + Number(r.c), 0), windowDays: 30, daysWithSpend: new Set(past.map((r) => r.d)).size, topAlreadyAlerted },
    cfg,
  );
  await emit(cfg, budget, cand, `spike:${today}:`);
}

// ── Evaluación periódica ────────────────────────────────────────────────────────

async function checkUnconfirmed(cfg: AlertConfig, now: Date, budget: Budget) {
  // Misma definición que la columna `unconfirmed` de transactions (Banamex, solo Atajo o chat sin correo, >24 h), pero relativa a `now` y de los últimos 14 días.
  const rows = await query<{ id: number; c: number; m: string; norm: string; cat: number | null }>(
    `SELECT x.id, CAST(x.amount_cents AS float) AS c, x.merchant_raw AS m, x.merchant_normalized AS norm, x.category_id AS cat
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id
     WHERE c.issuer='banamex' AND x.kind='expense' AND x.amount_cents>0 AND ${CHAT_SQL.unconfirmed("x")}
       AND x.occurred_at < DATEADD(hour,-24,@now) AND x.occurred_at >= DATEADD(day,-14,@now)`,
    { now: t.dt(now) },
  );
  const kept = rows.filter((r) => !isMuted({ merchantNormalized: r.norm, categoryId: r.cat === null ? null : Number(r.cat) }, cfg));
  await emit(cfg, budget, unconfirmedCandidate(kept.map((r) => ({ id: Number(r.id), cents: Number(r.c), merchant: r.m })), cfg));
}

/**
 * Alertas que no dependen de una compra puntual: ritmo del mes, pico del día, meta de ahorro y compras sin confirmar.
 * NUNCA lanza. Devuelve cuántas alertas nuevas creó (máximo MAX_NEW_ALERTS_PER_RUN).
 */
export async function evaluatePeriodicAlerts(now: Date = new Date()): Promise<number> {
  const budget = newBudget();
  let cfg: AlertConfig;
  try {
    cfg = await getAlertConfig();
  } catch (e) {
    warn("evaluatePeriodicAlerts (config)", e);
    return 0;
  }
  const today = localDate(now);
  const month = currentMonth(now);
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      warn(`evaluatePeriodicAlerts (${name})`, e);
    }
  };

  let ins: Awaited<ReturnType<typeof getInsights>> | null = null;
  if (cfg.enabled.spending_pace || cfg.enabled.goal_off_track) await step("insights", async () => void (ins = await getInsights(month, now)));

  if (cfg.enabled.spending_pace && ins) {
    await step("pace", async () => {
      const i = ins!;
      // El mismo periodo del mes anterior ya está dentro de getInsights (por categoría): se reutiliza, no se vuelve a consultar.
      const prevSamePeriod = i.categoryDeltas.reduce((a, c) => a + c.prevCents, 0);
      await emit(cfg, budget, paceCandidate({ month, isCurrent: i.isCurrent, elapsedDays: i.elapsedDays, daysInMonth: i.daysInMonth, spent: i.spent, prevSamePeriod, income: i.income, projected: i.projected }, cfg), `pace:${month}:`);
    });
  }
  if (cfg.enabled.daily_spike) await step("spike", () => checkDailySpike(cfg, today, budget));
  if (cfg.enabled.goal_off_track && ins) {
    await step("goal", async () => {
      const i = ins!;
      const goals = (await listGoals()).sort(fundingOrder);
      if (!goals.length) return;
      // El ahorro proyectado del mes es uno solo: se reparte entre las metas en orden de prioridad para no contar dos veces el mismo dinero.
      let available = i.isCurrent && i.income > 0 && i.elapsedDays >= PACE_PROJECTION_MIN_DAY ? i.income - i.projected : null;
      for (const goal of goals) {
        const p = goalProgress(goal, today, i.income);
        await emit(cfg, budget, goalCandidate({ id: goal.id, name: goal.name, remaining: p.remaining, perMonth: p.perMonth, done: p.done, overdue: p.overdue, daysLeft: p.daysLeft, projectedSaving: available, today }, cfg));
        if (available !== null && !p.done && !p.overdue) available = Math.max(0, available - p.perMonth);
      }
    });
  }
  if (cfg.enabled.unconfirmed) await step("unconfirmed", () => checkUnconfirmed(cfg, now, budget));
  return budget.created;
}

/**
 * Corre las alertas periódicas a lo más cada 15 min y reintenta los avisos pendientes de Telegram. La "reserva" del turno es una sola sentencia atómica sobre
 * app_settings: dos llamadas simultáneas (o dos instancias) no corren a la vez. Nunca lanza.
 */
export async function maybeRunPeriodicAlerts(now: Date = new Date()): Promise<void> {
  try {
    await runPeriodicIfDue(now);
  } catch (e) {
    warn("maybeRunPeriodicAlerts", e);
  }
  // Reintenta lo pendiente de Telegram (fallidos, retenidos por horas de silencio) aunque esta corrida no tocara las reglas.
  await flushTelegram(now);
}

async function runPeriodicIfDue(now: Date): Promise<void> {
  const params = { k: t.varchar(LAST_RUN_KEY), v: t.str(String(now.getTime())), thr: t.big(now.getTime() - PERIODIC_MIN_INTERVAL_MS) };
  const claimed = await query(
    `UPDATE dbo.app_settings SET value = @v, updated_at = SYSUTCDATETIME() OUTPUT INSERTED.[key]
     WHERE [key] = @k AND (TRY_CAST(value AS bigint) IS NULL OR TRY_CAST(value AS bigint) <= @thr)`,
    params,
  );
  if (!claimed.length) {
    if ((await query("SELECT 1 AS x FROM dbo.app_settings WHERE [key] = @k", { k: params.k })).length) return; // corrió hace poco
    try {
      await query("INSERT dbo.app_settings ([key], value) VALUES (@k, @v)", { k: params.k, v: params.v });
    } catch (e) {
      if (isUniqueViolation(e)) return; // otro proceso la reservó primero
      throw e;
    }
  }
  await evaluatePeriodicAlerts(now);
}

// ── Lectura y estado ────────────────────────────────────────────────────────────

type DbAlert = {
  id: number; rule: string; severity: AlertRow["severity"]; title: string; body: string; dedupe_key: string; tx_id: number | null;
  document_id: number | null; data: string | null; created_at: Date; read_at: Date | null; dismissed_at: Date | null;
};

function mapAlert(r: DbAlert): AlertRow {
  let data: Record<string, unknown> | null = null;
  if (r.data) {
    try {
      const j = JSON.parse(r.data);
      data = j && typeof j === "object" && !Array.isArray(j) ? j : null;
    } catch {
      data = null;
    }
  }
  return {
    id: Number(r.id), rule: r.rule, severity: r.severity, title: r.title, body: r.body, dedupeKey: r.dedupe_key,
    txId: r.tx_id === null ? null : Number(r.tx_id), documentId: r.document_id === null ? null : Number(r.document_id), data,
    createdAt: r.created_at.toISOString(), readAt: r.read_at ? r.read_at.toISOString() : null, dismissedAt: r.dismissed_at ? r.dismissed_at.toISOString() : null,
  };
}

/** Las más recientes primero. Por defecto sin las descartadas. */
export async function listAlerts(opts: { includeDismissed?: boolean; limit?: number } = {}): Promise<AlertRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50) || 50, 1), 200);
  const rows = await query<DbAlert>(
    `SELECT TOP (@lim) id, [rule] AS [rule], severity, title, body, dedupe_key, tx_id, document_id, data, created_at, read_at, dismissed_at
     FROM dbo.alerts ${opts.includeDismissed ? "" : "WHERE dismissed_at IS NULL"} ORDER BY created_at DESC, id DESC`,
    { lim: t.int(limit) },
  );
  return rows.map(mapAlert);
}

export async function unreadAlertCount(): Promise<number> {
  const r = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.alerts WHERE read_at IS NULL AND dismissed_at IS NULL");
  return Number(r[0].n);
}

export async function markAlertRead(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return (await query("UPDATE dbo.alerts SET read_at = COALESCE(read_at, SYSUTCDATETIME()) OUTPUT INSERTED.id WHERE id=@id", { id: t.big(id) })).length > 0;
}

export async function markAllRead(): Promise<number> {
  return (await query("UPDATE dbo.alerts SET read_at = SYSUTCDATETIME() OUTPUT INSERTED.id WHERE read_at IS NULL AND dismissed_at IS NULL")).length;
}

/** Descarta (y marca leída). La fila se conserva: la misma `dedupe_key` no vuelve a aparecer. */
export async function dismissAlert(id: number): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return (
    await query(
      "UPDATE dbo.alerts SET dismissed_at = COALESCE(dismissed_at, SYSUTCDATETIME()), read_at = COALESCE(read_at, SYSUTCDATETIME()) OUTPUT INSERTED.id WHERE id=@id",
      { id: t.big(id) },
    )
  ).length > 0;
}
