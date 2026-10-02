import { z } from "zod";
import { json, protectedRoute, readJson } from "@/lib/api";
import { createPayee, listPayees } from "@/lib/repo/payees";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json(await listPayees()));
export const POST = protectedRoute(async ({ req }) =>
  json(await createPayee((await readJson(req, z.object({ pattern: z.string().trim().min(2).max(80) }).strict())).pattern), 201));
