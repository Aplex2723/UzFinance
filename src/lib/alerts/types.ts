export type AlertSeverity = "info" | "warn" | "high";

export type AlertCandidate = {
  rule: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  dedupeKey: string;
  txId?: number | null;
  documentId?: number | null;
  data?: Record<string, unknown>;
};

/** Reglas conocidas; `AlertCandidate.rule` es string libre para que otros módulos agreguen las suyas. */
export const ALERT_RULES = [
  "large_purchase",
  "new_merchant_large",
  "spending_pace",
  "daily_spike",
  "duplicate_suspect",
  "unconfirmed",
  "goal_off_track",
  "statement_diff",
  "transfer_registered",
  "document_review",
] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 1, warn: 2, high: 3 };
export const isSeverity = (s: unknown): s is AlertSeverity => s === "info" || s === "warn" || s === "high";

/** Una fila de `alerts` lista para la UI (fechas ISO en UTC). */
export type AlertRow = {
  id: number;
  rule: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  dedupeKey: string;
  txId: number | null;
  documentId: number | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  dismissedAt: string | null;
};

/** Tope de alertas nuevas por corrida: un bug o una importación enorme no pueden inundar al usuario. */
export const MAX_NEW_ALERTS_PER_RUN = 20;
/** Solo se alerta de movimientos con fecha de hasta N días atrás (estados de cuenta y correos tardíos no cuentan). */
export const MAX_ALERT_AGE_DAYS = 3;
