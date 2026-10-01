import { json, protectedRoute, readJson } from "@/lib/api";
import { createCard, listCards } from "@/lib/repo/cards";
import { cardSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json(await listCards(true)));
export const POST = protectedRoute(async ({ req }) => json(await createCard(await readJson(req, cardSchema)), 201));
