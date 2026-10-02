import type { Source } from "@/lib/types";

/** Transacción ya parseada por cualquier fuente, lista para ingerirse. */
export type RawTransaction = {
  merchant: string;
  amountCents: number;
  /** Texto libre: nombre en Wallet, alias o últimos 4 dígitos. */
  cardRef: string;
  occurredAt: Date;
  categoryName?: string;
  notes?: string;
  /** Por defecto 'expense'. Un pago de tarjeta no cuenta en ninguna estadística. */
  kind?: "expense" | "card_payment";
  /** Compra a MSI que originó un plan (ver installment_plans). */
  planId?: number;
  /** Nº de ocurrencia (0, 1, 2…) de un movimiento idéntico (tarjeta, día, monto, comercio) dentro del mismo estado de cuenta. */
  seq?: number;
};

/**
 * Interfaz de "fuente". Cada origen (Atajo, correo, estado de cuenta) convierte
 * su formato a RawTransaction[]; la ingesta (dedupe, tarjeta, categoría) es común.
 */
export interface TransactionSource<TInput = unknown> {
  readonly kind: Source;
  parse(input: TInput): { rows: RawTransaction[]; errors: { line: number; message: string }[] };
}
