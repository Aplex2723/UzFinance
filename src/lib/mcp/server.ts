import { TOOL_SPECS, toolLabel, type ToolOutcome } from "@/lib/chat/tools";

/**
 * Servidor MCP (Model Context Protocol) de UzFinance: JSON-RPC 2.0 sin estado, solo lectura. Expone las MISMAS herramientas de
 * UzChat (consultas de gasto, categorías, comercios, MSI, metas…), así que lo que un cliente externo puede ver es exactamente lo que
 * ya decidió el dueño que ve UzChat. Aquí vive el protocolo; la autenticación y los límites están en ./http.ts.
 */

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SERVER_INSTRUCTIONS =
  "UzFinance: personal finance data of a single owner in Mexico (read-only). All amounts are in Mexican pesos (MXN) and all dates are " +
  "YYYY-MM-DD; field names are in Spanish. Call the tools to get facts and quote them as returned; use `calculate` for any arithmetic " +
  "instead of computing by hand. Periods default to the current month up to today. Tools never return notes, authorization codes or " +
  "account numbers, and nothing can be modified through this server.";

export type RpcId = string | number | null;
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result: unknown } | { jsonrpc: "2.0"; id: RpcId; error: { code: number; message: string } };

const rpcError = (id: RpcId, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

export const MCP_TOOLS = TOOL_SPECS.map((t) => ({
  name: t.name,
  title: toolLabel(t.name),
  description: t.description,
  inputSchema: t.parameters,
  annotations: { title: toolLabel(t.name), readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}));
const KNOWN = new Set(MCP_TOOLS.map((t) => t.name));

export type McpDeps = {
  /** Ejecuta una herramienta con el contexto (categorías, tarjetas, fecha) ya cargado. Nunca lanza. */
  callTool: (name: string, rawArgs: string) => Promise<ToolOutcome>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Atiende UN mensaje JSON-RPC. Devuelve `null` cuando no se debe responder (notificaciones y respuestas del cliente).
 * Sin estado: no se exige `initialize` antes de `tools/*` (cada petición HTTP es independiente).
 */
export async function handleMessage(msg: unknown, deps: McpDeps): Promise<RpcResponse | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return rpcError(null, -32600, "Solicitud inválida");
  const hasId = "id" in msg;
  const id = msg.id;
  if (hasId && !(typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))) return rpcError(null, -32600, "Solicitud inválida");
  // Respuesta del cliente a algo que nunca le pedimos: se ignora.
  if (typeof msg.method !== "string") return hasId && ("result" in msg || "error" in msg) ? null : rpcError(hasId ? (id as RpcId) : null, -32600, "Solicitud inválida");
  // Notificación (sin id): nunca lleva respuesta, ni de error.
  if (!hasId) return null;
  const rid = id as RpcId;
  const params = isObject(msg.params) ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(asked) ? asked : SUPPORTED_VERSIONS[0];
      return rpcResult(rid, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "uzfinance", title: "UzFinance", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(rid, {});
    case "tools/list":
      return rpcResult(rid, { tools: MCP_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !KNOWN.has(name)) return rpcError(rid, -32602, `Herramienta desconocida: ${typeof name === "string" ? name.slice(0, 60) : "(sin nombre)"}`);
      if (params.arguments !== undefined && !isObject(params.arguments)) return rpcError(rid, -32602, "'arguments' debe ser un objeto");
      const out = await deps.callTool(name, JSON.stringify(params.arguments ?? {}));
      // Un fallo de la herramienta NO es un error del protocolo: va como resultado con isError para que el modelo lo lea y corrija.
      return rpcResult(rid, { content: [{ type: "text", text: out.content }], isError: !out.ok });
    }
    default:
      return rpcError(rid, -32601, `Método no soportado: ${msg.method.slice(0, 60)}`);
  }
}
