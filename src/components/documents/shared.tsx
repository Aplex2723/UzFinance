import type { ReactNode } from "react";
import type { DocKind, DocStatus } from "@/lib/repo/documents";

export const KIND_LABEL: Record<DocKind, string> = { transfer_receipt: "Comprobante de transferencia", statement: "Estado de cuenta", unknown: "Documento" };
export const STATUS_LABEL: Record<DocStatus, string> = { processed: "Procesado", needs_review: "Por revisar", rejected: "Rechazado", failed: "No se pudo leer" };

const TONES = {
  good: "border-[#22c55e]/30 bg-[#22c55e]/12 text-[#4ade80]",
  warn: "border-[#f59e0b]/35 bg-[#f59e0b]/12 text-[#fbbf24]",
  bad: "border-[#ef4444]/35 bg-[#ef4444]/12 text-[#f87171]",
  info: "border-[#60a5fa]/30 bg-[#60a5fa]/12 text-[#93c5fd]",
  mute: "border-line bg-surface-2 text-muted",
} as const;
export type Tone = keyof typeof TONES;

/** Etiqueta de color (siempre con texto: el color nunca es la única señal). */
export function Chip({ tone = "mute", children, testId }: { tone?: Tone; children: ReactNode; testId?: string }) {
  return <span data-testid={testId} className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>{children}</span>;
}

export const STATUS_TONE: Record<DocStatus, Tone> = { processed: "good", needs_review: "warn", rejected: "mute", failed: "bad" };
export const StatusChip = ({ status }: { status: DocStatus }) => <Chip tone={STATUS_TONE[status]} testId="doc-status">{STATUS_LABEL[status]}</Chip>;

export const SEVERITY_LABEL = { high: "Grave", warn: "Atención", info: "Informativo" } as const;
export const SEVERITY_TONE: Record<"high" | "warn" | "info", Tone> = { high: "bad", warn: "warn", info: "info" };
