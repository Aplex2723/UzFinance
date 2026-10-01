import { json, protectedRoute } from "@/lib/api";
import { categorizeUncategorized } from "@/lib/repo/transactions";

export const dynamic = "force-dynamic";

export const POST = protectedRoute(async () => json(await categorizeUncategorized()));
