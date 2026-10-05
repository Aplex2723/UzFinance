import { json, protectedRoute } from "@/lib/api";
import { markAllRead } from "@/lib/repo/alerts";

export const dynamic = "force-dynamic";

export const POST = protectedRoute(async () => json({ updated: await markAllRead() }));
