import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { ConfirmError, confirmSchema, confirmTransferDocument } from "@/lib/docs/transfer-flow";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

/** Confirma un comprobante que quedó en revisión (tarjeta de origen, correcciones al OCR, concepto, categoría). */
export const POST = protectedRoute<{ id: string }>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const input = await readJson(req, confirmSchema);
  try {
    const r = await confirmTransferDocument(id, input);
    return json({ documentId: r.documentId, status: "processed", txId: r.txId, registered: r.registered });
  } catch (e) {
    if (e instanceof ConfirmError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
