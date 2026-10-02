import { query, t } from "@/lib/db/pool";
import type { Goal } from "@/lib/goals";

export const MAX_GOAL_CENTS = 1_000_000_000_00; // 1,000 millones: tope contra errores de captura

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export async function getGoal(): Promise<Goal | null> {
  const r = await query<{ name: string; target: number; date: string; saved: number; asof: string }>(
    `SELECT TOP 1 name, CAST(target_cents AS float) AS target, CONVERT(char(10), target_date, 23) AS date,
            CAST(saved_cents AS float) AS saved, CONVERT(char(10), saved_as_of, 23) AS asof
     FROM dbo.savings_goals ORDER BY id`,
  );
  return r[0] ? { name: r[0].name, targetCents: Number(r[0].target), targetDate: r[0].date, savedCents: Number(r[0].saved), savedAsOf: r[0].asof } : null;
}

/** Una sola meta: la crea o reemplaza la existente. */
export async function setGoal(g: Goal): Promise<void> {
  if (!g.name.trim() || g.name.length > 80) throw new RangeError("nombre inválido");
  if (!Number.isSafeInteger(g.targetCents) || g.targetCents <= 0 || g.targetCents > MAX_GOAL_CENTS) throw new RangeError("meta fuera de rango");
  if (!Number.isSafeInteger(g.savedCents) || g.savedCents < 0 || g.savedCents > MAX_GOAL_CENTS) throw new RangeError("ahorro fuera de rango");
  if (!validDate(g.targetDate) || !validDate(g.savedAsOf)) throw new RangeError("fecha inválida");
  const p = { n: t.str(g.name.trim()), tc: t.big(g.targetCents), td: t.date(g.targetDate), sc: t.big(g.savedCents), sa: t.date(g.savedAsOf) };
  const updated = await query(
    "UPDATE dbo.savings_goals SET name=@n, target_cents=@tc, target_date=@td, saved_cents=@sc, saved_as_of=@sa, updated_at=SYSUTCDATETIME() OUTPUT INSERTED.id WHERE id = (SELECT MIN(id) FROM dbo.savings_goals)",
    p,
  );
  if (!updated.length) await query("INSERT dbo.savings_goals (name, target_cents, target_date, saved_cents, saved_as_of) VALUES (@n, @tc, @td, @sc, @sa)", p);
}
