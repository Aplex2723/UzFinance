import { formatMXN } from "@/lib/money";
import { localDate } from "@/lib/time";
import { matchByKey } from "./match";
import {
  THRESHOLDS as T,
  type AppRow,
  type FindingKind,
  type ReconDoc,
  type ReconFinding,
  type ReconMatch,
  type ReconResult,
  type ReconSummary,
  type Severity,
  type StmtLine,
} from "./types";
import { clip, dayDiff, fingerprint, merchantKey, plain, shiftDay, similarity, type MerchantKey } from "./util";

/**
 * Motor de conciliación (puro, determinista, sin base de datos ni LLM): compara los movimientos de UN estado de cuenta
 * (ya agrupados por tarjeta destino) contra las filas registradas en la app de esa tarjeta.
 *
 * Principios: precisión > cobertura; ante la duda se reporta un hallazgo para revisión humana; nunca se corrige nada solo.
 * Reglas: ver comentarios de cada paso y tests/unit/recon-*.test.ts.
 */

/** Tipos del estado que se comparan contra gastos de la app. */
export const CHARGE_TYPES = ["purchase", "fee", "interest", "tax", "cash_withdrawal", "transfer_out", "refund"] as const;
/** Pagos a la tarjeta: se comparan contra `card_payment` y su falta es solo informativa. */
export const PAYMENT_TYPES = ["payment", "domiciliation_card_payment"] as const;
export const isCharge = (t: string) => (CHARGE_TYPES as readonly string[]).includes(t);
export const isPayment = (t: string) => (PAYMENT_TYPES as readonly string[]).includes(t);

const TYPE_LABEL: Record<string, string> = {
  purchase: "una compra", fee: "una comisión", interest: "un interés", tax: "un impuesto",
  cash_withdrawal: "un retiro de efectivo", transfer_out: "una transferencia", refund: "un reembolso",
};
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fmtDate = (d: string) => { const [y, m, day] = d.split("-").map(Number); return `${day} ${MONTHS[m - 1] ?? "?"} ${y}`; };
const money = (c: number) => formatMXN(c);
const SEV_ORDER: Record<Severity, number> = { high: 0, warn: 1, info: 2 };
const KIND_ORDER: Record<FindingKind, number> = { extraction_check_failed: 0, duplicate_suspect: 1, amount_mismatch: 2, missing_in_app: 3, not_in_statement: 4, total_mismatch: 5 };

type Line = { idx: number; tx: StmtLine; date: string; cents: number; mk: MerchantKey; occ: number };
type Row = AppRow & { mk: MerchantKey };

export type ReconInput = { doc: ReconDoc; appRows: AppRow[]; today?: string };

export function reconcile(input: ReconInput): ReconResult {
  const { doc } = input;
  const today = input.today ?? localDate(new Date());
  const { start, end } = doc.period;
  const periodDays = dayDiff(start, end) + 1;
  const tailDays = Math.min(T.tailDays, Math.max(0, periodDays - 1));
  const tailStart = shiftDay(end, -tailDays); // fechas > tailStart (hasta end): "cola", aún pudieron no postearse
  const leadStart = shiftDay(start, -T.leadDays);
  const inPeriod = (d: string) => d >= start && d <= end;
  /** inside: periodo sin la cola · tail: últimos días · boundary: pocos días antes del inicio (¿estado previo?) · out: fuera. */
  const zone = (d: string): "inside" | "tail" | "boundary" | "out" =>
    d > end || d < leadStart ? "out" : d < start ? "boundary" : d > tailStart ? "tail" : "inside";

  const failedChecks = (doc.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
  const trusted = failedChecks.length === 0;

  // --- Qué líneas del estado cuentan ---
  const ignored: Record<string, number> = {};
  const bump = (k: string) => { ignored[k] = (ignored[k] ?? 0) + 1; };
  const charges: Line[] = [];
  const payments: Line[] = [];
  const installments: Line[] = [];
  const occSeen = new Map<string, number>();
  let installmentCount = 0;
  let installmentCents = 0;
  doc.transactions.forEach((tx, idx) => {
    const mk = merchantKey(tx.merchant);
    const cents = tx.amount_cents;
    if (!Number.isSafeInteger(cents)) { bump("monto_invalido"); return; }
    if (tx.type === "installment") { installmentCount++; installmentCents += cents; }
    if (tx.type === "installment" || tx.type === "installment_credit") {
      bump(tx.type);
      if (tx.type === "installment" && cents !== 0) installments.push({ idx, tx, date: tx.date, cents, mk, occ: 0 });
      return;
    }
    if (cents === 0) { bump("monto_cero"); return; }
    if (!isCharge(tx.type) && !isPayment(tx.type)) { bump(tx.type); return; }
    const ok = `${isPayment(tx.type) ? "p" : "c"}|${tx.date}|${cents}|${mk.norm}`;
    const occ = occSeen.get(ok) ?? 0;
    occSeen.set(ok, occ + 1);
    (isPayment(tx.type) ? payments : charges).push({ idx, tx, date: tx.date, cents, mk, occ });
  });

  const rows: Row[] = [...input.appRows].sort((a, b) => a.id - b.id).map((r) => ({ ...r, mk: merchantKey(r.merchant) }));
  const expenseRows = rows.filter((r) => r.kind === "expense");
  const paymentRows = rows.filter((r) => r.kind === "card_payment");

  const findings: ReconFinding[] = [];
  const add = (f: Omit<ReconFinding, "message"> & { message: string }) => findings.push({ ...f, message: clip(f.message, 500) });
  const effects: number[] = []; // efecto de cada hallazgo sobre diffCents (ver abajo)

  // --- Emparejamiento uno a uno de cargos (mismo monto exacto; ±3 días) ---
  const pairs = matchByKey({
    lineKeys: charges.map((l) => l.cents), rowKeys: expenseRows.map((r) => r.cents),
    days: (i, j) => dayDiff(charges[i].date, expenseRows[j].date),
    sim: (i, j) => similarity(charges[i].mk, expenseRows[j].mk),
    maxDays: T.matchDays,
  });
  const lineToRow = new Map<number, number>(); // índice en charges → índice en expenseRows
  const rowMatched = new Set<number>();
  for (const [i, j] of pairs) { lineToRow.set(i, j); rowMatched.add(j); }

  // --- MSI: la compra a meses está completa en la app y el estado solo trae la mensualidad 1 ---
  const msiRows = new Set<number>(); // filas conciliadas por MSI
  const usedInstallment = new Set<number>();
  expenseRows.forEach((r, j) => {
    if (rowMatched.has(j) || r.cents <= 0) return;
    let best: { k: number; d: number; s: number } | undefined;
    for (let k = 0; k < installments.length; k++) {
      const l = installments[k];
      const total = l.tx.installment?.total ?? 0;
      if (usedInstallment.has(k) || l.tx.installment?.n !== 1 || total <= 1 || l.cents <= 0) continue;
      if (Math.abs(l.cents * total - r.cents) > total) continue;
      const d = dayDiff(l.date, r.date);
      const s = similarity(l.mk, r.mk);
      const ok = r.planId ? s >= 0.4 || d <= 7 : s >= 0.5 && d <= 7;
      if (!ok) continue;
      if (!best || d < best.d || (d === best.d && s > best.s)) best = { k, d, s };
    }
    if (best) { usedInstallment.add(best.k); msiRows.add(j); }
  });
  const planUnmatched = new Set<number>(); // compra a MSI sin equivalente en el estado: esperable, no es hallazgo
  expenseRows.forEach((r, j) => { if (r.planId && !rowMatched.has(j) && !msiRows.has(j)) planUnmatched.add(j); });

  const freeRows = () => expenseRows.map((_, j) => j).filter((j) => !rowMatched.has(j) && !msiRows.has(j) && !planUnmatched.has(j) && !claimed.has(j));
  const claimed = new Set<number>(); // filas ya usadas por un hallazgo (mismatch / duplicado)
  const siblingsOf = (j: number, only?: (k: number) => boolean) =>
    expenseRows.map((_, k) => k).filter((k) => k !== j && expenseRows[k].cents === expenseRows[j].cents && dayDiff(expenseRows[k].date, expenseRows[j].date) <= 1 && (only ? only(k) : true));

  // --- amount_mismatch: línea y fila sin pareja, misma tarjeta, ≤3 días, comercio parecido, monto distinto ---
  const freeLines = () => charges.map((_, i) => i).filter((i) => !lineToRow.has(i) && !mismatchLines.has(i));
  const mismatchLines = new Set<number>();
  {
    type Cand = { i: number; j: number; rel: number; score: number };
    const cands: Cand[] = [];
    for (const i of freeLines()) {
      for (const j of freeRows()) {
        const l = charges[i];
        const r = expenseRows[j];
        if (l.cents === r.cents || Math.sign(l.cents) !== Math.sign(r.cents)) continue;
        const d = dayDiff(l.date, r.date);
        if (d > T.matchDays) continue;
        const s = similarity(l.mk, r.mk);
        if (s < T.mismatchMinSimilarity) continue;
        const rel = Math.abs(l.cents - r.cents) / Math.max(Math.abs(l.cents), Math.abs(r.cents));
        if (rel > T.mismatchMaxRel) continue;
        cands.push({ i, j, rel, score: rel * 1000 + d * 10 - s });
      }
    }
    cands.sort((a, b) => a.score - b.score || a.i - b.i || a.j - b.j);
    for (const c of cands) {
      if (mismatchLines.has(c.i) || claimed.has(c.j)) continue;
      mismatchLines.add(c.i);
      claimed.add(c.j);
      const l = charges[c.i];
      const r = expenseRows[c.j];
      const diff = l.cents - r.cents;
      const foreign = !!l.tx.foreign;
      const tol = foreign ? T.mismatchExpectedRelForeign : T.mismatchExpectedRel;
      const sib = siblingsOf(c.j, (k) => rowMatched.has(k) || (!claimed.has(k) && !planUnmatched.has(k) && !msiRows.has(k)));
      const cause = foreign && c.rel <= T.mismatchExpectedRelForeign ? "fx" : Math.abs(diff) <= 100 ? "rounding" : Math.abs(l.cents) > Math.abs(r.cents) && c.rel > tol ? "tip" : "unknown";
      let severity: Severity = Math.abs(diff) >= T.mismatchHighCents || sib.length > 0 ? "high" : "warn";
      if (c.rel <= tol && !sib.length) severity = "warn";
      const causeText = { fx: "posible tipo de cambio", rounding: "posible redondeo", tip: "posible propina", unknown: "causa por revisar" }[cause];
      add({
        fingerprint: fingerprint("amount_mismatch", l.date, l.cents, l.mk.norm, l.occ, r.id),
        kind: "amount_mismatch", severity, txId: r.id, otherTxId: sib[0] !== undefined ? expenseRows[sib[0]].id : null,
        stmtDate: l.date, stmtAmountCents: l.cents, stmtMerchant: clip(l.tx.merchant, 200), stmtType: clip(l.tx.type, 30),
        message: `El estado cobró ${money(l.cents)} en "${plain(l.tx.merchant, 50)}" (${fmtDate(l.date)}) y la app tiene ${money(r.cents)}: diferencia de ${money(diff)} (${causeText}).${sib.length ? " Además hay otra fila idéntica en la app: revisa si no está duplicada." : ""} No se corrigió nada.`,
        detail: {
          lineIndex: l.idx, appId: r.id, statementCents: l.cents, appCents: r.cents, diffCents: diff, relDiff: Math.round(c.rel * 10000) / 10000,
          cause, foreign, statementDate: l.date, appDate: r.date, statementMerchant: clip(l.tx.merchant, 200), appMerchant: clip(r.merchant, 200),
          siblingIds: sib.map((k) => expenseRows[k].id),
        },
      });
      effects.push(l.cents - (inPeriod(r.date) ? r.cents : 0));
    }
  }

  // --- duplicate_suspect (con estado): más filas idénticas en la app que líneas en el estado ---
  const dupClusterRows = new Set<number>();
  {
    const cand = freeRows().filter((j) => zone(expenseRows[j].date) === "inside");
    const parent = new Map<number, number>();
    const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
    const touch = (x: number) => { if (!parent.has(x)) parent.set(x, x); };
    const eligibleSibling = (k: number) => rowMatched.has(k) || cand.includes(k);
    for (const j of cand) {
      for (const k of siblingsOf(j, eligibleSibling)) {
        touch(j); touch(k);
        const a = find(j); const b = find(k);
        if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
      }
    }
    const groups = new Map<number, number[]>();
    for (const x of [...parent.keys()].sort((a, b) => a - b)) { const g = find(x); const l = groups.get(g); if (l) l.push(x); else groups.set(g, [x]); }
    for (const members of groups.values()) {
      const extras = members.filter((k) => !rowMatched.has(k));
      if (!extras.length) continue;
      const matchedIn = members.filter((k) => rowMatched.has(k));
      const first = expenseRows[members[0]];
      const ids = members.map((k) => expenseRows[k].id).sort((a, b) => a - b);
      const extraIds = extras.map((k) => expenseRows[k].id).sort((a, b) => a - b);
      members.forEach((k) => dupClusterRows.add(k));
      extras.forEach((k) => claimed.add(k));
      add({
        fingerprint: fingerprint("duplicate_suspect", first.cents, ids.join(",")),
        kind: "duplicate_suspect", severity: trusted ? "high" : "warn", txId: extraIds[0], otherTxId: ids.find((i) => i !== extraIds[0]) ?? null,
        stmtDate: null, stmtAmountCents: first.cents, stmtMerchant: null, stmtType: null,
        message: `Hay ${members.length} registros de ${money(first.cents)} (${plain(first.merchant, 40)}, ${fmtDate(first.date)}) en la app pero el estado solo trae ${matchedIn.length}. Revisa cuál sobra (ids ${ids.join(", ")}); no se borró nada.`,
        detail: {
          reason: "more_rows_than_statement", appIds: ids, extraIds, statementCount: matchedIn.length, appCount: members.length, amountCents: first.cents,
          rows: members.map((k) => ({ id: expenseRows[k].id, date: expenseRows[k].date, source: expenseRows[k].source, merchant: clip(expenseRows[k].merchant, 200) })),
          untrusted: !trusted || undefined,
        },
      });
      effects.push(-extras.reduce((a, k) => a + (inPeriod(expenseRows[k].date) ? expenseRows[k].cents : 0), 0));
    }
  }

  // --- missing_in_app / not_in_statement ---
  const sevForMissing = (l: Line): Severity => {
    const abs = Math.abs(l.cents);
    if (abs >= T.highCents) return "high";
    if (abs >= T.recentBigCents && l.date <= today && dayDiff(l.date, today) <= T.recentDays) return "high";
    return ["fee", "interest", "tax"].includes(l.tx.type) ? "info" : "warn";
  };
  charges.forEach((l, i) => {
    if (lineToRow.has(i) || mismatchLines.has(i)) return;
    const importable = trusted;
    add({
      fingerprint: fingerprint("missing_in_app", l.tx.type, l.date, l.cents, l.mk.norm, l.occ),
      kind: "missing_in_app", severity: sevForMissing(l), txId: null, otherTxId: null,
      stmtDate: l.date, stmtAmountCents: l.cents, stmtMerchant: clip(l.tx.merchant, 200), stmtType: clip(l.tx.type, 30),
      message: `El estado trae ${TYPE_LABEL[l.tx.type] ?? "un cargo"} de ${money(Math.abs(l.cents))}${l.cents < 0 ? " a tu favor" : ""} en "${plain(l.tx.merchant, 50)}" (${fmtDate(l.date)}) que no está registrado en la app.`,
      detail: { lineIndex: l.idx, importable, type: l.tx.type, date: l.date, amountCents: l.cents, merchant: clip(l.tx.merchant, 200), occurrence: l.occ, foreign: !!l.tx.foreign, holder: l.tx.holder ?? null, section: l.tx.section ?? null, untrusted: !trusted || undefined },
    });
    effects.push(l.cents);
  });
  let tailCents = 0;
  for (const j of freeRows()) {
    const r = expenseRows[j];
    const z = zone(r.date);
    if (z === "tail") { tailCents += r.cents; continue; }
    if (z === "out") continue;
    const base: Severity = z === "boundary" ? "info" : Math.abs(r.cents) >= T.highCents ? "high" : "warn";
    add({
      fingerprint: fingerprint("not_in_statement", r.id),
      kind: "not_in_statement", severity: base, txId: r.id, otherTxId: null,
      stmtDate: null, stmtAmountCents: r.cents, stmtMerchant: clip(r.merchant, 200), stmtType: null,
      message: `La app tiene ${money(r.cents)} en "${plain(r.merchant, 50)}" (${fmtDate(r.date)}) que el estado no trae. ${z === "boundary" ? "Es de antes del inicio del periodo: podría pertenecer al estado anterior." : "Puede ser un duplicado, una tarjeta equivocada o un cargo que el banco no hizo."}`,
      detail: { appId: r.id, date: r.date, amountCents: r.cents, source: r.source, merchant: clip(r.merchant, 200), zone: z },
    });
    effects.push(inPeriod(r.date) ? -r.cents : 0);
  }

  // --- Pagos de tarjeta (±5 días; su falta es solo informativa) ---
  const payPairs = matchByKey({
    lineKeys: payments.map((l) => Math.abs(l.cents)), rowKeys: paymentRows.map((r) => Math.abs(r.cents)),
    days: (i, j) => dayDiff(payments[i].date, paymentRows[j].date), sim: () => 0, maxDays: T.paymentDays,
  });
  const payMatched = new Set(payPairs.map(([i]) => i));
  payments.forEach((l, i) => {
    if (payMatched.has(i)) return;
    add({
      fingerprint: fingerprint("missing_in_app", l.tx.type, l.date, Math.abs(l.cents), l.mk.norm, l.occ),
      kind: "missing_in_app", severity: "info", txId: null, otherTxId: null,
      stmtDate: l.date, stmtAmountCents: l.cents, stmtMerchant: clip(l.tx.merchant, 200), stmtType: clip(l.tx.type, 30),
      message: `El estado trae un pago a la tarjeta de ${money(Math.abs(l.cents))} (${fmtDate(l.date)}) que no está registrado en la app.`,
      detail: { lineIndex: l.idx, importable: false, type: l.tx.type, date: l.date, amountCents: l.cents, merchant: clip(l.tx.merchant, 200), occurrence: l.occ, payment: true },
    });
  });

  // --- duplicate_suspect (aun sin estado): misma tarjeta+monto+comercio, fuentes distintas, ≤10 min, sin fusionar ---
  {
    const parent = new Map<number, number>();
    const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
    for (let a = 0; a < expenseRows.length; a++) {
      for (let b = a + 1; b < expenseRows.length; b++) {
        const x = expenseRows[a]; const y = expenseRows[b];
        if (x.cents !== y.cents || !x.mk.norm || x.mk.norm !== y.mk.norm || x.source === y.source || !x.occurredAt || !y.occurredAt) continue;
        if (Math.abs(Date.parse(x.occurredAt) - Date.parse(y.occurredAt)) > T.dupMinutes * 60_000) continue;
        // Ambas conciliadas = el estado trae dos cargos: son compras repetidas legítimas. Las ya señaladas por otro hallazgo no se repiten.
        if ((rowMatched.has(a) && rowMatched.has(b)) || claimed.has(a) || claimed.has(b) || dupClusterRows.has(a) || dupClusterRows.has(b)) continue;
        if (!parent.has(a)) parent.set(a, a);
        if (!parent.has(b)) parent.set(b, b);
        const ra = find(a); const rb = find(b);
        if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
      }
    }
    const groups = new Map<number, number[]>();
    for (const x of [...parent.keys()].sort((p, q) => p - q)) { const g = find(x); const l = groups.get(g); if (l) l.push(x); else groups.set(g, [x]); }
    for (const members of groups.values()) {
      const ids = members.map((k) => expenseRows[k].id).sort((a, b) => a - b);
      const first = expenseRows[members[0]];
      add({
        fingerprint: fingerprint("duplicate_suspect", "close", first.cents, ids.join(",")),
        kind: "duplicate_suspect", severity: "high", txId: ids[0], otherTxId: ids[1] ?? null,
        stmtDate: null, stmtAmountCents: first.cents, stmtMerchant: null, stmtType: null,
        message: `Hay ${members.length} registros de ${money(first.cents)} en "${plain(first.merchant, 40)}" con minutos de diferencia y de fuentes distintas (${[...new Set(members.map((k) => expenseRows[k].source))].join(", ")}): probablemente el mismo cargo registrado dos veces (ids ${ids.join(", ")}). No se borró nada.`,
        detail: {
          reason: "close_in_time_different_sources", appIds: ids, amountCents: first.cents,
          rows: members.map((k) => ({ id: expenseRows[k].id, date: expenseRows[k].date, source: expenseRows[k].source, occurredAt: expenseRows[k].occurredAt ?? null })),
        },
      });
    }
  }

  // --- Resumen y total_mismatch ---
  const statementCents = charges.reduce((a, l) => a + l.cents, 0);
  const periodRows = expenseRows.filter((r) => inPeriod(r.date));
  const appCents = periodRows.reduce((a, r) => a + r.cents, 0);
  const diffCents = statementCents - appCents;
  const explainedByFindingsCents = effects.reduce((a, b) => a + b, 0);
  const msiCents = [...msiRows].reduce((a, j) => a + (inPeriod(expenseRows[j].date) ? expenseRows[j].cents : 0), 0)
    + [...planUnmatched].reduce((a, j) => a + (inPeriod(expenseRows[j].date) ? expenseRows[j].cents : 0), 0);
  const outsidePeriodMatchedCents = [...lineToRow.values()].reduce((a, j) => a + (inPeriod(expenseRows[j].date) ? 0 : expenseRows[j].cents), 0);
  // diff = Σ líneas − Σ filas del periodo = hallazgos + (parejas fuera del periodo − cola − MSI): lo que sobre es un error y se reporta high.
  const explainedByExpectedCents = outsidePeriodMatchedCents - tailCents - msiCents;
  const unexplainedCents = diffCents - explainedByFindingsCents - explainedByExpectedCents;

  // Solo si hay algo que contar: una diferencia que es puramente esperable (cola, MSI) no abre hallazgo.
  if ((diffCents !== 0 && effects.some((e) => e !== 0)) || unexplainedCents !== 0) {
    add({
      fingerprint: fingerprint("total_mismatch", diffCents, unexplainedCents),
      kind: "total_mismatch", severity: unexplainedCents !== 0 ? "high" : "info", txId: null, otherTxId: null,
      stmtDate: null, stmtAmountCents: statementCents, stmtMerchant: null, stmtType: null,
      message: unexplainedCents !== 0
        ? `El total del estado (${money(statementCents)}) y el de la app (${money(appCents)}) en el periodo difieren en ${money(diffCents)} y quedan ${money(unexplainedCents)} sin explicar tras los hallazgos.`
        : `El total del estado (${money(statementCents)}) y el de la app (${money(appCents)}) en el periodo difieren en ${money(diffCents)}; los hallazgos${explainedByExpectedCents ? " y lo esperable (cola del periodo, compras a meses)" : ""} explican toda la diferencia.`,
      detail: { statementCents, appCents, diffCents, explainedByFindingsCents, explainedByExpectedCents, unexplainedCents, tailCents, msiCents, outsidePeriodMatchedCents },
    });
  }

  if (!trusted) {
    add({
      fingerprint: fingerprint("extraction_check_failed", failedChecks.join(",")),
      kind: "extraction_check_failed", severity: "high", txId: null, otherTxId: null,
      stmtDate: null, stmtAmountCents: null, stmtMerchant: null, stmtType: null,
      message: `La verificación de extracción falló (${failedChecks.map((c) => plain(c, 40)).join(", ")}): los datos leídos del PDF no son confiables. No se ofrece importar; revisa el PDF a mano.`,
      detail: { failedChecks: failedChecks.map((c) => clip(c, 200)) },
    });
  }

  // Fingerprints únicos dentro de la corrida (restricción uq_finding): una colisión improbable recibe un sufijo estable.
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = seen.get(f.fingerprint) ?? 0;
    seen.set(f.fingerprint, n + 1);
    if (n) f.fingerprint = fingerprint(f.fingerprint, "dup", n);
  }
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.stmtDate ?? "").localeCompare(b.stmtDate ?? "") || a.fingerprint.localeCompare(b.fingerprint));

  const matches: ReconMatch[] = [...lineToRow].map(([i, j]) => ({ lineIndex: charges[i].idx, rowId: expenseRows[j].id })).sort((a, b) => a.lineIndex - b.lineIndex);
  const summary: ReconSummary = {
    statementCount: charges.length, statementCents, appCount: periodRows.length, appCents,
    matched: lineToRow.size + msiRows.size, msiMatched: msiRows.size,
    paymentsCount: payments.length, paymentsMatched: payMatched.size,
    installmentCount, installmentCents, ignored, msiUnmatched: planUnmatched.size,
    diffCents, explainedByFindingsCents, explainedByExpectedCents, unexplainedCents, tailCents, msiCents, outsidePeriodMatchedCents,
  };
  return { findings, summary, trusted, matches };
}
