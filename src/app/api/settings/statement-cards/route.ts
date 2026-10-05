import { HttpError, json, protectedRoute, readJson } from "@/lib/api";
import { cardMapSchema, type CardMap } from "@/lib/import/statements";
import { listCards } from "@/lib/repo/cards";
import { getStatementCardMap, setStatementCardMap } from "@/lib/repo/recon";

export const dynamic = "force-dynamic";

type Target = CardMap[string]["default"];

export const GET = protectedRoute(async () => json({ map: await getStatementCardMap(), cards: await listCards(true) }));

/** Los destinos son NOMBRES de tarjetas que ya existen: esta ruta nunca crea tarjetas (`create` se rechaza). */
export const PUT = protectedRoute(async ({ req }) => {
  const input = await readJson(req, cardMapSchema);
  const name = (x: Target): string => {
    if (typeof x === "object" && x.create) throw new HttpError(400, "No se pueden crear tarjetas desde aquí: elige una que ya exista");
    return typeof x === "string" ? x : x.name;
  };
  const rec = (r: Record<string, Target>) => Object.fromEntries(Object.entries(r).map(([a, b]) => [a, name(b)]));
  const map: CardMap = {};
  for (const [key, m] of Object.entries(input)) {
    map[key] = {
      default: name(m.default),
      ...(m.sections ? { sections: rec(m.sections) } : {}),
      ...(m.holders ? { holders: rec(m.holders) } : {}),
      ...(m.domiciliation ? { domiciliation: name(m.domiciliation) } : {}),
    };
  }
  const used = Object.values(map).flatMap((m) => [m.default, ...Object.values(m.sections ?? {}), ...Object.values(m.holders ?? {}), ...(m.domiciliation ? [m.domiciliation] : [])]) as string[];
  const existing = new Set((await listCards(true)).map((c) => c.name));
  const missing = [...new Set(used)].filter((n) => !existing.has(n));
  if (missing.length) throw new HttpError(400, `Estas tarjetas no existen: ${missing.slice(0, 5).join(", ")}`);
  await setStatementCardMap(map);
  return json({ map });
});
