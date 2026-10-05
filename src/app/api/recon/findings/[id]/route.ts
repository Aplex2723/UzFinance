import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { setFindingStatus } from "@/lib/repo/recon";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const body = z.object({ status: z.enum(["open", "resolved", "dismissed"]) }).strict();

/** Descartar / marcar como resuelto / reabrir un hallazgo. Es una decisión tuya: no toca ningún movimiento. */
export const PATCH = protectedRoute<{ id: string }>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const { status } = await readJson(req, body);
  if (!(await setFindingStatus(id, status))) throw new HttpError(404, "Hallazgo no encontrado");
  return json({ id, status });
});
