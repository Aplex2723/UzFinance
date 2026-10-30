import { mcpNotAllowed, mcpPost } from "@/lib/mcp/http";

// Servidor MCP (solo lectura). Fuera de Easy Auth (excludedPaths): un cliente de IA no tiene sesión de Entra, así que se autentica con
// un token Bearer propio (MCP_TOKENS) comparado en tiempo constante; sin tokens configurados rechaza todo. La lógica vive en
// src/lib/mcp/ (un route.ts de Next solo puede exportar handlers y configuración).
export const dynamic = "force-dynamic";

export const POST = mcpPost;
export const GET = mcpNotAllowed;
export const DELETE = mcpNotAllowed;
