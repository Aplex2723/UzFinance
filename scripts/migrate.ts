import "./load-env";
import sql from "mssql";
import { closePool, getPool } from "../src/lib/db/pool";
import { migrate } from "../src/lib/db/migrate";
import { getEnv } from "../src/lib/env";

/** Solo local (password auth): crea la base si no existe. En Azure la crea `az sql db create`. */
export async function ensureLocalDatabase() {
  const env = getEnv();
  if (env.DB_AUTH !== "password") return;
  if (!/^[A-Za-z0-9_]+$/.test(env.DB_NAME)) throw new Error("DB_NAME inválido");
  const master = await new sql.ConnectionPool({
    server: env.DB_SERVER, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: "master",
    options: { encrypt: true, trustServerCertificate: env.DB_TRUST_SERVER_CERT },
  }).connect();
  try {
    await master.request().batch(`IF DB_ID(N'${env.DB_NAME}') IS NULL CREATE DATABASE [${env.DB_NAME}]`);
  } finally {
    await master.close();
  }
}

async function main() {
  await ensureLocalDatabase();
  const applied = await migrate(await getPool());
  console.log(applied.length ? `Migraciones aplicadas: ${applied.join(", ")}` : "Base al día (sin migraciones pendientes).");
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(closePool);
}
