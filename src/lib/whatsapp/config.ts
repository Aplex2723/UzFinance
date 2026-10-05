import { z } from "zod";
import { whatsappEnvShape } from "@/lib/env";
import { parseAllowed } from "./allowlist";
import type { Sender } from "./types";

export type WhatsAppConfig = {
  verifyToken: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  allowed: Sender[];
  /** URL pública de la app (sin "/" final) o null si no se pudo deducir. */
  appUrl: string | null;
};

export const DEFAULT_GRAPH_VERSION = "v25.0";

const rawSchema = z.object(whatsappEnvShape);
type Source = Record<string, string | undefined>;

/** Sin `source` lee process.env en cada llamada (barato), así un cambio de App Settings aplica al reiniciar y las pruebas pueden variarlo. */
function read(source: Source) {
  const p = rawSchema.safeParse(source);
  const r: Record<string, unknown> = p.success ? p.data : {};
  const v = (k: string): string | undefined => (typeof r[k] === "string" ? (r[k] as string).trim() : undefined);
  return { v };
}

function deduceAppUrl(env: ReturnType<typeof read>["v"]): string | null {
  const explicit = env("APP_URL");
  if (explicit) {
    try {
      const u = new URL(explicit);
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) return u.origin;
    } catch {
      /* cae a WEBSITE_HOSTNAME */
    }
  }
  const host = env("WEBSITE_HOSTNAME");
  if (host && /^[A-Za-z0-9.-]{1,253}$/.test(host)) return `https://${host.toLowerCase()}`;
  return null;
}

/** Nombres (nunca valores) de las variables requeridas que faltan o son inválidas. Vacío = configuración completa. */
export function whatsAppConfigIssues(source: Source = process.env): string[] {
  const { v } = read(source);
  const bad: string[] = [];
  const verify = v("WHATSAPP_VERIFY_TOKEN");
  if (!verify || verify.length < 16) bad.push("WHATSAPP_VERIFY_TOKEN");
  const secret = v("WHATSAPP_APP_SECRET");
  if (!secret || secret.length < 16) bad.push("WHATSAPP_APP_SECRET");
  const access = v("WHATSAPP_ACCESS_TOKEN");
  if (!access || access.length < 20) bad.push("WHATSAPP_ACCESS_TOKEN");
  const phone = v("WHATSAPP_PHONE_NUMBER_ID");
  if (!phone || !/^\d{5,25}$/.test(phone)) bad.push("WHATSAPP_PHONE_NUMBER_ID");
  const allowed = v("WHATSAPP_ALLOWED");
  if (!allowed || !parseAllowed(allowed)) bad.push("WHATSAPP_ALLOWED");
  const ver = v("WHATSAPP_GRAPH_VERSION");
  if (ver !== undefined && !/^v\d+\.\d+$/.test(ver)) bad.push("WHATSAPP_GRAPH_VERSION");
  return bad;
}

/**
 * Configuración del bot o `null` si falta o es inválido CUALQUIER requerido: el webhook falla cerrado (no procesa nada).
 * Nunca incluye secretos en errores ni en logs.
 */
export function getWhatsAppConfig(source: Source = process.env): WhatsAppConfig | null {
  if (whatsAppConfigIssues(source).length) return null;
  const { v } = read(source);
  return {
    verifyToken: v("WHATSAPP_VERIFY_TOKEN")!,
    appSecret: v("WHATSAPP_APP_SECRET")!,
    accessToken: v("WHATSAPP_ACCESS_TOKEN")!,
    phoneNumberId: v("WHATSAPP_PHONE_NUMBER_ID")!,
    graphVersion: v("WHATSAPP_GRAPH_VERSION") ?? DEFAULT_GRAPH_VERSION,
    allowed: parseAllowed(v("WHATSAPP_ALLOWED")!)!,
    appUrl: deduceAppUrl(v),
  };
}
