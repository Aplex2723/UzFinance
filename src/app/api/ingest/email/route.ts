import { z } from "zod";
import { errorResponse, HttpError, json } from "@/lib/api";
import { getEnv, parseNamedTokens } from "@/lib/env";
import { ingestBankEmail, previewEmail } from "@/lib/repo/emails";
import { BodyTooLargeError, readLimitedText } from "@/lib/security/body";
import { emailFailures as failures, emailPerIp as perIp } from "@/lib/security/ingest-limiters";
import { clientIp } from "@/lib/security/ratelimit";
import { verifyNamedToken } from "@/lib/security/token";
import { BANAMEX_SENDER } from "@/lib/sources/banamex-email";

// Fuera de Easy Auth (excludedPaths): se protege solo con token Bearer propio (distinto al del Atajo).
export const dynamic = "force-dynamic";

const MAX_BODY = 64 * 1024;

const emailSchema = z
  .object({
    messageId: z.string().regex(/^[A-Za-z0-9._:@<>+=-]{4,200}$/),
    from: z.string().trim().min(1).max(200),
    subject: z.string().trim().min(1).max(300),
    receivedAt: z.iso.datetime({ offset: true }),
    bodyText: z.string().max(60_000),
  })
  .strict();

function tooMany(ip: string) {
  return json({ error: "Demasiadas solicitudes" }, 429, { "Retry-After": String(failures.retryAfterSeconds(ip)) });
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req.headers);
  if (failures.blocked(ip) || !perIp.hit(ip)) return tooMany(ip);

  const raw = getEnv().EMAIL_INGEST_TOKENS;
  const tokens = raw ? (parseNamedTokens(raw) ?? []) : [];
  if (!verifyNamedToken(req.headers.get("authorization"), tokens)) {
    failures.hit(ip);
    return json({ error: "No autorizado" }, 401, { "WWW-Authenticate": "Bearer" });
  }

  try {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "Content-Type debe ser application/json");
    }
    const text = await readLimitedText(req, MAX_BODY);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "JSON malformado");
    }
    const p = emailSchema.parse(body);
    if (p.from.toLowerCase() !== BANAMEX_SENDER) throw new HttpError(403, "Remitente no permitido");
    const message = { messageId: p.messageId, from: BANAMEX_SENDER, subject: p.subject, bodyText: p.bodyText, receivedAt: new Date(p.receivedAt) };

    // Solo valida y reporta cómo se interpretaría; no escribe nada.
    if (req.headers.get("x-dry-run") === "1") return json({ ...(await previewEmail(message)), dryRun: true });

    return json(await ingestBankEmail(message));
  } catch (e) {
    if (e instanceof z.ZodError || e instanceof HttpError || e instanceof BodyTooLargeError) return errorResponse(e);
    // Nunca se registra el cuerpo del correo: solo el mensaje del error.
    console.error("[ingest/email] fallo:", (e as Error)?.message);
    return json({ error: "Servicio no disponible, reintenta" }, 503, { "Retry-After": "30" });
  }
}
