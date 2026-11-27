import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { convertToMsi, MsiError } from "@/lib/repo/manual-msi";
import { idParam, msiConvertSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";
type P = { id: string };

/** Pasa a meses sin intereses un gasto que ya existe (el gasto sigue a precio completo; se crea y liga su plan). */
export const POST = protectedRoute<P>(async ({ req, params }) => {
  const id = idParam.parse(params.id);
  const b = await readJson(req, msiConvertSchema);
  try {
    const m = await convertToMsi(id, b.months);
    return json({ ok: true, months: m.n, monthly_cents: m.monthlyCents, estimated_dates: m.guessed }, 201);
  } catch (e) {
    if (e instanceof MsiError) throw new HttpError(400, e.message);
    throw e;
  }
});
