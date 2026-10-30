import { config } from "dotenv";
config({ quiet: true });

/** Variables del servidor y de las pruebas e2e (base propia: uzfinance_e2e). */
export const E2E_PORT = 3200;
export const E2E_TOKEN = "e2e-token-0123456789-abcdefghijklmnopqrstuvwxyz";
export const E2E_ENV = {
  ...process.env,
  NODE_ENV: "production",
  AUTH_MODE: "easyauth",
  ALLOWED_EMAIL: "owner@example.com",
  INGEST_TOKEN: E2E_TOKEN,
  EMAIL_INGEST_TOKENS: "gmail=e2e-email-token-0123456789-abcdefghijklmnopqrstuvwxyz",
  DB_NAME: "uzfinance_e2e",
  DB_AUTH: "password",
  DB_SERVER: process.env.DB_SERVER ?? "localhost",
  DB_TRUST_SERVER_CERT: "true",
  CATEGORIZER: "rules",
  // Llave falsa: UzChat se ve "configurado" y, si algo llegara a llamar a OpenRouter, falla con 401 en vez de gastar o mandar datos.
  OPENROUTER_API_KEY: "sk-or-e2e-fake-key-0123456789",
  PORT: String(E2E_PORT),
} as unknown as NodeJS.ProcessEnv & Record<string, string>;

export const principal = (email: string) =>
  Buffer.from(JSON.stringify({ auth_typ: "aad", claims: [
    { typ: "preferred_username", val: `${email.replace("@", "_")}#EXT#@contoso.onmicrosoft.com` },
    { typ: "email", val: email },
  ] })).toString("base64");
