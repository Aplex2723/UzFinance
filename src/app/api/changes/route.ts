import { json, protectedRoute } from "@/lib/api";
import { getChangeRevision } from "@/lib/repo/transactions";

export const dynamic = "force-dynamic";

/** Revisión barata de los movimientos: el cliente la compara para saber si debe refrescar. */
export const GET = protectedRoute(async () => json({ rev: await getChangeRevision() }));
