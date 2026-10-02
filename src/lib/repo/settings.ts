import { query, t } from "@/lib/db/pool";

const INCOME_KEY = "monthly_income_cents";
/** Tope razonable para evitar errores de captura (10 millones de pesos al mes). */
export const MAX_INCOME_CENTS = 10_000_000_00;

/** Ingreso mensual en centavos; 0 si no está configurado. */
export async function getMonthlyIncome(): Promise<number> {
  const rows = await query<{ value: string }>("SELECT value FROM dbo.app_settings WHERE [key] = @k", { k: t.varchar(INCOME_KEY) });
  const n = Number(rows[0]?.value ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export async function setMonthlyIncome(cents: number): Promise<void> {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_INCOME_CENTS) throw new RangeError("ingreso fuera de rango");
  await query(
    `MERGE dbo.app_settings AS s USING (SELECT @k AS [key]) AS x ON s.[key] = x.[key]
     WHEN MATCHED THEN UPDATE SET value = @v, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value) VALUES (@k, @v);`,
    { k: t.varchar(INCOME_KEY), v: t.str(String(cents)) },
  );
}
