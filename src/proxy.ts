import { NextRequest, NextResponse } from "next/server";
import { authenticate } from "@/lib/auth/session";
import { persistAuthCookie } from "@/lib/auth/session-cookie";

/**
 * Defensa en profundidad + CSP con nonce.
 *  0) Excluidos del matcher: estáticos públicos (íconos y manifest) que el navegador pide sin cookies.
 *  1) Valida la sesión de Easy Auth (X-MS-CLIENT-PRINCIPAL + allowlist) para todo
 *     salvo /api/ingest y /api/ingest/email (token Bearer propio), /api/whatsapp (verify token de Meta + firma HMAC del cuerpo) y
 *     /api/telegram (encabezado secreto X-Telegram-Bot-Api-Secret-Token).
 *  2) Cada handler y página vuelve a validar: este archivo no es la única barrera.
 *  3) Rutas sin sesión (webhooks e ingest): 413 por Content-Length declarado excesivo antes de que Next copie el cuerpo en memoria.
 */
/** Fuera de Easy Auth: cada uno se autentica por su cuenta (token Bearer; el webhook de WhatsApp, con la firma X-Hub-Signature-256 de Meta;
 *  el de Telegram, con el secret_token del setWebhook). Rutas EXACTAS: nada de prefijos. */
const TOKEN_AUTH_PATHS = new Set(["/api/ingest", "/api/ingest/email", "/api/whatsapp", "/api/telegram"]);

/**
 * Next copia en memoria el cuerpo de lo que pasa por este proxy (hasta `proxyClientMaxBodySize`, 14 MB por los PDF de la app). Las rutas
 * sin sesión (webhooks e ingest) no necesitan ni de lejos eso, así que se rechaza con 413 por el `Content-Length` DECLARADO antes de
 * seguir. Cada handler vuelve a limitar los bytes realmente leídos (cubre cuerpos sin Content-Length). `/api/documents` no se toca.
 */
const BODY_LIMITS: [match: (p: string) => boolean, maxBytes: number][] = [
  [(p) => p === "/api/whatsapp" || p === "/api/telegram", 256 * 1024],
  [(p) => p === "/api/ingest" || p.startsWith("/api/ingest/"), 64 * 1024],
];

function declaredTooLarge(pathname: string, contentLength: string | null): boolean {
  if (contentLength === null) return false;
  const limit = BODY_LIMITS.find(([match]) => match(pathname))?.[1];
  if (limit === undefined) return false;
  const n = Number(contentLength.trim());
  // Un Content-Length ilegible tampoco pasa: no se puede confiar en cuánto se copiará.
  return !Number.isFinite(n) || n < 0 || n > limit;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (declaredTooLarge(pathname, request.headers.get("content-length"))) {
    return NextResponse.json({ error: "Cuerpo demasiado grande" }, { status: 413, headers: { "Cache-Control": "no-store" } });
  }

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
  if (!TOKEN_AUTH_PATHS.has(pathname)) persistAuthCookie(request.headers.get("cookie"), response.headers);
  return response;
}

export const config = {
  matcher: [{ source: "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|icons/).*)", missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }] }],
};
