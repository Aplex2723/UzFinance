import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { deleteRule, updateRule } from "@/lib/repo/rules";
import { idParam, ruleSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
type P = { id: string };

export const PUT = protectedRoute<P>(async ({ req, params }) => {
  const r = await updateRule(idParam.parse(params.id), await readJson(req, ruleSchema));
  if (!r) throw new HttpError(404, "No encontrado");
  return json(r);
});
export const DELETE = protectedRoute<P>(async ({ params }) => {
  if (!(await deleteRule(idParam.parse(params.id)))) throw new HttpError(404, "No encontrado");
  return json({ ok: true });
});
