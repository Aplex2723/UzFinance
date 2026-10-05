import type { Categorizer } from "@/lib/categorizer";
import { query, t } from "@/lib/db/pool";
import {
  cardMapSchema, docSchema, importStatements, pickTarget,
  type CardMap, type ImportReport, type StatementDoc,
} from "@/lib/import/statements";
import { isCharge, isPayment, reconcile } from "@/lib/recon/engine";
import type { AppRow, ReconFinding, ReconResult, Severity } from "@/lib/recon/types";
import { clip, shiftDay } from "@/lib/recon/util";
import { localDate } from "@/lib/time";
import type { Card } from "@/lib/types";
import { listCards } from "./cards";

/**
 * Conciliación de estados de cuenta contra lo registrado en la app (persistencia).
 * El motor (src/lib/recon) es puro; aquí solo se agrupa por tarjeta, se leen filas y se guardan corridas y hallazgos.
 * NUNCA modifica ni borra movimientos: todo cambio lo decide una persona (importMissing solo AGREGA lo elegido).
 */

const MAP_KEY = "statement_card_map";

export type FindingStatus = "open" | "resolved" | "dismissed";
export type FindingRow = {
  id: number;
  runId: number;
  documentId: number | null;
  runLabel: string | null;
  fingerprint: string;
  kind: string;
  severity: Severity;
  txId: number | null;
  otherTxId: number | null;
  stmtDate: string | null;
  stmtAmountCents: number | null;
  stmtMerchant: string | null;
  stmtType: string | null;
  message: string;
  detail: Record<string, unknown> | null;
  status: FindingStatus;
  resolvedAt: string | null;
  createdAt: string;
};
export type ReconRunSummary = {
  runId: number;
  cardId: number | null;
  label: string;
  periodStart: string;
  periodEnd: string;
  statementCents: number;
  appCents: number;
  statementCount: number;
  appCount: number;
  matched: number;
  /** false si algún check del documento falló (los datos del PDF no son confiables). */
  trusted: boolean;
  findings: number;
  open: number;
  high: number;
  warn: number;
};
export type ReconRunDetail = ReconRunSummary & { documentId: number; createdAt: string; findingList: FindingRow[] };

// --- Mapa de tarjetas de los estados (app_settings) ---

export async function getStatementCardMap(): Promise<CardMap | null> {
  const rows = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key] = @k", { k: t.varchar(MAP_KEY) });
  if (!rows[0]) return null;
  try {
    const parsed = cardMapSchema.safeParse(JSON.parse(rows[0].value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function setStatementCardMap(m: CardMap): Promise<void> {
  const valid = cardMapSchema.parse(m);
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(MAP_KEY), v: t.str(JSON.stringify(valid)) },
  );
}

/** card_key del documento que faltan en el mapa. */
export function unmappedCardKeys(doc: Pick<StatementDoc, "card_key">, map: CardMap | null): string[] {
  return map && map[doc.card_key] ? [] : [doc.card_key];
}

// --- Análisis (sin escribir nada) ---

type Group = {
  card: Card;
  /** Índices en doc.transactions de las líneas que van a esta tarjeta. */
  indices: number[];
  result: ReconResult;
  rows: Map<number, AppRow>;
};

const targetName = (spec: ReturnType<typeof pickTarget>) => (typeof spec === "string" ? spec : spec.name);

async function loadRows(cardId: number, lo: string, hi: string): Promise<AppRow[]> {
  const rows = await query<{ id: number; d: string; cents: number; merchant_raw: string; source: string; plan_id: number | null; occurred_at: Date; kind: "expense" | "card_payment" }>(
    `SELECT CAST(id AS float) AS id, CONVERT(char(10), occurred_date, 23) AS d, CAST(amount_cents AS float) AS cents, merchant_raw, source, plan_id, occurred_at, kind
     FROM dbo.transactions
     WHERE occurred_date BETWEEN @lo AND @hi AND ((kind = 'expense' AND card_id = @c) OR kind = 'card_payment')
     ORDER BY id`,
    { lo: t.date(lo), hi: t.date(hi), c: t.int(cardId) },
  );
  return rows.map((r) => ({
    id: Number(r.id), date: r.d, cents: Number(r.cents), kind: r.kind, merchant: r.merchant_raw, source: r.source,
    planId: r.plan_id === null ? null : Number(r.plan_id), occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : null,
  }));
}

/** Agrupa los movimientos por tarjeta destino y corre el motor por tarjeta. Falla (sin escribir) si una tarjeta destino no existe. */
async function analyze(doc: StatementDoc, map: CardMap, now: Date): Promise<Group[]> {
  const today = localDate(now);
  const cards = await listCards(true);
  const byName = new Map<string, number[]>();
  const comparable = new Map<string, boolean>();
  doc.transactions.forEach((tx, i) => {
    const name = targetName(pickTarget(map, doc.card_key, tx));
    byName.set(name, [...(byName.get(name) ?? []), i]);
    if (isCharge(tx.type) || isPayment(tx.type)) comparable.set(name, true);
  });
  if (!byName.size) byName.set(targetName(pickTarget(map, doc.card_key, {})), []);

  const resolved: { card: Card; indices: number[] }[] = [];
  for (const [name, indices] of byName) {
    const card = cards.find((c) => c.name === name);
    if (card) resolved.push({ card, indices });
    else if (comparable.get(name)) throw new Error(`La tarjeta "${name}" no existe en la app y el mapa de tarjetas apunta a ella: créala antes de conciliar.`);
    // Solo líneas ignorables (mensualidades, traspasos…) hacia una tarjeta inexistente: nada que conciliar.
  }
  const out: Group[] = [];
  for (const { card, indices } of resolved) {
    const txs = indices.map((i) => doc.transactions[i]);
    const dates = txs.map((x) => x.date).sort();
    const lo = shiftDay([doc.period.start, dates[0] ?? doc.period.start].sort()[0], -8);
    const hi = shiftDay([doc.period.end, dates.at(-1) ?? doc.period.end].sort().at(-1)!, 8);
    const appRows = await loadRows(card.id, lo, hi);
    const result = reconcile({ doc: { period: doc.period, transactions: txs, checks: doc.checks }, appRows, today });
    // El motor numera dentro de la tarjeta; se devuelve a la numeración del documento completo (importMissing la usa).
    for (const f of result.findings) if (typeof f.detail.lineIndex === "number") f.detail.lineIndex = indices[f.detail.lineIndex];
    result.matches = result.matches.map((m) => ({ ...m, lineIndex: indices[m.lineIndex] }));
    out.push({ card, indices, result, rows: new Map(appRows.map((r) => [r.id, r])) });
  }
  return out;
}

// --- Persistencia ---

type DbFinding = { id: number; fingerprint: string; status: FindingStatus; detail: string | null; run_id: number };

const parseDetail = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try { const v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch { return null; }
};

async function persistGroup(documentId: number, doc: StatementDoc, g: Group, now: Date): Promise<ReconRunSummary> {
  const { card, result } = g;
  const s = result.summary;
  const label = clip(card.name, 120);
  const p = { start: t.date(doc.period.start), end: t.date(doc.period.end), card: t.int(card.id) };

  // Misma tarjeta + periodo: la corrida anterior (de este u otro PDF del mismo estado) se REEMPLAZA, conservando el estado por fingerprint.
  const existingRuns = await query<{ id: number }>(
    "SELECT id FROM dbo.recon_runs WHERE card_id = @card AND period_start = @start AND period_end = @end ORDER BY id",
    p,
  );
  const runFields = {
    doc: t.int(documentId), label: t.str(label), sc: t.big(s.statementCents), ac: t.big(s.appCents),
    sn: t.int(s.statementCount), an: t.int(s.appCount), m: t.int(s.matched), at: t.dt(now),
  };
  let runId: number;
  let previous: DbFinding[] = [];
  if (existingRuns.length) {
    runId = existingRuns[0].id;
    const ids = existingRuns.map((r) => r.id);
    previous = await query<DbFinding>(
      `SELECT CAST(id AS float) AS id, fingerprint, status, detail, run_id FROM dbo.recon_findings WHERE run_id IN (${ids.map((_, i) => `@r${i}`).join(",")}) ORDER BY CASE WHEN run_id = @main THEN 1 ELSE 0 END, id`,
      { ...Object.fromEntries(ids.map((id, i) => [`r${i}`, t.int(id)])), main: t.int(runId) },
    );
    await query(
      `UPDATE dbo.recon_runs SET document_id=@doc, label=@label, statement_cents=@sc, app_cents=@ac, statement_count=@sn, app_count=@an, matched=@m, created_at=@at WHERE id=@id`,
      { ...runFields, id: t.int(runId) },
    );
    // Corridas duplicadas (no deberían existir): se funden en la primera; su estado ya se leyó arriba.
    for (const extra of existingRuns.slice(1)) await query("DELETE dbo.recon_runs WHERE id = @id", { id: t.int(extra.id) });
  } else {
    const r = await query<{ id: number }>(
      `INSERT dbo.recon_runs (document_id, card_id, label, period_start, period_end, statement_cents, app_cents, statement_count, app_count, matched, created_at)
       OUTPUT INSERTED.id VALUES (@doc, @card, @label, @start, @end, @sc, @ac, @sn, @an, @m, @at)`,
      { ...runFields, ...p },
    );
    runId = r[0].id;
  }
  // Si había varias corridas, se prefiere el estado de la principal (ordenadas al final).
  const prev = new Map<string, DbFinding>();
  for (const f of previous) prev.set(f.fingerprint, f);
  // Los hallazgos de las corridas duplicadas pasaron a la principal por cascada de borrado: solo cuentan los de la principal.
  const mine = new Map(previous.filter((f) => f.run_id === runId).map((f) => [f.fingerprint, f]));

  const seen = new Set<string>();
  for (const f of result.findings) {
    seen.add(f.fingerprint);
    const old = mine.get(f.fingerprint);
    const fromDup = prev.get(f.fingerprint);
    let status: FindingStatus = "open";
    let resolvedAt: Date | null = null;
    const carry = old ?? fromDup;
    if (carry) {
      const auto = parseDetail(carry.detail)?.autoResolved === true;
      if (carry.status === "dismissed" || (carry.status === "resolved" && !auto)) { status = carry.status; resolvedAt = now; }
    }
    if (old) await updateFinding(old.id, f, status, resolvedAt);
    else await insertFinding(runId, f, status, resolvedAt);
  }
  // Lo que dejó de aplicar pasa a resuelto solo (y se reabre si vuelve a aparecer); lo descartado o resuelto a mano no se toca.
  for (const old of mine.values()) {
    if (seen.has(old.fingerprint) || old.status !== "open") continue;
    const d = { ...(parseDetail(old.detail) ?? {}), autoResolved: true };
    await query("UPDATE dbo.recon_findings SET status='resolved', resolved_at=@at, detail=@d WHERE id=@id", { id: t.big(old.id), at: t.dt(now), d: t.str(JSON.stringify(d)) });
  }

  const counts = await query<{ n: number; n_open: number; n_high: number; n_warn: number }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS n_open,
            SUM(CASE WHEN status='open' AND severity='high' THEN 1 ELSE 0 END) AS n_high,
            SUM(CASE WHEN status='open' AND severity='warn' THEN 1 ELSE 0 END) AS n_warn
     FROM dbo.recon_findings WHERE run_id = @r`,
    { r: t.int(runId) },
  );
  return {
    runId, cardId: card.id, label, periodStart: doc.period.start, periodEnd: doc.period.end,
    statementCents: s.statementCents, appCents: s.appCents, statementCount: s.statementCount, appCount: s.appCount, matched: s.matched,
    trusted: result.trusted, findings: counts[0].n, open: counts[0].n_open ?? 0, high: counts[0].n_high ?? 0, warn: counts[0].n_warn ?? 0,
  };
}

const findingParams = (f: ReconFinding) => ({
  kind: t.varchar(f.kind), sev: t.varchar(f.severity), tx: t.big(f.txId), otx: t.big(f.otherTxId), sd: t.date(f.stmtDate),
  sa: t.big(f.stmtAmountCents), sm: t.str(f.stmtMerchant === null ? null : clip(f.stmtMerchant, 200)), st: t.varchar(f.stmtType === null ? null : clip(f.stmtType, 30)),
  msg: t.str(clip(f.message, 500)), det: t.str(JSON.stringify(f.detail)),
});

async function insertFinding(runId: number, f: ReconFinding, status: FindingStatus, resolvedAt: Date | null) {
  await query(
    `INSERT dbo.recon_findings (run_id, fingerprint, kind, severity, tx_id, other_tx_id, stmt_date, stmt_amount_cents, stmt_merchant, stmt_type, message, detail, status, resolved_at)
     VALUES (@run, @fp, @kind, @sev, @tx, @otx, @sd, @sa, @sm, @st, @msg, @det, @status, CASE WHEN @status = 'open' THEN NULL ELSE @ra END)`,
    { ...findingParams(f), run: t.int(runId), fp: t.varchar(f.fingerprint), status: t.varchar(status), ra: t.dt(resolvedAt ?? new Date()) },
  );
}

async function updateFinding(id: number, f: ReconFinding, status: FindingStatus, resolvedAt: Date | null) {
  await query(
    `UPDATE dbo.recon_findings SET kind=@kind, severity=@sev, tx_id=@tx, other_tx_id=@otx, stmt_date=@sd, stmt_amount_cents=@sa, stmt_merchant=@sm, stmt_type=@st,
       message=@msg, detail=@det, status=@status,
       resolved_at = CASE WHEN @status = 'open' THEN NULL WHEN status = @status AND resolved_at IS NOT NULL THEN resolved_at ELSE @ra END
     WHERE id=@id`,
    { ...findingParams(f), id: t.big(id), status: t.varchar(status), ra: t.dt(resolvedAt ?? new Date()) },
  );
}

/**
 * Concilia UN estado (documento) contra la app. Una corrida por tarjeta destino (un estado de Amex con adicionales → varias).
 * Reemplaza solo la corrida de esa tarjeta+periodo (otros estados del mismo documento no se tocan) y es idempotente.
 * No crea tarjetas: si el destino no existe lanza un error claro antes de escribir.
 */
export async function reconcileDocument(
  documentId: number,
  doc: StatementDoc,
  map: CardMap,
  now: Date = new Date(),
): Promise<{ runs: ReconRunSummary[]; openFindings: number; highFindings: number }> {
  const groups = await analyze(doc, map, now);
  const runs: ReconRunSummary[] = [];
  for (const g of groups) runs.push(await persistGroup(documentId, doc, g, now));
  // TODO(integración): alerta cuando highFindings > 0 (createAlert) o cuando hay hallazgos abiertos nuevos.
  return { runs, openFindings: runs.reduce((a, r) => a + r.open, 0), highFindings: runs.reduce((a, r) => a + r.high, 0) };
}

// --- Lectura ---

type DbFindingFull = {
  id: number; run_id: number; fingerprint: string; kind: string; severity: Severity; tx_id: number | null; other_tx_id: number | null; d: string | null;
  stmt_amount_cents: number | null; stmt_merchant: string | null; stmt_type: string | null; message: string; detail: string | null; status: FindingStatus;
  resolved_at: Date | null; created_at: Date; document_id: number | null; label: string | null;
};
const FINDING_SELECT = `
  SELECT CAST(f.id AS float) AS id, f.run_id, f.fingerprint, f.kind, f.severity, CAST(f.tx_id AS float) AS tx_id, CAST(f.other_tx_id AS float) AS other_tx_id,
         CONVERT(char(10), f.stmt_date, 23) AS d, CAST(f.stmt_amount_cents AS float) AS stmt_amount_cents, f.stmt_merchant, f.stmt_type, f.message, f.detail,
         f.status, f.resolved_at, f.created_at, r.document_id, r.label
  FROM dbo.recon_findings f JOIN dbo.recon_runs r ON r.id = f.run_id`;
const SEV_SORT = "CASE f.severity WHEN 'high' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END";
const num = (v: number | null) => (v === null || v === undefined ? null : Number(v));
const mapFinding = (r: DbFindingFull): FindingRow => ({
  id: Number(r.id), runId: r.run_id, documentId: r.document_id, runLabel: r.label, fingerprint: r.fingerprint, kind: r.kind, severity: r.severity,
  txId: num(r.tx_id), otherTxId: num(r.other_tx_id), stmtDate: r.d, stmtAmountCents: num(r.stmt_amount_cents), stmtMerchant: r.stmt_merchant, stmtType: r.stmt_type,
  message: r.message, detail: parseDetail(r.detail), status: r.status, resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null, createdAt: r.created_at.toISOString(),
});

export async function listRuns(documentId: number): Promise<ReconRunDetail[]> {
  const runs = await query<{ id: number; card_id: number | null; label: string; d1: string; d2: string; sc: number; ac: number; sn: number; an: number; m: number; created_at: Date }>(
    `SELECT id, card_id, label, CONVERT(char(10), period_start, 23) AS d1, CONVERT(char(10), period_end, 23) AS d2, CAST(statement_cents AS float) AS sc, CAST(app_cents AS float) AS ac,
            statement_count AS sn, app_count AS an, matched AS m, created_at
     FROM dbo.recon_runs WHERE document_id = @d ORDER BY period_start, id`,
    { d: t.int(documentId) },
  );
  if (!runs.length) return [];
  const rows = await query<DbFindingFull>(`${FINDING_SELECT} WHERE r.document_id = @d ORDER BY ${SEV_SORT}, f.id`, { d: t.int(documentId) });
  const all = rows.map(mapFinding);
  return runs.map((r) => {
    const list = all.filter((f) => f.runId === r.id);
    const open = list.filter((f) => f.status === "open");
    return {
      runId: r.id, documentId, cardId: r.card_id, label: r.label, periodStart: r.d1, periodEnd: r.d2, statementCents: Number(r.sc), appCents: Number(r.ac),
      statementCount: r.sn, appCount: r.an, matched: r.m, createdAt: r.created_at.toISOString(),
      trusted: !list.some((f) => f.kind === "extraction_check_failed"), findings: list.length, open: open.length,
      high: open.filter((f) => f.severity === "high").length, warn: open.filter((f) => f.severity === "warn").length, findingList: list,
    };
  });
}

export async function listOpenFindings(limit = 100): Promise<FindingRow[]> {
  const rows = await query<DbFindingFull>(
    `${FINDING_SELECT} WHERE f.status = 'open' ORDER BY ${SEV_SORT}, f.created_at DESC, f.id DESC OFFSET 0 ROWS FETCH NEXT @lim ROWS ONLY`,
    { lim: t.int(Math.min(Math.max(Math.trunc(limit) || 1, 1), 500)) },
  );
  return rows.map(mapFinding);
}

/** Cambio manual de estado (descartar / marcar resuelto / reabrir). Una decisión manual no se revierte sola al reconciliar de nuevo. */
export async function setFindingStatus(id: number, status: FindingStatus): Promise<boolean> {
  if (!["open", "resolved", "dismissed"].includes(status)) throw new RangeError("estado inválido");
  const r = await query(
    `UPDATE dbo.recon_findings SET status = @s,
       resolved_at = CASE WHEN @s = 'open' THEN NULL ELSE SYSUTCDATETIME() END,
       detail = CASE WHEN ISJSON(detail) = 1 THEN JSON_MODIFY(detail, '$.autoResolved', NULL) ELSE detail END
     OUTPUT INSERTED.id WHERE id = @id`,
    { id: t.big(id), s: t.varchar(status) },
  );
  return r.length > 0;
}

// --- Importar lo que falta ---

/** El mapa sin la opción de crear tarjetas: importMissing solo escribe en tarjetas que ya existen. */
function withoutCreate(map: CardMap): CardMap {
  const strip = <T extends string | { name: string }>(x: T) => (typeof x === "string" ? x : x.name);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, {
    default: strip(v.default),
    ...(v.sections ? { sections: Object.fromEntries(Object.entries(v.sections).map(([a, b]) => [a, strip(b)])) } : {}),
    ...(v.holders ? { holders: Object.fromEntries(Object.entries(v.holders).map(([a, b]) => [a, strip(b)])) } : {}),
    ...(v.domiciliation ? { domiciliation: strip(v.domiciliation) } : {}),
  }])) as CardMap;
}

async function readStatements(documentId: number): Promise<StatementDoc[]> {
  const r = await query<{ extracted: string | null }>("SELECT extracted FROM dbo.documents WHERE id = @id", { id: t.int(documentId) });
  if (!r.length) throw new Error(`El documento ${documentId} no existe`);
  if (!r[0].extracted) throw new Error(`El documento ${documentId} no tiene datos extraídos`);
  let raw: unknown;
  try { raw = JSON.parse(r[0].extracted); } catch { throw new Error(`Los datos extraídos del documento ${documentId} no son JSON válido`); }
  const list = (raw as { statements?: unknown } | null)?.statements;
  if (!Array.isArray(list)) throw new Error(`El documento ${documentId} no trae estados de cuenta ("statements")`);
  return list.map((s, i) => {
    const p = docSchema.safeParse(s);
    if (!p.success) throw new Error(`El estado ${i + 1} del documento ${documentId} no es válido: ${p.error.issues[0]?.message ?? "formato"}`);
    return p.data;
  });
}

/**
 * Importa SOLO las compras `missing_in_app` abiertas (todas o las de `findingIds`) de los estados del documento, reutilizando
 * importStatements() (idempotente) con un documento filtrado, y concilia de nuevo (los hallazgos que quedaron cubiertos pasan a resolved).
 * Se niega si algún check del estado falló (datos no confiables). Nunca crea tarjetas ni toca movimientos existentes.
 * `existing` del reporte no cuenta las líneas de contexto (ver abajo).
 */
export async function importMissing(
  documentId: number,
  opts: { categorizer: Categorizer; findingIds?: number[]; dryRun?: boolean },
): Promise<ImportReport> {
  const statements = await readStatements(documentId);
  const map = await getStatementCardMap();
  if (!map) throw new Error("Falta el mapa de tarjetas de los estados de cuenta");
  const safeMap = withoutCreate(map);
  const now = new Date();
  const report: ImportReport = { docs: [], cardsCreated: [], byCategory: {}, warnings: [] };
  const wanted = opts.findingIds ? new Set(opts.findingIds) : null;
  let found = 0;

  for (const doc of statements) {
    const failed = (doc.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
    if (failed.length) { report.warnings.push(`${doc.document}: no se importa, la extracción no es confiable (${failed.join(", ")})`); continue; }
    const groups = await analyze(doc, map, now);
    const chosen = new Map<number, StatementDoc["transactions"][number]>(); // índice → línea
    const context = new Map<number, StatementDoc["transactions"][number]>();
    for (const g of groups) {
      const run = await query<{ id: number }>(
        "SELECT id FROM dbo.recon_runs WHERE document_id=@d AND card_id=@c AND period_start=@s AND period_end=@e",
        { d: t.int(documentId), c: t.int(g.card.id), s: t.date(doc.period.start), e: t.date(doc.period.end) },
      );
      if (!run.length) { report.warnings.push(`${doc.document}: ${g.card.name} no se ha conciliado todavía`); continue; }
      const open = await query<{ id: number; fingerprint: string }>(
        "SELECT CAST(id AS float) AS id, fingerprint FROM dbo.recon_findings WHERE run_id=@r AND kind='missing_in_app' AND status='open'",
        { r: t.int(run[0].id) },
      );
      const fresh = new Map(g.result.findings.filter((f) => f.kind === "missing_in_app" && f.detail.importable === true).map((f) => [f.fingerprint, f]));
      const picked = open.filter((f) => (!wanted || wanted.has(Number(f.id))) && fresh.has(f.fingerprint));
      found += picked.length;
      const selected = picked.map((f) => doc.transactions[fresh.get(f.fingerprint)!.detail.lineIndex as number]);
      const selectedIdx = picked.map((f) => fresh.get(f.fingerprint)!.detail.lineIndex as number);
      selectedIdx.forEach((i) => chosen.set(i, doc.transactions[i]));
      // Contexto: las líneas ya conciliadas del mismo monto y cercanas, con la fecha de SU fila de la app. El importador compara por
      // conteo (±2 días): sin ellas, una compra repetida legítima vería la fila de la otra y se daría por existente.
      for (const m of g.result.matches) {
        const line = doc.transactions[m.lineIndex];
        const row = g.rows.get(m.rowId);
        if (!row || chosen.has(m.lineIndex)) continue;
        if (selected.some((s) => s.amount_cents === line.amount_cents && Math.abs(Date.parse(`${s.date}T00:00:00Z`) - Date.parse(`${row.date}T00:00:00Z`)) <= 2 * 86_400_000)) {
          context.set(m.lineIndex, { ...line, date: row.date });
        }
      }
    }
    if (!chosen.size) continue;
    const filtered: StatementDoc = { ...doc, transactions: [...chosen.values(), ...context.values()], plans: [] };
    const rep = await importStatements([filtered], safeMap, { categorizer: opts.categorizer, dryRun: opts.dryRun });
    for (const st of rep.docs) st.existing = Math.max(0, st.existing - context.size);
    report.docs.push(...rep.docs);
    report.warnings.push(...rep.warnings);
    report.cardsCreated.push(...rep.cardsCreated);
    report.byCategory = rep.byCategory;
    if (!opts.dryRun) await reconcileDocument(documentId, doc, map, now);
  }
  if (wanted && found < wanted.size) report.warnings.push(`${wanted.size - found} hallazgo(s) elegido(s) no se importan: no son compras faltantes abiertas de este documento`);
  return report;
}
