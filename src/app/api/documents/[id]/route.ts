import { HttpError, json, protectedRoute } from "@/lib/api";
import { getDocumentDetail } from "@/lib/docs/detail";
import { deleteDocument } from "@/lib/repo/documents";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** Documento + lo necesario para revisarlo: comprobante leído y tarjeta candidata, o corridas de conciliación con hallazgos. */
export const GET = protectedRoute<{ id: string }>(async ({ params }) => {
  const detail = await getDocumentDetail(idParam.parse(params.id));
  if (!detail) throw new HttpError(404, "Documento no encontrado");
  return json(detail);
});

/** Borra el documento (y sus corridas de conciliación). NUNCA borra movimientos. */
export const DELETE = protectedRoute<{ id: string }>(async ({ params }) => {
  if (!(await deleteDocument(idParam.parse(params.id)))) throw new HttpError(404, "Documento no encontrado");
  return json({ ok: true });
});
