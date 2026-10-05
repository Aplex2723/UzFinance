import { z } from "zod";
import { json, protectedRoute, readJson } from "@/lib/api";
import { DEFAULT_ALERT_CONFIG, getAlertConfig, setAlertConfig } from "@/lib/repo/alerts";

export const dynamic = "force-dynamic";

export const GET = protectedRoute(async () => json({ config: await getAlertConfig(), defaults: DEFAULT_ALERT_CONFIG }));

/** Parche parcial: lo valida `setAlertConfig` (estricto). Un valor inválido responde 400 con los problemas. */
export const PUT = protectedRoute(async ({ req }) => {
  const patch = await readJson(req, z.record(z.string(), z.unknown()));
  return json({ config: await setAlertConfig(patch) });
});
