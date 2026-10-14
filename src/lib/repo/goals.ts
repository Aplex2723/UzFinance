import { query, t } from "@/lib/db/pool";
import { GOAL_KINDS, MAX_GOALS, type GoalKind, type GoalPriority, type GoalRow } from "@/lib/goals";

export const MAX_GOAL_CENTS = 1_000_000_000_00; // 1,000 millones: tope contra errores de captura

export type GoalInput = { name: string; kind: GoalKind; priority: GoalPriority; targetCents: number; targetDate: string; monthOnly: boolean; savedCents: number };

const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export class GoalLimitError extends Error {}

type Row = { id: number; name: string; kind: string; priority: number; target: number; date: string; month_only: boolean; saved: number; asof: string };
const COLS = `id, name, kind, priority, CAST(target_cents AS float) AS target, CONVERT(char(10), target_date, 23) AS date, month_only,
              CAST(saved_cents AS float) AS saved, CONVERT(char(10), saved_as_of, 23) AS asof`;

const toGoal = (r: Row): GoalRow => ({
  id: r.id, name: r.name, kind: (GOAL_KINDS as readonly string[]).includes(r.kind) ? (r.kind as GoalKind) : "otro",
  priority: (r.priority >= 1 && r.priority <= 3 ? r.priority : 2) as GoalPriority,
  targetCents: Number(r.target), targetDate: r.date, monthOnly: !!r.month_only, savedCents: Number(r.saved), savedAsOf: r.asof,
});

/** Todas las metas: primero las de mayor prioridad y fecha más próxima. */
export async function listGoals(): Promise<GoalRow[]> {
  return (await query<Row>(`SELECT ${COLS} FROM dbo.savings_goals ORDER BY priority, target_date, id`)).map(toGoal);
}

export async function getGoalById(id: number): Promise<GoalRow | null> {
  const r = await query<Row>(`SELECT ${COLS} FROM dbo.savings_goals WHERE id = @id`, { id: t.int(id) });
  return r[0] ? toGoal(r[0]) : null;
}

export function validateGoal(g: GoalInput): void {
  if (!g.name.trim() || g.name.length > 80) throw new RangeError("nombre inválido");
  if (!(GOAL_KINDS as readonly string[]).includes(g.kind)) throw new RangeError("tipo inválido");
  if (![1, 2, 3].includes(g.priority)) throw new RangeError("prioridad inválida");
  if (!Number.isSafeInteger(g.targetCents) || g.targetCents <= 0 || g.targetCents > MAX_GOAL_CENTS) throw new RangeError("meta fuera de rango");
  if (!Number.isSafeInteger(g.savedCents) || g.savedCents < 0 || g.savedCents > MAX_GOAL_CENTS) throw new RangeError("ahorro fuera de rango");
  if (!validDate(g.targetDate) || g.targetDate < "2000-01-01" || g.targetDate > "2100-12-31") throw new RangeError("fecha inválida");
}

const params = (g: GoalInput, today: string) => ({
  n: t.str(g.name.trim()), k: t.varchar(g.kind), p: t.int(g.priority), tc: t.big(g.targetCents), td: t.date(g.targetDate),
  mo: t.bit(g.monthOnly), sc: t.big(g.savedCents), sa: t.date(today),
});

/** Crea una meta (máximo MAX_GOALS). `today` es la fecha a la que corresponde el ahorro capturado. */
export async function createGoal(g: GoalInput, today: string): Promise<GoalRow> {
  validateGoal(g);
  const r = await query<{ id: number }>(
    `INSERT dbo.savings_goals (name, kind, priority, target_cents, target_date, month_only, saved_cents, saved_as_of)
     OUTPUT INSERTED.id
     SELECT @n, @k, @p, @tc, @td, @mo, @sc, @sa WHERE (SELECT COUNT(*) FROM dbo.savings_goals) < ${MAX_GOALS}`,
    params(g, today),
  );
  if (!r[0]) throw new GoalLimitError(`Máximo ${MAX_GOALS} metas`);
  return (await getGoalById(r[0].id))!;
}

/** Edita una meta; "ahorrado a la fecha" se actualiza solo si cambió la cifra de ahorro. null si no existe. */
export async function updateGoal(id: number, g: GoalInput, today: string): Promise<GoalRow | null> {
  validateGoal(g);
  const r = await query<{ id: number }>(
    `UPDATE dbo.savings_goals SET name=@n, kind=@k, priority=@p, target_cents=@tc, target_date=@td, month_only=@mo,
            saved_as_of = CASE WHEN saved_cents <> @sc THEN @sa ELSE saved_as_of END, saved_cents=@sc, updated_at=SYSUTCDATETIME()
     OUTPUT INSERTED.id WHERE id=@id`,
    { ...params(g, today), id: t.int(id) },
  );
  return r[0] ? getGoalById(id) : null;
}

export async function deleteGoal(id: number): Promise<boolean> {
  return (await query<{ id: number }>("DELETE dbo.savings_goals OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) })).length > 0;
}
