import { z } from "zod";
import { authenticate, type AuthUser } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { BodyTooLargeError, readLimitedText } from "@/lib/security/body";
import { ConflictError } from "@/lib/repo/cards";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (a: { req: Request; user: AuthUser; params: P }) => Promise<Response>;

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Origin presente pero distinto del host → petición cross-site: se rechaza. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Envoltorio de toda ruta protegida: sesión (401/403), anti-CSRF, manejo de
 * errores sin filtrar detalles internos.
 */
export function protectedRoute<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    const auth = authenticate(req.headers);
    if (!auth.ok) return json({ error: auth.status === 401 ? "No autenticado" : "No autorizado" }, auth.status);
    if (MUTATING.has(req.method) && !isSameOrigin(req)) return json({ error: "Origen no permitido" }, 403);
    try {
      return await handler({ req, user: auth.user, params: await ctx.params });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, e.status);
  if (e instanceof ConflictError) return json({ error: e.message }, 409);
  if (e instanceof BodyTooLargeError) return json({ error: "Cuerpo demasiado grande" }, 413);
  if (e instanceof z.ZodError) return json({ error: "Datos inválidos", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  // Solo el mensaje: nunca el payload ni la cadena de conexión.
  console.error("[api] error no controlado:", (e as Error)?.message);
  return json({ error: "Error interno" }, 500);
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = 64 * 1024): Promise<z.output<S>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type debe ser application/json");
  }
  const text = await readLimitedText(req, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "JSON malformado");
  }
  return schema.parse(body);
}

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.output<S> {
  const obj = Object.fromEntries(new URL(req.url).searchParams);
  return schema.parse(obj);
}

export function ingestEnv() {
  const e = getEnv();
  return { token: e.INGEST_TOKEN, previous: e.INGEST_TOKEN_PREVIOUS };
}
