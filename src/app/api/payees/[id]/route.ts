import { HttpError, json, protectedRoute } from "@/lib/api";
import { deletePayee } from "@/lib/repo/payees";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const DELETE = protectedRoute<{ id: string }>(async ({ params }) => {
  if (!(await deletePayee(idParam.parse(params.id)))) throw new HttpError(404, "No encontrado");
  return json({ ok: true });
});
