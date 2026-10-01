import { describe, expect, it, vi } from "vitest";
import { extractEmails, isAllowedPrincipal, normalizeEmail, parseClientPrincipal } from "@/lib/auth/principal";
import { assertSafeAuthConfig, authenticate } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { ALLOWED, guestPrincipal, principalHeader } from "../helpers";

const env = () => getEnv({ ...process.env });

describe("normalizeEmail", () => {
  it("convierte UPN de invitado externo (#EXT#)", () => {
    expect(normalizeEmail("uziel.francotorres_gmail.com#EXT#@contoso.onmicrosoft.com")).toBe(ALLOWED);
  });
  it("respeta guiones bajos en la parte local (usa el último)", () => {
    expect(normalizeEmail("uziel_franco_gmail.com#EXT#@t.onmicrosoft.com")).toBe("uziel_franco@gmail.com");
  });
  it("es insensible a mayúsculas y espacios", () => {
    expect(normalizeEmail("  Uziel.FrancoTorres@Gmail.com ")).toBe(ALLOWED);
  });
  it("rechaza basura", () => {
    for (const bad of ["", "sin-arroba", "a@b", "x#EXT#@t", "_#EXT#@t.com"]) expect(normalizeEmail(bad)).toBeNull();
  });
});

describe("parseClientPrincipal", () => {
  it("parsea el formato de Easy Auth", () => {
    const p = parseClientPrincipal(principalHeader([{ typ: "email", val: "a@b.com" }]));
    expect(p?.claims).toEqual([{ typ: "email", val: "a@b.com" }]);
  });
  it("devuelve null con base64/JSON inválido, vacío o enorme", () => {
    expect(parseClientPrincipal("%%%")).toBeNull();
    expect(parseClientPrincipal(Buffer.from("no json").toString("base64"))).toBeNull();
    expect(parseClientPrincipal(Buffer.from('{"claims":"x"}').toString("base64"))).toBeNull();
    expect(parseClientPrincipal(null)).toBeNull();
    expect(parseClientPrincipal("A".repeat(20_000))).toBeNull();
  });
});

describe("isAllowedPrincipal", () => {
  const opts = { allowedEmail: ALLOWED };
  it("acepta invitado Gmail por UPN aunque no venga claim email", () => {
    const p = parseClientPrincipal(principalHeader([{ typ: "preferred_username", val: "uziel.francotorres_gmail.com#EXT#@c.onmicrosoft.com" }]))!;
    expect(isAllowedPrincipal(p, opts).allowed).toBe(true);
  });
  it("acepta por claim email normal", () => {
    const p = parseClientPrincipal(principalHeader([{ typ: "email", val: ALLOWED }]))!;
    expect(isAllowedPrincipal(p, opts).allowed).toBe(true);
  });
  it("rechaza otro usuario y subcadenas parecidas", () => {
    for (const v of ["mallory_gmail.com#EXT#@c.onmicrosoft.com", "xuziel.francotorres@gmail.com", "uziel.francotorres@gmail.com.evil.com"]) {
      const p = parseClientPrincipal(principalHeader([{ typ: "email", val: v }, { typ: "preferred_username", val: v }]))!;
      expect(isAllowedPrincipal(p, opts).allowed).toBe(false);
    }
  });
  it("valida tenant cuando se configura", () => {
    const p = parseClientPrincipal(guestPrincipal())!;
    expect(isAllowedPrincipal(p, { ...opts, allowedTenantId: "11111111-1111-1111-1111-111111111111" }).allowed).toBe(true);
    expect(isAllowedPrincipal(p, { ...opts, allowedTenantId: "22222222-2222-2222-2222-222222222222" }).allowed).toBe(false);
  });
  it("usa también X-MS-CLIENT-PRINCIPAL-NAME", () => {
    const p = parseClientPrincipal(principalHeader([]))!;
    expect(extractEmails(p, ALLOWED)).toEqual([ALLOWED]);
  });
});

describe("authenticate", () => {
  it("sin header → 401; usuario no permitido → 403; permitido → ok", () => {
    expect(authenticate(new Headers(), env())).toEqual({ ok: false, status: 401 });
    expect(authenticate(new Headers({ "x-ms-client-principal": guestPrincipal("otro@gmail.com") }), env())).toEqual({ ok: false, status: 403 });
    expect(authenticate(new Headers({ "x-ms-client-principal": guestPrincipal() }), env())).toEqual({ ok: true, user: { email: ALLOWED } });
  });
  it("en modo easyauth un header de dev NO otorga acceso", () => {
    expect(authenticate(new Headers({ "x-dev-user": ALLOWED }), env()).ok).toBe(false);
  });
});

describe("AUTH_MODE=dev jamás en producción", () => {
  it("assertSafeAuthConfig lanza con NODE_ENV=production", () => {
    expect(() => assertSafeAuthConfig({ AUTH_MODE: "dev" }, { NODE_ENV: "production" })).toThrow(/prohibido en producción/);
  });
  it("lanza dentro de App Service aunque NODE_ENV no sea production", () => {
    expect(() => assertSafeAuthConfig({ AUTH_MODE: "dev" }, { WEBSITE_SITE_NAME: "uzfinance" })).toThrow();
  });
  it("permite dev en local y easyauth en producción", () => {
    expect(() => assertSafeAuthConfig({ AUTH_MODE: "dev" }, { NODE_ENV: "development" })).not.toThrow();
    expect(() => assertSafeAuthConfig({ AUTH_MODE: "easyauth" }, { NODE_ENV: "production" })).not.toThrow();
  });
  it("authenticate() se niega a operar en dev+production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => authenticate(new Headers(), { ...env(), AUTH_MODE: "dev" })).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("el arranque (instrumentation.register) aborta con dev+production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("AUTH_MODE", "dev");
    const { resetEnvCache } = await import("@/lib/env");
    resetEnvCache();
    try {
      const { register } = await import("@/instrumentation");
      await expect(register()).rejects.toThrow(/AUTH_MODE=dev/);
    } finally {
      vi.unstubAllEnvs();
      resetEnvCache();
    }
  });
});
