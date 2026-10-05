import { HttpError, json, protectedRoute } from "@/lib/api";
import { reconcileStatements } from "@/lib/docs/statement-flow";
import { getDocument } from "@/lib/repo/documents";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Vuelve a conciliar un estado de cuenta (p. ej. después de indicar a qué tarjeta corresponde). Idempotente. */
export const POST = protectedRoute<{ id: string }>(async ({ params }) => {
  const id = idParam.parse(params.id);
  const doc = await getDocument(id);
  if (!doc) throw new HttpError(404, "Documento no encontrado");
  if (doc.kind !== "statement") throw new HttpError(409, "Este documento no es un estado de cuenta");
  return json({ documentId: id, ...(await reconcileStatements(id)) });
});
