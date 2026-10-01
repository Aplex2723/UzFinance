export type Issuer = "amex" | "banamex" | "other";
export type Source = "shortcut" | "email" | "statement" | "manual";

export type Card = {
  id: number;
  name: string;
  issuer: Issuer;
  last4: string | null;
  aliases: string | null;
  color: string;
  active: boolean;
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
};
