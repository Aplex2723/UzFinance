import { errorResponse, HttpError, ingestEnv, json } from "@/lib/api";
import { getCategorizer } from "@/lib/categorizer";
import { ingestTransaction } from "@/lib/repo/transactions";
import { BodyTooLargeError, readLimitedText } from "@/lib/security/body";
import { ingestFailures as failures, ingestPerIp as perIp } from "@/lib/security/ingest-limiters";
import { clientIp } from "@/lib/security/ratelimit";
import { verifyIngestToken } from "@/lib/security/token";
import { ingestSchema, toRaw } from "@/lib/sources/shortcut";
import { MoneyParseError } from "@/lib/money";
import { z } from "zod";

// Único endpoint fuera de Easy Auth (excludedPaths): se protege solo con token.
export const dynamic = "force-dynamic";

const MAX_BODY = 8 * 1024;
function tooMany(ip: string) {
  return json({ error: "Demasiadas solicitudes" }, 429, { "Retry-After": String(failures.retryAfterSeconds(ip)) });
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req.headers);
  if (failures.blocked(ip) || !perIp.hit(ip)) return tooMany(ip);

  const { token, previous } = ingestEnv();
  if (!verifyIngestToken(req.headers.get("authorization"), token, previous)) {
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
    const payload = ingestSchema.parse(body);
    const raw = (() => {
      try {
        return toRaw(payload);
      } catch (e) {
        if (e instanceof MoneyParseError) throw new HttpError(400, e.message);
        throw e;
      }
    })();

    // Validación completa sin escribir: sirve para probar el Atajo y como smoke test.
    if (req.headers.get("x-dry-run") === "1") return json({ status: "ok", dryRun: true });

    const result = await ingestTransaction(raw, "shortcut", { categorizer: await getCategorizer() });
    return json(result.status === "duplicate"
      ? { status: "duplicate", cardMatched: result.cardMatched }
      : { status: result.status, id: result.id, cardMatched: result.cardMatched });
  } catch (e) {
    if (e instanceof z.ZodError || e instanceof HttpError || e instanceof BodyTooLargeError) return errorResponse(e);
    // Base no disponible (p. ej. reanudando de auto-pause): 503 para que el Atajo reintente.
    console.error("[ingest] fallo:", (e as Error)?.message);
    return json({ error: "Servicio no disponible, reintenta" }, 503, { "Retry-After": "30" });
  }
}
