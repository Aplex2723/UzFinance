import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  AUTH_MODE: z.enum(["dev", "easyauth"]).default("easyauth"),
  ALLOWED_EMAIL: z.email(),
  /** Opcional: si se define, el claim tid del principal debe coincidir. */
  ALLOWED_TENANT_ID: z.string().optional(),
  INGEST_TOKEN: z.string().min(32, "INGEST_TOKEN debe tener al menos 32 caracteres"),
  /** Token anterior, aceptado durante la rotación (ver README). */
  INGEST_TOKEN_PREVIOUS: z.string().min(32).optional(),
  CATEGORIZER: z.enum(["rules", "llm"]).default("rules"),
  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().default(1433),
  DB_NAME: z.string().min(1),
  /** password = local (docker); msi = Managed Identity en Azure. */
  DB_AUTH: z.enum(["password", "msi"]).default("msi"),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_TRUST_SERVER_CERT: z.stringbool().default(false),
  DB_CLIENT_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Lazy: así `next build` no exige secretos. */
export function getEnv(source: Record<string, string | undefined> = process.env): Env {
  if (source === process.env && cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Solo nombres de variables, nunca valores.
    const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Configuración de entorno inválida: ${names}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

export function resetEnvCache() {
  cached = undefined;
}
