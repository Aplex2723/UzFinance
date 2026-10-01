import { getEnv, type Env } from "@/lib/env";
import { isAllowedPrincipal, parseClientPrincipal } from "./principal";

export type AuthUser = { email: string };
export type AuthResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401 | 403 };

/**
 * AUTH_MODE=dev se salta la autenticación: solo es válido en un `next dev`
 * local. Se rechaza si NODE_ENV=production o si corre dentro de App Service.
 */
export function assertSafeAuthConfig(env: Pick<Env, "AUTH_MODE">, raw: Record<string, string | undefined> = process.env) {
  if (env.AUTH_MODE === "dev" && (raw.NODE_ENV === "production" || !!raw.WEBSITE_SITE_NAME)) {
    throw new Error("AUTH_MODE=dev está prohibido en producción. Abortando arranque.");
  }
}

export function authenticate(headers: Headers, env: Env = getEnv()): AuthResult {
  assertSafeAuthConfig(env);
  if (env.AUTH_MODE === "dev") {
    return { ok: true, user: { email: env.ALLOWED_EMAIL.toLowerCase() } };
  }
  const principal = parseClientPrincipal(headers.get("x-ms-client-principal"));
  if (!principal) return { ok: false, status: 401 };
  const res = isAllowedPrincipal(principal, {
    allowedEmail: env.ALLOWED_EMAIL,
    allowedTenantId: env.ALLOWED_TENANT_ID,
    principalName: headers.get("x-ms-client-principal-name"),
  });
  return res.allowed && res.email ? { ok: true, user: { email: res.email } } : { ok: false, status: 403 };
}
