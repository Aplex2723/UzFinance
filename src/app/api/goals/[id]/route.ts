import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { deleteGoal, getGoalById, updateGoal } from "@/lib/repo/goals";
import { localDate } from "@/lib/time";
import { goalBody, rangeToHttp, toGoalInput } from "@/lib/goal-input";

export const dynamic = "force-dynamic";

const parseId = (raw: string) => {
  if (!/^\d{1,9}$/.test(raw)) throw new HttpError(404, "Meta no encontrada");
  return Number(raw);
};

export const GET = protectedRoute<{ id: string }>(async ({ params }) => {
  const goal = await getGoalById(parseId(params.id));
  if (!goal) throw new HttpError(404, "Meta no encontrada");
  return json({ goal });
});

export const PUT = protectedRoute<{ id: string }>(async ({ req, params }) => {
  const id = parseId(params.id);
  const input = toGoalInput(await readJson(req, goalBody));
  const today = localDate(new Date());
  const current = await getGoalById(id);
  if (!current) throw new HttpError(404, "Meta no encontrada");
  // Una fecha pasada solo se rechaza si la cambias; editar el nombre de una meta vencida debe poder hacerse.
  if (input.targetDate < today && input.targetDate !== current.targetDate) throw new HttpError(400, "La fecha de la meta no puede ser pasada");
  try {
    const goal = await updateGoal(id, input, today);
    if (!goal) throw new HttpError(404, "Meta no encontrada");
    return json({ goal });
  } catch (e) {
    return rangeToHttp(e);
  }
});

export const DELETE = protectedRoute<{ id: string }>(async ({ params }) => {
  if (!(await deleteGoal(parseId(params.id)))) throw new HttpError(404, "Meta no encontrada");
  return json({ ok: true });
});
