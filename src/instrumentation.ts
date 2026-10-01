/** Se ejecuta al arrancar el servidor: aborta si la configuración es insegura. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getEnv } = await import("@/lib/env");
  const { assertSafeAuthConfig } = await import("@/lib/auth/session");
  assertSafeAuthConfig(getEnv());
}
