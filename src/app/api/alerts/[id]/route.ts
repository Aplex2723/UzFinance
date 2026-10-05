import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { dismissAlert, markAlertRead } from "@/lib/repo/alerts";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const body = z.object({ action: z.enum(["read", "dismiss"]) }).strict();

export const PATCH = protectedRoute<{ id: string }>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const { action } = await readJson(req, body);
  const ok = action === "read" ? await markAlertRead(id) : await dismissAlert(id);
  if (!ok) throw new HttpError(404, "Alerta no encontrada");
  return json({ id, action });
});
