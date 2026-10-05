import "dotenv/config";
import sql from "mssql";
import { migrate } from "../src/lib/db/migrate";

/** Crea desde cero la base de pruebas y aplica las migraciones. */
export default async function setup() {
  const db = process.env.TEST_DB_NAME ?? "uzfinance_test"; // configurable: varias corridas en paralelo no se pisan
  if (!/^[A-Za-z0-9_]+$/.test(db)) throw new Error("TEST_DB_NAME inválido");
  const server = process.env.DB_SERVER ?? "localhost";
  const master = await new sql.ConnectionPool({
    server, port: Number(process.env.DB_PORT ?? 1433), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "master",
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  await master.request().batch(`IF DB_ID(N'${db}') IS NOT NULL BEGIN ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${db}]; END; CREATE DATABASE [${db}];`);
  await master.close();
  const pool = await new sql.ConnectionPool({
    server, port: Number(process.env.DB_PORT ?? 1433), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: db,
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  await migrate(pool);
  await pool.close();
}
