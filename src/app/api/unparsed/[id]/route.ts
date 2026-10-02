import { HttpError, json, protectedRoute } from "@/lib/api";
import { dismissUnparsed } from "@/lib/repo/emails";

export const dynamic = "force-dynamic";

/** Descarta un correo pendiente de revisión (ya lo capturaste a mano o no importa). */
export const DELETE = protectedRoute<{ id: string }>(async ({ params }) => {
  if (!/^[A-Za-z0-9._:@<>+=-]{4,200}$/.test(params.id)) throw new HttpError(400, "id inválido");
  if (!(await dismissUnparsed(params.id))) throw new HttpError(404, "No existe");
  return json({ ok: true });
});
