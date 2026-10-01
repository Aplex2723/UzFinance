import { json, protectedRoute, readJson } from "@/lib/api";
import { createRule, listRules } from "@/lib/repo/rules";
import { ruleSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json(await listRules()));
export const POST = protectedRoute(async ({ req }) => json(await createRule(await readJson(req, ruleSchema)), 201));
