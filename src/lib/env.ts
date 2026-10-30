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

/** "" (App Setting vacío) se trata como no definido. */
const optionalText = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().optional());

/**
 * Bot de WhatsApp: TODO opcional y sin validar aquí (un valor inválido nunca debe tumbar el resto de la app).
 * La validación estricta vive en `getWhatsAppConfig()` (src/lib/whatsapp/config.ts), que falla cerrado: sin configuración válida
 * el webhook no procesa nada.
 */
export const whatsappEnvShape = {
  WHATSAPP_VERIFY_TOKEN: optionalText,
  WHATSAPP_APP_SECRET: optionalText,
  WHATSAPP_ACCESS_TOKEN: optionalText,
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  /** "5215512345678=Alex,5215587654321=Sam" (1 a 5 personas). */
  WHATSAPP_ALLOWED: optionalText,
  /** Versión de la Graph API; por omisión v25.0. */
  WHATSAPP_GRAPH_VERSION: optionalText,
  /** URL pública de la app (para enlaces en las respuestas); en Azure se deduce de WEBSITE_HOSTNAME. */
  APP_URL: optionalText,
  WEBSITE_HOSTNAME: optionalText,
};

/**
 * Bot de Telegram: TODO opcional y sin validar aquí (igual que WhatsApp: un valor inválido nunca debe tumbar el resto de la app).
 * La validación estricta vive en `getTelegramConfig()` (src/lib/telegram/config.ts), que falla cerrado.
 */
export const telegramEnvShape = {
  /** Token de @BotFather: "123456789:AA…". */
  TELEGRAM_BOT_TOKEN: optionalText,
  /** `secret_token` del setWebhook: Telegram lo devuelve en el encabezado X-Telegram-Bot-Api-Secret-Token de cada POST. */
  TELEGRAM_WEBHOOK_SECRET: optionalText,
  /** "123456789=Alex,987654321=Sam": id numérico de usuario=Nombre (0 a 5). Vacío = modo descubrimiento (el bot solo responde /id). */
  TELEGRAM_ALLOWED: optionalText,
  /** Usuario del bot (sin @): ignora comandos dirigidos a otro bot en un grupo (/resumen@OtroBot) y detecta menciones y respuestas al bot. */
  TELEGRAM_BOT_USERNAME: optionalText,
  /** Ids de chat/grupo donde el bot atiende ("-1001234567890,-100987"; negativos permitidos; máx. 10). Vacío (por omisión) = los grupos se ignoran por completo. */
  TELEGRAM_ALLOWED_CHATS: optionalText,
};

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  AUTH_MODE: z.enum(["dev", "easyauth"]).default("easyauth"),
  ALLOWED_EMAIL: z.email(),
  /** Opcional: si se define, el claim tid del principal debe coincidir. */
  ALLOWED_TENANT_ID: z.string().optional(),
  INGEST_TOKEN: z.string().min(32, "INGEST_TOKEN debe tener al menos 32 caracteres"),
  /** Token anterior, aceptado durante la rotación (ver docs/DEPLOY-AZURE.md). */
  INGEST_TOKEN_PREVIOUS: z.string().min(32).optional(),
  /**
   * Tokens del puente Gmail (Apps Script), DISTINTOS al del Atajo: "nombre=token,otro=token".
   * Sin definir, /api/ingest/email rechaza todo (falla cerrado).
   */
  EMAIL_INGEST_TOKENS: z
    .string()
    .optional()
    .refine((v) => !v || parseNamedTokens(v) !== null, "EMAIL_INGEST_TOKENS: formato nombre=token (token ≥ 32 caracteres)"),
  /**
   * Tokens del servidor MCP (/api/mcp, solo lectura de tus finanzas), uno por cliente para revocarlos por separado:
   * "claude=token,cursor=token". DISTINTOS a INGEST_TOKEN (ese solo escribe movimientos). Sin definir, /api/mcp rechaza todo.
   */
  MCP_TOKENS: z
    .string()
    .optional()
    .refine((v) => !v || parseNamedTokens(v) !== null, "MCP_TOKENS: formato nombre=token (token ≥ 32 caracteres)"),
  /** rules = solo reglas; jev = reglas + historial + Jev (necesita OPENROUTER_API_KEY; sin ella cae a reglas). */
  CATEGORIZER: z.enum(["rules", "jev"]).default("rules"),
  OPENROUTER_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(20).optional()),
  /** Modelo de OpenRouter para el resumen de metas (por omisión anthropic/claude-haiku-5.5). */
  GOALS_LLM_MODEL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().regex(/^[\w.~-]+\/[\w.:~-]+$/, "GOALS_LLM_MODEL: formato proveedor/modelo").max(80).optional()),
  /** Modelo de OpenRouter para UzChat (necesita soportar herramientas; por omisión el mismo que el resumen de metas). */
  CHAT_LLM_MODEL: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().regex(/^[\w.~-]+\/[\w.:~-]+$/, "CHAT_LLM_MODEL: formato proveedor/modelo").max(80).optional()),
  DB_SERVER: z.string().min(1),
  DB_PORT: z.coerce.number().default(1433),
  DB_NAME: z.string().min(1),
  /** password = local (docker); msi = Managed Identity en Azure; token = scripts de administración con un token de `az` (AZURE_SQL_TOKEN). */
  DB_AUTH: z.enum(["password", "msi", "token"]).default("msi"),
  AZURE_SQL_TOKEN: z.string().optional(),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),
  DB_TRUST_SERVER_CERT: z.stringbool().default(false),
  DB_CLIENT_ID: z.string().optional(),
  ...whatsappEnvShape,
  ...telegramEnvShape,
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
