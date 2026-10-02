import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/session";

/**
 * Defensa en profundidad + CSP con nonce.
 *  0) Excluidos del matcher: estáticos públicos (íconos y manifest) que el navegador pide sin cookies.
 *  1) Valida la sesión de Easy Auth (X-MS-CLIENT-PRINCIPAL + allowlist) para todo
 *     salvo /api/ingest y /api/ingest/email, que usan su propio token Bearer.
 *  2) Cada handler y página vuelve a validar: este archivo no es la única barrera.
 */
/** Fuera de Easy Auth: cada uno se autentica con su propio token Bearer. */
const TOKEN_AUTH_PATHS = new Set(["/api/ingest", "/api/ingest/email"]);

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!TOKEN_AUTH_PATHS.has(pathname)) {
    const auth = authenticate(request.headers);
    if (!auth.ok) {
      const msg = auth.status === 401 ? "No autenticado" : "No autorizado";
      return pathname.startsWith("/api/")
        ? NextResponse.json({ error: msg }, { status: auth.status, headers: { "Cache-Control": "no-store" } })
        : new NextResponse(msg, { status: auth.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'", // Recharts/SVG usan style="" en línea
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|icons/).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
