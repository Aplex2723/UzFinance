import { z } from "zod";
import { query, t } from "@/lib/db/pool";

const stored = z.object({ text: z.string().min(1), at: z.string(), hash: z.string(), model: z.string() });
export type StoredRecap = z.infer<typeof stored>;

/** Resúmenes con IA guardados en app_settings (una clave por resumen). */
export async function getRecapAt(key: string): Promise<StoredRecap | null> {
  const r = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key] = @k", { k: t.varchar(key) });
  if (!r[0]) return null;
  try {
    const p = stored.safeParse(JSON.parse(r[0].value));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export async function saveRecapAt(key: string, r: StoredRecap) {
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(key), v: t.str(JSON.stringify(r)) },
  );
}
