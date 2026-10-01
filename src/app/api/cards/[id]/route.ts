import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { deleteCard, updateCard } from "@/lib/repo/cards";
import { cardSchema, idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";
type P = { id: string };

export const PUT = protectedRoute<P>(async ({ req, params }) => {
  const c = await updateCard(idParam.parse(params.id), await readJson(req, cardSchema));
  if (!c) throw new HttpError(404, "No encontrado");
  return json(c);
});
export const DELETE = protectedRoute<P>(async ({ params }) => {
  const r = await deleteCard(idParam.parse(params.id));
  if (r === "missing") throw new HttpError(404, "No encontrado");
  return json({ result: r });
});
