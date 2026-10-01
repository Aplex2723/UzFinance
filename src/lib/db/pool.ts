import sql from "mssql";
import { getEnv } from "@/lib/env";

type G = typeof globalThis & { __uzPool?: Promise<sql.ConnectionPool> };
const g = globalThis as G;

function buildConfig(): sql.config {
  const env = getEnv();
  const base: sql.config = {
    server: env.DB_SERVER,
    port: env.DB_PORT,
    database: env.DB_NAME,
    // Azure SQL serverless puede tardar ~1 min en reanudar tras auto-pause.
    connectionTimeout: 60_000,
    requestTimeout: 30_000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: true,
      trustServerCertificate: env.DB_TRUST_SERVER_CERT,
      enableArithAbort: true,
    },
  };
  if (env.DB_AUTH === "msi") {
    base.authentication = {
      type: "azure-active-directory-msi-app-service",
      options: env.DB_CLIENT_ID ? { clientId: env.DB_CLIENT_ID } : {},
    };
  } else {
    base.user = env.DB_USER;
    base.password = env.DB_PASSWORD;
  }
  return base;
}

async function connectWithRetry(attempts = 3): Promise<sql.ConnectionPool> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const pool = new sql.ConnectionPool(buildConfig());
    try {
      return await pool.connect();
    } catch (e) {
      lastErr = e;
      await pool.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

export function getPool(): Promise<sql.ConnectionPool> {
  if (!g.__uzPool) {
    g.__uzPool = connectWithRetry().catch((e) => {
      g.__uzPool = undefined; // permitir reintento en la siguiente petición
      throw e;
    });
  }
  return g.__uzPool;
}

export async function closePool() {
  if (g.__uzPool) {
    const p = await g.__uzPool.catch(() => null);
    g.__uzPool = undefined;
    await p?.close();
  }
}

/** Parámetros tipados: toda consulta pasa por aquí, nunca se concatena SQL. */
export const t = {
  str: (value: string | null) => ({ type: sql.NVarChar, value }),
  varchar: (value: string | null) => ({ type: sql.VarChar, value }),
  char: (value: string | null) => ({ type: sql.Char, value }),
  int: (value: number | null) => ({ type: sql.Int, value }),
  big: (value: number | null) => ({ type: sql.BigInt, value }),
  bit: (value: boolean) => ({ type: sql.Bit, value }),
  date: (value: string | null) => ({ type: sql.Date, value: value ? new Date(`${value}T00:00:00Z`) : null }),
  dt: (value: Date) => ({ type: sql.DateTime2, value }),
};
type Param = ReturnType<(typeof t)[keyof typeof t]>;

export async function query<T = Record<string, unknown>>(
  text: string,
  params: Record<string, Param> = {},
): Promise<T[]> {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, p] of Object.entries(params)) req.input(name, p.type, p.value);
  const res = await req.query(text);
  return res.recordset as T[];
}

export function isUniqueViolation(e: unknown): boolean {
  const n = (e as { number?: number })?.number;
  return n === 2627 || n === 2601;
}
