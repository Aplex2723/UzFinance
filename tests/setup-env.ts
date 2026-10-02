import { config } from "dotenv";

// En local toma credenciales de .env; en CI vienen del entorno del workflow.
config({ quiet: true });
process.env.DB_NAME = "uzfinance_test";
process.env.DB_AUTH = "password";
process.env.AUTH_MODE = "easyauth";
process.env.ALLOWED_EMAIL = "uziel.francotorres@gmail.com";
process.env.INGEST_TOKEN = "test-token-0123456789-abcdefghijklmnopqrstuvwxyz";
process.env.INGEST_TOKEN_PREVIOUS = "";
delete process.env.INGEST_TOKEN_PREVIOUS;
delete process.env.ALLOWED_TENANT_ID;
process.env.CATEGORIZER = "rules";
process.env.DB_TRUST_SERVER_CERT = "true";
process.env.DB_SERVER ??= "localhost";
process.env.EMAIL_INGEST_TOKENS = "gmail=email-token-0123456789-abcdefghijklmnopqrstuvwxyz,viejo=old-email-token-0123456789-abcdefghijklmnopqrstuvwx";
