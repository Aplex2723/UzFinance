import "dotenv/config";
import sql from "mssql";
import { migrate } from "../src/lib/db/migrate";

/** Crea desde cero la base de pruebas y aplica las migraciones. */
export default async function setup() {
  const server = process.env.DB_SERVER ?? "localhost";
  const master = await new sql.ConnectionPool({
    server, port: Number(process.env.DB_PORT ?? 1433), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "master",
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  await master.request().batch(`IF DB_ID(N'uzfinance_test') IS NOT NULL BEGIN ALTER DATABASE [uzfinance_test] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [uzfinance_test]; END; CREATE DATABASE [uzfinance_test];`);
  await master.close();
  const pool = await new sql.ConnectionPool({
    server, port: Number(process.env.DB_PORT ?? 1433), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "uzfinance_test",
    options: { encrypt: true, trustServerCertificate: true },
  }).connect();
  await migrate(pool);
  await pool.close();
}
