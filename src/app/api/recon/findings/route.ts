import { json, protectedRoute } from "@/lib/api";
import { listOpenFindings } from "@/lib/repo/recon";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json({ findings: await listOpenFindings(100) }));
