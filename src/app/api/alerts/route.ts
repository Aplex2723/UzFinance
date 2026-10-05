import { z } from "zod";
import { json, parseQuery, protectedRoute } from "@/lib/api";
import { listAlerts, unreadAlertCount } from "@/lib/repo/alerts";

export const dynamic = "force-dynamic";

const q = z.object({
  include_dismissed: z.enum(["true", "false", "1", "0"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = protectedRoute(async ({ req }) => {
  const f = parseQuery(req, q);
  const [alerts, unread] = await Promise.all([
    listAlerts({ includeDismissed: f.include_dismissed === "true" || f.include_dismissed === "1", limit: f.limit }),
    unreadAlertCount(),
  ]);
  return json({ alerts, unread });
});
