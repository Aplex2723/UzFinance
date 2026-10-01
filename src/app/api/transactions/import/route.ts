import { HttpError, json, protectedRoute } from "@/lib/api";
import { ingestMany } from "@/lib/repo/transactions";
import { readLimitedText } from "@/lib/security/body";
import { CSV_MAX_BYTES, csvSource } from "@/lib/sources/csv";

export const dynamic = "force-dynamic";

/** Importación de estado de cuenta: el body es el CSV tal cual (text/csv). */
export const POST = protectedRoute(async ({ req }) => {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.startsWith("text/csv") && !ct.startsWith("text/plain")) throw new HttpError(415, "Content-Type debe ser text/csv");
  const text = await readLimitedText(req, CSV_MAX_BYTES);
  const { rows, errors } = csvSource.parse(text);
  if (errors.length && rows.length === 0) return json({ inserted: 0, duplicates: 0, errors: errors.slice(0, 50) }, 400);
  const r = await ingestMany(rows, "statement");
  return json({ ...r, errors: errors.slice(0, 50), skipped: errors.length });
});
