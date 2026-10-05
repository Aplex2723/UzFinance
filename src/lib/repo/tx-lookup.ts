import { query, t } from "@/lib/db/pool";

/** Resumen mínimo de un movimiento (solo lectura): para mostrar a qué se refiere un hallazgo sin salir de la pantalla. */
export type TxBrief = { id: number; date: string; merchant: string; cents: number; card: string; kind: "expense" | "card_payment"; source: string; sources: string };

export async function getTransactionBriefs(ids: number[]): Promise<TxBrief[]> {
  const uniq = [...new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 200);
  if (!uniq.length) return [];
  const params = Object.fromEntries(uniq.map((n, i) => [`i${i}`, t.big(n)]));
  const rows = await query<{ id: number; d: string; cents: number; merchant: string; card: string; kind: "expense" | "card_payment"; source: string; sources: string }>(
    `SELECT CAST(x.id AS float) AS id, CONVERT(char(10), x.occurred_date, 23) AS d, CAST(x.amount_cents AS float) AS cents, x.merchant_raw AS merchant, c.name AS card, x.kind, x.source, x.sources
     FROM dbo.transactions x JOIN dbo.cards c ON c.id = x.card_id WHERE x.id IN (${uniq.map((_, i) => `@i${i}`).join(",")})`,
    params,
  );
  return rows.map((r) => ({ id: Number(r.id), date: r.d, merchant: r.merchant, cents: Number(r.cents), card: r.card, kind: r.kind, source: r.source, sources: r.sources }));
}
