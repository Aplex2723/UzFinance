import { formatMXN } from "@/lib/money";
import type { AlertCandidate, AlertSeverity } from "./types";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

const CONTROL_KEEP_NL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Texto de terceros (comercios, etiquetas) → una línea de texto plano, sin caracteres de control ni de dirección, truncada. */
export function safeText(s: unknown, max: number): string {
  const clean = String(s ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return truncate(clean, max);
}

/**
 * Corta a `max` unidades UTF-16 (lo que cuenta NVARCHAR) sin partir un carácter a la mitad (emoji = 2 unidades)
 * y marca el recorte con "…".
 */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Título (una línea, ≤120) y cuerpo (≤500, conserva saltos de línea propios) listos para las columnas. */
export function clampTitle(s: string): string {
  return safeText(s, 120);
}
export function clampBody(s: string): string {
  const clean = String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_KEEP_NL, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return truncate(clean, 500);
}

const money = (c: number) => formatMXN(c);
export { money as formatMoney };

const ICON: Record<AlertSeverity, string> = { info: "ℹ️", warn: "⚠️", high: "🚨" };

/** Texto corto listo para WhatsApp (el envío real aún no existe). Máximo 300 unidades. */
export function whatsappText(a: { title: string; body: string; severity: AlertSeverity }): string {
  const title = safeText(a.title, 100).replace(/\*/g, "");
  const body = clampBody(a.body).replace(/\*/g, "");
  return truncate(`${ICON[a.severity] ?? ICON.info} *${title}*\n${body}`, 300);
}

// ── Formatos para las alertas que genera el integrador (conciliación e ingesta de comprobantes) ──

/** Estado de cuenta contra lo registrado: avisa la diferencia. Severidad por magnitud: <$100 info, <$2,000 warn, resto high. */
export function statementDiffCandidate(p: {
  documentId: number;
  /** Etiqueta de la tarjeta/estado, p. ej. "Amex Platinum · sep 2026". */
  label: string;
  statementCents: number;
  appCents: number;
  missingInApp?: number;
  notInStatement?: number;
}): AlertCandidate {
  const diff = p.statementCents - p.appCents;
  const abs = Math.abs(diff);
  const severity: AlertSeverity = abs < 100_00 ? "info" : abs < 2_000_00 ? "warn" : "high";
  const label = safeText(p.label, 60);
  const parts: string[] = [
    diff === 0
      ? `Tu estado ${label} cuadra con lo registrado (${money(p.statementCents)}).`
      : `El estado ${label} suma ${money(p.statementCents)} y la app ${money(p.appCents)}: ${diff > 0 ? "faltan" : "sobran"} ${money(abs)} en la app.`,
  ];
  if (p.missingInApp) parts.push(`${p.missingInApp} movimiento(s) del estado no están en la app.`);
  if (p.notInStatement) parts.push(`${p.notInStatement} movimiento(s) de la app no aparecen en el estado.`);
  return {
    rule: "statement_diff",
    severity,
    title: `Estado ${label}: diferencia de ${money(abs)}`,
    body: parts.join(" "),
    dedupeKey: `stmt:${p.documentId}:${shortHash(label)}`,
    documentId: p.documentId,
    data: { label, statementCents: p.statementCents, appCents: p.appCents, diffCents: diff },
  };
}

/** Transferencia registrada desde un comprobante (PDF). Informativa; el integrador puede subir la severidad. */
export function transferRegisteredCandidate(p: {
  txId: number;
  amountCents: number;
  counterparty?: string | null;
  date?: string | null;
  trackingKey?: string | null;
  severity?: AlertSeverity;
}): AlertCandidate {
  const who = p.counterparty ? ` a ${safeText(p.counterparty, 50)}` : "";
  return {
    rule: "transfer_registered",
    severity: p.severity ?? "info",
    title: `Transferencia registrada: ${money(p.amountCents)}${who}`,
    body: `Se registró una transferencia de ${money(p.amountCents)}${who}${p.date ? ` del ${safeText(p.date, 10)}` : ""} desde el comprobante${p.trackingKey ? ` (clave ${safeText(p.trackingKey, 40)})` : ""}.`,
    dedupeKey: `transfer:${p.txId}`,
    txId: p.txId,
    data: { amountCents: p.amountCents, trackingKey: p.trackingKey ?? null },
  };
}

/** Huella corta y determinística (FNV-1a de 32 bits en hex) para claves de deduplicación. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
