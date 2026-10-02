import { z } from "zod";
import { json, protectedRoute, readJson } from "@/lib/api";
import { categorizeMerchant } from "@/lib/repo/transactions";

export const dynamic = "force-dynamic";

const body = z.object({ merchant: z.string().trim().min(1).max(200), category_id: z.number().int().positive() }).strict();

/** Categoriza de una vez todos los movimientos sin categoría de un comercio. */
export const POST = protectedRoute(async ({ req }) => {
  const b = await readJson(req, body);
  const r = await categorizeMerchant(b.merchant, b.category_id);
  if (r === "no_category") return json({ error: "La categoría no existe" }, 404);
  return json({ updated: r });
});
