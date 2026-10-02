export type CardArtId = "amex-platinum" | "banamex-explora" | "banamex-clasica" | "banamex-debito" | "nu" | "generic";
export type Issuer = "amex" | "banamex" | "nu" | "other";
export type Source = "shortcut" | "email" | "statement" | "manual";

export type Card = {
  id: number;
  name: string;
  issuer: Issuer;
  last4: string | null;
  aliases: string | null;
  color: string;
  /** Diseño visual; null = automático según emisor y nombre. */
  art: CardArtId | null;
  active: boolean;
  /** Creada automáticamente desde un correo: pendiente de que le pongas nombre. */
  needs_name: boolean;
};
export type Category = { id: number; name: string; color: string };
export type Rule = {
  id: number;
  pattern: string;
  match_type: "contains" | "exact" | "startswith";
  category_id: number;
  priority: number;
};
export type Transaction = {
  id: number;
  occurred_at: string;
  occurred_date: string;
  amount_cents: number;
  currency: string;
  merchant_raw: string;
  merchant_normalized: string;
  card_id: number;
  card_name: string;
  issuer: Issuer;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  source: Source;
  notes: string | null;
  kind: TxKind;
  is_recurring: boolean;
  sources: string;
  auth_code: string | null;
  /** Domiciliación: últimos dígitos de la cuenta de cargo (referencia, no una tarjeta). */
  account_ref: string | null;
  /** Tarjeta Banamex, solo Atajo y con más de 24 h sin correo del banco. */
  unconfirmed: boolean;
};
export type TxKind = "expense" | "card_payment";
