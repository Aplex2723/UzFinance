import { z } from "zod";
import { query, t } from "@/lib/db/pool";
import { buildRecapFacts, RECAP_SYSTEM, recapHash, recapUserMessage, unknownAmounts } from "@/lib/goals-recap";
import { chat, LlmError } from "@/lib/llm/openrouter";
import type { GoalsOverview } from "./goals-plan";

const KEY = "goals_recap";

const stored = z.object({ text: z.string().min(1), at: z.string(), hash: z.string(), model: z.string() });
export type StoredRecap = z.infer<typeof stored>;

export async function getRecap(): Promise<StoredRecap | null> {
  const r = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key] = @k", { k: t.varchar(KEY) });
  if (!r[0]) return null;
  try {
    const p = stored.safeParse(JSON.parse(r[0].value));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

async function saveRecap(r: StoredRecap) {
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(KEY), v: t.str(JSON.stringify(r)) },
  );
}

export type RecapDeps = { apiKey: string; model: string; now?: Date; fetchImpl?: typeof fetch };

/**
 * Genera el resumen con el modelo y lo guarda. Si el texto trae un monto que no está en las cifras enviadas se pide corregir una vez;
 * si persiste, se descarta (nunca se muestra un monto que no se pueda verificar). Lanza LlmError con un mensaje seguro para mostrar.
 */
export async function generateRecap(o: GoalsOverview, d: RecapDeps): Promise<StoredRecap> {
  const facts = buildRecapFacts(o.summary, o.capacity, o.categories, o.scenarios);
  const base = { apiKey: d.apiKey, model: d.model, system: RECAP_SYSTEM, fetchImpl: d.fetchImpl };
  let user = recapUserMessage(facts);
  let text = await chat({ ...base, user });
  let bad = unknownAmounts(text, facts);
  if (bad.length) {
    user += `\n\nTu respuesta anterior incluyó montos que no están en <datos> (${bad.slice(0, 5).join(", ")}). Reescríbela usando únicamente montos copiados tal cual del JSON, sin calcular nada.`;
    text = await chat({ ...base, user });
    bad = unknownAmounts(text, facts);
  }
  if (bad.length) throw new LlmError("El resumen traía montos que no pude verificar; intenta de nuevo");
  const recap: StoredRecap = { text: text.slice(0, 4000), at: (d.now ?? new Date()).toISOString(), hash: recapHash(o.summary, o.capacity), model: d.model };
  await saveRecap(recap);
  return recap;
}
