import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { goalBody, rangeToHttp, toGoalInput } from "@/lib/goal-input";
import { createGoal, listGoals } from "@/lib/repo/goals";
import { localDate } from "@/lib/time";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json({ goals: await listGoals() }));

export const POST = protectedRoute(async ({ req }) => {
  const input = toGoalInput(await readJson(req, goalBody));
  const today = localDate(new Date());
  if (input.targetDate < today) throw new HttpError(400, "La fecha de la meta no puede ser pasada");
  try {
    return json({ goal: await createGoal(input, today) }, 201);
  } catch (e) {
    return rangeToHttp(e);
  }
});
