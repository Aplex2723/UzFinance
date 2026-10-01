import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sql from "mssql";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** Aplica db/migrations/*.sql en orden, una sola vez cada una (tabla dbo._migrations). */
export async function migrate(pool: sql.ConnectionPool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.request().query(`
    IF OBJECT_ID('dbo._migrations') IS NULL
      CREATE TABLE dbo._migrations (name NVARCHAR(200) PRIMARY KEY, applied_at DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME());`);
  const done = new Set(
    (await pool.request().query("SELECT name FROM dbo._migrations")).recordset.map((r) => r.name as string),
  );
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      await new sql.Request(tx).batch(readFileSync(path.join(dir, file), "utf8"));
      await new sql.Request(tx).input("n", sql.NVarChar, file).query("INSERT dbo._migrations(name) VALUES(@n)");
      await tx.commit();
      applied.push(file);
    } catch (e) {
      await tx.rollback();
      throw new Error(`Migración ${file} falló: ${(e as Error).message}`);
    }
  }
  return applied;
}
