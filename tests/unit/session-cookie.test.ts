import { describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { EASY_AUTH_COOKIE, persistAuthCookie, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session-cookie";

const run = (cookie: string | null) => {
  const h = new Headers();
  const ok = persistAuthCookie(cookie, h);
  return { ok, header: h.get("set-cookie") };
};

describe("persistAuthCookie", () => {
  it("vuelve a emitir la cookie de Easy Auth con Max-Age de 90 días y atributos seguros", () => {
    const { ok, header } = run(`${EASY_AUTH_COOKIE}=abc123`);
    expect(ok).toBe(true);
    expect(header).toBe(`${EASY_AUTH_COOKIE}=abc123; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  });

  it("copia el valor CRUDO: base64 con / + = no se re-codifica (si no, Easy Auth no lo reconocería)", () => {
    const value = "ab/cd+ef0123456789==";
    const { header } = run(`otra=1; ${EASY_AUTH_COOKIE}=${value}; ultima=2`);
    expect(header).toContain(`${EASY_AUTH_COOKIE}=${value};`);
    expect(header).not.toContain("%2F");
    expect(header).not.toContain("%2B");
    expect(header).not.toContain("%3D");
  });

  it("de punta a punta con NextRequest/NextResponse: el Set-Cookie conserva el valor tal cual llegó", () => {
    const value = "x/y+z==";
    const req = new NextRequest("http://localhost/p", { headers: { cookie: `a=1; ${EASY_AUTH_COOKIE}=${value}` } });
    const res = NextResponse.next();
    expect(persistAuthCookie(req.headers.get("cookie"), res.headers)).toBe(true);
    expect(res.headers.get("set-cookie")).toContain(`${EASY_AUTH_COOKIE}=${value};`);
  });

  it("no emite nada si no hay cookie de sesión, está vacía o solo se parece en el nombre", () => {
    for (const c of [null, "", "otra=x", `X${EASY_AUTH_COOKIE}=abc`, `${EASY_AUTH_COOKIE}=`, `${EASY_AUTH_COOKIE}x=abc`]) expect(run(c)).toEqual({ ok: false, header: null });
  });

  it("rechaza valores que podrían inyectar atributos o ser enormes", () => {
    expect(run(`${EASY_AUTH_COOKIE}=abc"def`).ok).toBe(false);
    expect(run(`${EASY_AUTH_COOKIE}=abc,def`).ok).toBe(false);
    expect(run(`${EASY_AUTH_COOKIE}=${"a".repeat(4097)}`).ok).toBe(false);
    expect(run(`${EASY_AUTH_COOKIE}=${"a".repeat(4096)}`).ok).toBe(true);
  });

  it("si la cookie viene dos veces, usa la primera", () => {
    expect(run(`${EASY_AUTH_COOKIE}=primera; ${EASY_AUTH_COOKIE}=segunda`).header).toContain("=primera;");
  });
});
