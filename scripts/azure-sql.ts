import "./load-env";
import { execFileSync } from "node:child_process";
import sql from "mssql";
import { migrate } from "../src/lib/db/migrate";

/**
 * Administración de la base en Azure con tu identidad Entra (az login), sin passwords.
 *   tsx scripts/azure-sql.ts migrate
 *   tsx scripts/azure-sql.ts grant <objectId-de-la-managed-identity> <nombre-usuario>
 * Requiere DB_SERVER y DB_NAME en el entorno y una regla de firewall para tu IP.
 */
async function connect() {
  const server = process.env.DB_SERVER;
  const database = process.env.DB_NAME;
  if (!server?.endsWith(".database.windows.net") || !database) throw new Error("Define DB_SERVER=<srv>.database.windows.net y DB_NAME");
  const token = execFileSync("az", ["account", "get-access-token", "--resource", "https://database.windows.net/", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
  return new sql.ConnectionPool({
    server, database, connectionTimeout: 90_000, requestTimeout: 60_000,
    authentication: { type: "azure-active-directory-access-token", options: { token } },
    options: { encrypt: true },
  }).connect();
}

async function main() {
  const [cmd, oid, name] = process.argv.slice(2);
  const pool = await connect();
  try {
    if (cmd === "migrate") {
      const applied = await migrate(pool);
      console.log(applied.length ? `Migraciones aplicadas: ${applied.join(", ")}` : "Base al día.");
    } else if (cmd === "grant") {
      if (!/^[0-9a-f-]{36}$/i.test(oid ?? "") || !/^[A-Za-z0-9_-]+$/.test(name ?? "")) throw new Error("uso: grant <objectId> <nombre>");
      // Solo DML: la app no necesita (ni tiene) permisos de esquema.
      await pool.request().batch(`
        IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${name}')
          CREATE USER [${name}] FROM EXTERNAL PROVIDER WITH OBJECT_ID = '${oid}';
        ALTER ROLE db_datareader ADD MEMBER [${name}];
        ALTER ROLE db_datawriter ADD MEMBER [${name}];`);
      console.log(`Usuario ${name} con db_datareader + db_datawriter.`);
    } else throw new Error("comando: migrate | grant");
  } finally {
    await pool.close();
  }
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
