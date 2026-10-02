import { z } from "zod";

/** "gmail=abc…,viejo=def…" → [{name, token}]; null si el formato es inválido. */
export function parseNamedTokens(raw: string): { name: string; token: string }[] | null {
  const out: { name: string; token: string }[] = [];
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    const name = part.slice(0, i);
    const token = part.slice(i + 1);
    if (i < 1 || !/^[a-z0-9_-]{1,30}$/.test(name) || token.length < 32) return null;
    out.push({ name, token });
  }
  return out;
}

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  AUTH_MODE: z.enum(["dev", "easyauth"]).default("easyauth"),
  ALLOWED_EMAIL: z.email(),
  /** Opcional: si se define, el claim tid del principal debe coincidir. */
  ALLOWED_TENANT_ID: z.string().optional(),
  INGEST_TOKEN: z.string().min(32, "INGEST_TOKEN debe tener al menos 32 caracteres"),
  /** Token anterior, aceptado durante la rotación (ver README). */
  INGEST_TOKEN_PREVIOUS: z.string().min(32).optional(),
  /**
   * Tokens del puente Gmail (Apps Script), DISTINTOS al del Atajo: "nombre=token,otro=token".
   * Sin definir, /api/ingest/email rechaza todo (falla cerrado).
   */
  EMAIL_INGEST_TOKENS: z
    .string()
    .optional()
    .refine((v) => !v || parseNamedTokens(v) !== null, "EMAIL_INGEST_TOKENS: formato nombre=token (token ≥ 32 caracteres)"),
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
