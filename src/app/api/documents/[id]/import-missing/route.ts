import { z } from "zod";
import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { getCategorizer } from "@/lib/categorizer";
import { reconcileStatements } from "@/lib/docs/statement-flow";
import { getDocument } from "@/lib/repo/documents";
import { getStatementCardMap, importMissing } from "@/lib/repo/recon";
import { idParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // categorizar con Jev puede tardar

const body = z
  .object({
    finding_ids: z.array(z.number().int().positive()).max(500).optional(),
    dry_run: z.boolean().optional(),
  })
  .strict();

/**
 * Agrega a la app SOLO las compras que el estado trae y la app no tiene (todas o las elegidas). `dry_run` solo cuenta lo que haría.
 * Nunca modifica ni borra movimientos existentes.
 */
export const POST = protectedRoute<{ id: string }>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const input = await readJson(req, body);
  const doc = await getDocument(id);
  if (!doc) throw new HttpError(404, "Documento no encontrado");
  if (doc.kind !== "statement") throw new HttpError(409, "Este documento no es un estado de cuenta");
  if (!(await getStatementCardMap())) throw new HttpError(409, "Primero indica a qué tarjeta corresponde cada estado");
  const report = await importMissing(id, { categorizer: await getCategorizer({ timeoutMs: 15000 }), findingIds: input.finding_ids, dryRun: input.dry_run === true });
  if (!input.dry_run) {
    // Refresca el resumen del documento (estado y detalle); importMissing ya concilió de nuevo. Nunca rompe la respuesta.
    await reconcileStatements(id).catch((e) => console.error("[api] reconcile tras importar falló:", (e as Error).message));
  }
  return json(report);
});
