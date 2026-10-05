/**
 * Tipos de la conciliación de estados de cuenta (motor puro: sin base de datos).
 * Dinero siempre en centavos enteros (MXN); fechas YYYY-MM-DD en hora local de Ciudad de México.
 */

export type Severity = "info" | "warn" | "high";

export type FindingKind =
  | "missing_in_app" // el estado trae un cargo que la app no tiene
  | "not_in_statement" // la app tiene un movimiento del periodo que el estado no trae
  | "duplicate_suspect" // más filas idénticas en la app que líneas en el estado
  | "amount_mismatch" // misma compra, monto distinto
  | "total_mismatch" // la suma del periodo no cuadra
  | "extraction_check_failed"; // los datos extraídos del PDF no son confiables

/** Lo que el motor necesita de cada movimiento del estado (un `StatementDoc` lo cumple). */
export type StmtLine = {
  date: string;
  merchant: string;
  amount_cents: number;
  type: string;
  installment?: { n: number | null; total: number | null } | null;
  /** Cargo en moneda extranjera (el banco convierte: el monto puede diferir un poco del que vio el Atajo). */
  foreign?: unknown;
  holder?: string | null;
  section?: string | null;
  pending?: boolean;
};

export type ReconDoc = {
  period: { start: string; end: string };
  transactions: StmtLine[];
  checks?: { name: string; ok: boolean }[];
};

/** Una fila de `transactions` ya normalizada (BIGINT → number, fecha local). */
export type AppRow = {
  id: number;
  /** occurred_date: fecha local YYYY-MM-DD. */
  date: string;
  cents: number;
  kind: "expense" | "card_payment";
  merchant: string;
  /** shortcut | email | statement | manual | receipt */
  source: string;
  planId?: number | null;
  /** occurred_at en ISO (UTC); solo para la regla de "duplicados a ≤10 min". */
  occurredAt?: string | null;
};

export type ReconFinding = {
  /** Estable entre corridas: no depende de ids autoincrementales cuando el hallazgo no nace de una fila de la app. */
  fingerprint: string;
  kind: FindingKind;
  severity: Severity;
  txId: number | null;
  otherTxId: number | null;
  stmtDate: string | null;
  stmtAmountCents: number | null;
  stmtMerchant: string | null;
  stmtType: string | null;
  message: string;
  detail: Record<string, unknown>;
};

export type ReconSummary = {
  /** Cargos del estado que se comparan (compras, comisiones, intereses, impuestos, efectivo, transferencias, reembolsos). */
  statementCount: number;
  statementCents: number;
  /** Movimientos (gasto) de la app con fecha dentro del periodo. */
  appCount: number;
  appCents: number;
  /** Cargos del estado con pareja en la app (incluye los conciliados por MSI). */
  matched: number;
  msiMatched: number;
  paymentsCount: number;
  paymentsMatched: number;
  /** Mensualidades de MSI del estado (no se comparan: la compra completa ya está en la app una sola vez). */
  installmentCount: number;
  installmentCents: number;
  /** Líneas ignoradas por tipo (transfer_own, income, monto cero, installment, installment_credit…). */
  ignored: Record<string, number>;
  /** Filas de la app a MSI sin línea equivalente en el estado (esperable: solo sale la mensualidad). */
  msiUnmatched: number;
  /** statementCents − appCents. */
  diffCents: number;
  /** Parte de la diferencia que explican los hallazgos. */
  explainedByFindingsCents: number;
  /** Parte esperable que no es hallazgo: cola de los últimos días, compras a MSI y parejas fuera del periodo. */
  explainedByExpectedCents: number;
  unexplainedCents: number;
  tailCents: number;
  msiCents: number;
  outsidePeriodMatchedCents: number;
};

export type ReconMatch = { lineIndex: number; rowId: number };

export type ReconResult = {
  findings: ReconFinding[];
  summary: ReconSummary;
  /** false si algún `check` del documento falló: los datos del PDF no son confiables. */
  trusted: boolean;
  /** Parejas cargo del estado (índice en doc.transactions) ↔ fila de la app. */
  matches: ReconMatch[];
};

/** Umbrales (centavos / días). */
export const THRESHOLDS = {
  /** Cargo "grande": un hallazgo de este monto o más es high. */
  highCents: 500_000,
  /** Compra reciente-grande: dentro de estos días a `today` y de este monto o más. */
  recentDays: 10,
  recentBigCents: 200_000,
  /** Ventana de pareja (días) entre fecha de operación del estado y fecha registrada en la app. */
  matchDays: 3,
  paymentDays: 5,
  /** Últimos días del periodo (aún pudieron no postearse) y días previos al inicio que pertenecen al estado anterior. */
  tailDays: 3,
  leadDays: 4,
  /** amount_mismatch: diferencia máxima relativa para emparejar, y la "esperable" (redondeo / tipo de cambio). */
  mismatchMaxRel: 0.3,
  mismatchExpectedRel: 0.02,
  mismatchExpectedRelForeign: 0.05,
  mismatchMinSimilarity: 0.6,
  /** amount_mismatch con diferencia absoluta de este monto o más: high. */
  mismatchHighCents: 100_000,
  /** Duplicados "aun sin estado": misma tarjeta+monto+comercio, fuentes distintas, a ≤ estos minutos. */
  dupMinutes: 10,
} as const;
