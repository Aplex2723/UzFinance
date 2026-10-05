import { query } from "@/lib/db/pool";

export const ALLOWED = "uziel.francotorres@gmail.com";
export const EMAIL_TOKEN = "email-token-0123456789-abcdefghijklmnopqrstuvwxyz";
export const TOKEN = "test-token-0123456789-abcdefghijklmnopqrstuvwxyz";

export function principalHeader(claims: { typ: string; val: string }[]) {
  return Buffer.from(JSON.stringify({ auth_typ: "aad", name_typ: "name", role_typ: "roles", claims })).toString("base64");
}
/** Invitado externo B2B con Gmail, como lo entrega Entra. */
export const guestPrincipal = (email = ALLOWED) =>
  principalHeader([
    { typ: "preferred_username", val: `${email.replace("@", "_")}#EXT#@contoso.onmicrosoft.com` },
    { typ: "email", val: email },
    { typ: "http://schemas.microsoft.com/identity/claims/tenantid", val: "11111111-1111-1111-1111-111111111111" },
  ]);

export function req(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; raw?: string } = {}) {
  const body = init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? (body !== undefined ? "POST" : "GET"),
    headers: { host: "localhost:3000", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body,
  });
}
export const authed = (extra: Record<string, string> = {}) => ({ "x-ms-client-principal": guestPrincipal(), ...extra });
export const ctx = <P extends Record<string, string>>(p?: P) => ({ params: Promise.resolve((p ?? {}) as P) });

export async function resetDb() {
  await query("DELETE FROM dbo.alert_outbox; DELETE FROM dbo.alerts; DELETE FROM dbo.recon_findings; DELETE FROM dbo.recon_runs; DELETE FROM dbo.documents; DELETE FROM dbo.app_settings WHERE [key] <> 'monthly_income_cents'; DELETE FROM dbo.unparsed_emails; DELETE FROM dbo.transactions; DELETE FROM dbo.installment_plans; DELETE FROM dbo.category_rules; DELETE FROM dbo.categories; DELETE FROM dbo.cards;");
}
