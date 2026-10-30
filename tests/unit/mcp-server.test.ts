import { describe, expect, it, vi } from "vitest";
import { TOOL_SPECS } from "@/lib/chat/tools";
import { handleMessage, MCP_TOOLS, SUPPORTED_VERSIONS, type McpDeps } from "@/lib/mcp/server";

const deps = (callTool: McpDeps["callTool"] = async () => ({ ok: true, content: "{}" })): McpDeps => ({ callTool });
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ask = async (msg: unknown, d = deps()) => (await handleMessage(msg, d)) as any;

describe("MCP: initialize", () => {
  it("devuelve la versión pedida si la soporta, con capacidades de herramientas e instrucciones", async () => {
    for (const v of SUPPORTED_VERSIONS) {
      const r = await ask(rpc("initialize", { protocolVersion: v, capabilities: {}, clientInfo: { name: "x", version: "1" } }));
      expect(r.result.protocolVersion).toBe(v);
      expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(r.result.serverInfo.name).toBe("uzfinance");
      expect(r.result.instructions).toMatch(/read-only/);
    }
  });
  it("con una versión desconocida (o ninguna) propone la más reciente que soporta", async () => {
    expect((await ask(rpc("initialize", { protocolVersion: "2099-01-01" }))).result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
    expect((await ask(rpc("initialize"))).result.protocolVersion).toBe(SUPPORTED_VERSIONS[0]);
  });
  it("conserva el id del cliente (texto o número)", async () => {
    expect((await ask(rpc("ping", undefined, "abc"))).id).toBe("abc");
    expect((await ask(rpc("ping", undefined, 0))).id).toBe(0);
  });
});

describe("MCP: tools/list", () => {
  it("expone exactamente las herramientas de UzChat, todas de solo lectura y con esquema JSON", async () => {
    const { tools } = (await ask(rpc("tools/list"))).result;
    expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));
    expect(tools.length).toBeGreaterThanOrEqual(12);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.$schema).toBeUndefined();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    expect(MCP_TOOLS).toHaveLength(tools.length);
  });
  it("ninguna herramienta puede escribir: nada de create/update/delete/set en los nombres", () => {
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /create|update|delete|set_|write|add_|remove/.test(n))).toEqual([]);
  });
});

describe("MCP: tools/call", () => {
  it("ejecuta la herramienta con los argumentos tal cual y devuelve el texto como contenido", async () => {
    const call = vi.fn(async () => ({ ok: true, content: '{"total_gastado":123.45}' }));
    const r = await ask(rpc("tools/call", { name: "spending_summary", arguments: { month: "2026-07" } }), deps(call));
    expect(call).toHaveBeenCalledWith("spending_summary", '{"month":"2026-07"}');
    expect(r.result).toEqual({ content: [{ type: "text", text: '{"total_gastado":123.45}' }], isError: false });
  });
  it("sin 'arguments' se llama con objeto vacío", async () => {
    const call = vi.fn(async () => ({ ok: true, content: "{}" }));
    await ask(rpc("tools/call", { name: "month_overview" }), deps(call));
    expect(call).toHaveBeenCalledWith("month_overview", "{}");
  });
  it("un fallo de la herramienta es un resultado con isError (no un error del protocolo)", async () => {
    const r = await ask(rpc("tools/call", { name: "spending_summary", arguments: {} }), deps(async () => ({ ok: false, content: '{"error":"mes inválido"}' })));
    expect(r.error).toBeUndefined();
    expect(r.result.isError).toBe(true);
  });
  it("herramienta desconocida, sin nombre o con arguments que no es objeto → -32602 sin ejecutar nada", async () => {
    const call = vi.fn(async () => ({ ok: true, content: "{}" }));
    for (const params of [{ name: "drop_table" }, {}, { name: 5 }, { name: "calculate", arguments: [1] }, { name: "calculate", arguments: "1+1" }]) {
      const r = await ask(rpc("tools/call", params), deps(call));
      expect(r.error?.code, JSON.stringify(params)).toBe(-32602);
    }
    expect(call).not.toHaveBeenCalled();
  });
});

describe("MCP: forma del mensaje", () => {
  it("las notificaciones (sin id) y las respuestas del cliente no se contestan", async () => {
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, deps())).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", method: "método/que/no/existe" }, deps())).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", id: 7, result: {} }, deps())).toBeNull();
    expect(await handleMessage({ jsonrpc: "2.0", id: 7, error: { code: 1, message: "x" } }, deps())).toBeNull();
  });
  it("método desconocido → -32601; mensaje mal formado → -32600", async () => {
    expect((await ask(rpc("resources/list"))).error.code).toBe(-32601);
    for (const bad of [null, 5, "x", [], {}, { id: 1, method: "ping" }, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, method: 3 }]) {
      const r = await ask(bad);
      expect(r.error?.code, JSON.stringify(bad)).toBe(-32600);
    }
  });
  it("el error de una solicitud sin método conserva su id; si el id mismo es inválido, va null", async () => {
    expect((await ask({ jsonrpc: "2.0", id: 9 })).id).toBe(9);
    expect((await ask({ jsonrpc: "2.0", id: {}, method: "ping" })).id).toBeNull();
  });
  it("no refleja textos largos del cliente en el error", async () => {
    const r = await ask(rpc("x".repeat(500)));
    expect(r.error.message.length).toBeLessThan(120);
  });
});
