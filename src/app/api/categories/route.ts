import { json, protectedRoute, readJson } from "@/lib/api";
import { createCategory, listCategories } from "@/lib/repo/categories";
import { categorySchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json(await listCategories()));
export const POST = protectedRoute(async ({ req }) => json(await createCategory(await readJson(req, categorySchema)), 201));
