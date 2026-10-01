/**
 * Parseo de X-MS-CLIENT-PRINCIPAL (App Service Authentication / Easy Auth)
 * y match robusto del correo contra el allowlist.
 *
 * Un invitado externo (B2B) con Gmail aparece con UPN
 *   usuario_gmail.com#EXT#@tenant.onmicrosoft.com
 * y normalmente también trae un claim `email` real. Se prueban todos los
 * candidatos y se normalizan; basta con que uno coincida exactamente.
 */

export type PrincipalClaim = { typ: string; val: string };
export type ClientPrincipal = {
  auth_typ?: string;
  name_typ?: string;
  role_typ?: string;
  claims: PrincipalClaim[];
};

const MAX_HEADER_BYTES = 16 * 1024;

export function parseClientPrincipal(header: string | null | undefined): ClientPrincipal | null {
  if (!header || header.length > MAX_HEADER_BYTES) return null;
  try {
    const json = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    if (!json || typeof json !== "object" || !Array.isArray(json.claims)) return null;
    const claims: PrincipalClaim[] = [];
    for (const c of json.claims) {
      if (c && typeof c.typ === "string" && typeof c.val === "string") {
        claims.push({ typ: c.typ, val: c.val });
      }
    }
    return {
      auth_typ: typeof json.auth_typ === "string" ? json.auth_typ : undefined,
      name_typ: typeof json.name_typ === "string" ? json.name_typ : undefined,
      role_typ: typeof json.role_typ === "string" ? json.role_typ : undefined,
      claims,
    };
  } catch {
    return null;
  }
}

/** usuario_gmail.com#EXT#@tenant.onmicrosoft.com -> usuario@gmail.com */
export function normalizeEmail(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v) return null;
  const ext = v.indexOf("#ext#");
  if (ext !== -1) {
    const local = v.slice(0, ext);
    const us = local.lastIndexOf("_");
    if (us <= 0) return null;
    v = `${local.slice(0, us)}@${local.slice(us + 1)}`;
  }
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

const EMAIL_CLAIM_TYPES = new Set([
  "email",
  "emails",
  "preferred_username",
  "upn",
  "unique_name",
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
]);

export function extractEmails(p: ClientPrincipal, principalName?: string | null): string[] {
  const out = new Set<string>();
  const add = (raw: string | null | undefined) => {
    if (!raw) return;
    const n = normalizeEmail(raw);
    if (n) out.add(n);
  };
  for (const c of p.claims) if (EMAIL_CLAIM_TYPES.has(c.typ.toLowerCase())) add(c.val);
  add(principalName);
  return [...out];
}

export const TENANT_CLAIMS = [
  "tid",
  "http://schemas.microsoft.com/identity/claims/tenantid",
];

export function tenantOf(p: ClientPrincipal): string | undefined {
  return p.claims.find((c) => TENANT_CLAIMS.includes(c.typ.toLowerCase()))?.val.toLowerCase();
}

export function isAllowedPrincipal(
  p: ClientPrincipal,
  opts: { allowedEmail: string; allowedTenantId?: string; principalName?: string | null },
): { allowed: boolean; email?: string } {
  const allowed = normalizeEmail(opts.allowedEmail);
  if (!allowed) return { allowed: false };
  if (opts.allowedTenantId && tenantOf(p) !== opts.allowedTenantId.toLowerCase()) {
    return { allowed: false };
  }
  const emails = extractEmails(p, opts.principalName);
  return emails.includes(allowed) ? { allowed: true, email: allowed } : { allowed: false };
}
