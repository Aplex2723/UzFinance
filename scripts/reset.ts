import "./load-env";
import sql from "mssql";
import { getEnv } from "../src/lib/env";

// Solo local: borra y recrea la base de docker.
const env = getEnv();
if (env.DB_AUTH !== "password" || !["127.0.0.1", "localhost"].includes(env.DB_SERVER) || !/^[A-Za-z0-9_]+$/.test(env.DB_NAME)) {
  console.error("reset se niega a correr: solo contra la base local de docker.");
  process.exit(1);
}
(async () => {
  const pool = await new sql.ConnectionPool({
    server: env.DB_SERVER, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, database: "master",
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  await pool.request().batch(`IF DB_ID(N'${env.DB_NAME}') IS NOT NULL BEGIN ALTER DATABASE [${env.DB_NAME}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${env.DB_NAME}]; END`);
  await pool.close();
  console.log(`Base ${env.DB_NAME} eliminada.`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
