import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { deleteCategory, updateCategory } from "@/lib/repo/categories";
import { categorySchema, idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";
type P = { id: string };

export const PUT = protectedRoute<P>(async ({ req, params }) => {
  const c = await updateCategory(idParam.parse(params.id), await readJson(req, categorySchema));
  if (!c) throw new HttpError(404, "No encontrado");
  return json(c);
});
export const DELETE = protectedRoute<P>(async ({ params }) => {
  if (!(await deleteCategory(idParam.parse(params.id)))) throw new HttpError(404, "No encontrado");
  return json({ ok: true });
});
