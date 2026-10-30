import { errorResponse, HttpError, json } from "@/lib/api";
import { loadChatContext } from "@/lib/chat/context";
import { executeTool, type ToolCtx } from "@/lib/chat/tools";
import { getEnv, parseNamedTokens } from "@/lib/env";
import { BodyTooLargeError, readLimitedText } from "@/lib/security/body";
import { mcpFailures as failures, mcpPerIp as perIp, mcpPerToken as perToken } from "@/lib/security/ingest-limiters";
import { clientIp } from "@/lib/security/ratelimit";
import { verifyNamedToken } from "@/lib/security/token";
import { handleMessage, type RpcResponse } from "./server";

/**
 * Transporte HTTP del servidor MCP ("Streamable HTTP" sin estado: cada POST es un mensaje JSON-RPC, o un lote, y se responde con
 * JSON; nunca se abre un flujo SSE). Fuera de Easy Auth (excludedPaths): un cliente de IA no tiene sesión de Entra, así que la
 * autenticación es un token Bearer propio y revocable por cliente (MCP_TOKENS), comparado en tiempo constante. Sin tokens
 * configurados falla cerrado. Es solo lectura: no hay ninguna herramienta que escriba.
 */

const MAX_BODY = 64 * 1024;
const MAX_BATCH = 10;

const rpc = (body: unknown, status = 200, headers: Record<string, string> = {}) => json(body, status, headers);
const accepted = () => new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

function tooMany(retry: number) {
  return json({ error: "Demasiadas solicitudes" }, 429, { "Retry-After": String(retry) });
}

/** Contexto de las herramientas (categorías, tarjetas, ingreso): una consulta corta, y solo si de verdad se llama a una herramienta. */
function lazyToolCtx(): () => Promise<ToolCtx> {
  let cached: Promise<ToolCtx> | null = null;
  return () => (cached ??= loadChatContext());
}

async function handle(req: Request): Promise<{ res: Response; who: string; methods: string[] }> {
  const ip = clientIp(req.headers);
  if (failures.blocked(ip) || !perIp.hit(ip)) return { res: tooMany(failures.retryAfterSeconds(ip)), who: "-", methods: [] };

  // Un navegador siempre manda Origin: ningún cliente MCP legítimo (CLI, IDE, servidor) lo hace, y así una página web ajena no puede
  // usar el navegador de quien tiene un token guardado. Se rechaza antes de mirar el token.
  if (req.headers.get("origin")) return { res: json({ error: "Origen no permitido" }, 403), who: "-", methods: [] };

  const raw = getEnv().MCP_TOKENS;
  const tokens = raw ? (parseNamedTokens(raw) ?? []) : [];
  const who = verifyNamedToken(req.headers.get("authorization"), tokens);
  if (!who) {
    failures.hit(ip);
    return { res: json({ error: "No autorizado" }, 401, { "WWW-Authenticate": "Bearer" }), who: "-", methods: [] };
  }
  if (!perToken.hit(who)) return { res: tooMany(perToken.retryAfterSeconds(who)), who, methods: [] };

  try {
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Content-Type debe ser application/json");
    let body: unknown;
    try {
      body = JSON.parse(await readLimitedText(req, MAX_BODY));
    } catch (e) {
      if (e instanceof BodyTooLargeError) throw e;
      return { res: rpc({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON malformado" } }, 400), who, methods: [] };
    }

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.length > MAX_BATCH) {
      return { res: rpc({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `El lote debe tener de 1 a ${MAX_BATCH} mensajes` } }, 400), who, methods: [] };
    }
    const methods = messages.map((m) => (typeof m?.method === "string" ? String(m.method).slice(0, 40) : "?"));
    const ctx = lazyToolCtx();
    const callTool = async (name: string, rawArgs: string) => {
      try {
        return await executeTool(name, rawArgs, await ctx());
      } catch (e) {
        // Normalmente la base reanudándose de auto-pause: se le dice al modelo en vez de romper el protocolo.
        console.error("[mcp] no se pudo cargar el contexto:", (e as Error)?.message);
        return { ok: false, content: JSON.stringify({ error: "No pude consultar tus datos en este momento; reintenta en unos segundos" }) };
      }
    };

    // En orden y de uno en uno: las herramientas son consultas cortas y así un lote no abre decenas de conexiones a la base.
    const out: RpcResponse[] = [];
    for (const m of messages) {
      const r = await handleMessage(m, { callTool });
      if (r) out.push(r);
    }
    if (out.length === 0) return { res: accepted(), who, methods };
    return { res: rpc(Array.isArray(body) ? out : out[0]), who, methods };
  } catch (e) {
    if (e instanceof HttpError || e instanceof BodyTooLargeError) return { res: errorResponse(e), who, methods: [] };
    console.error("[mcp] fallo:", (e as Error)?.message);
    return { res: json({ error: "Servicio no disponible, reintenta" }, 503, { "Retry-After": "30" }), who, methods: [] };
  }
}

/** Una línea por solicitud: quién (nombre del token), qué métodos y cuánto tardó. Nunca argumentos ni resultados (son datos financieros). */
export async function mcpPost(req: Request): Promise<Response> {
  const t0 = Date.now();
  const { res, who, methods } = await handle(req);
  console.log(`[mcp] status=${res.status} token=${who} methods=${methods.join(",") || "-"} ms=${Date.now() - t0}`);
  return res;
}

/** No se ofrece el flujo SSE del servidor ni sesiones: GET y DELETE responden 405 (permitido por la especificación). */
export function mcpNotAllowed(): Response {
  return json({ error: "Método no permitido" }, 405, { Allow: "POST" });
}
