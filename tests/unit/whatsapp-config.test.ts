import { describe, expect, it } from "vitest";
import { findSender, maskNumber, normalizeNumber, parseAllowed } from "@/lib/whatsapp/allowlist";
import { getWhatsAppConfig, whatsAppConfigIssues } from "@/lib/whatsapp/config";
import { getEnv } from "@/lib/env";
import { WA, WA_ENV } from "../wa-webhook-fixtures";

const cfg = (over: Record<string, string | undefined> = {}) => getWhatsAppConfig({ ...WA_ENV, ...over });

describe("configuración del bot (falla cerrado)", () => {
  it("configuración completa válida", () => {
    const c = cfg();
    expect(c).toMatchObject({ verifyToken: WA.verifyToken, appSecret: WA.appSecret, accessToken: WA.accessToken, phoneNumberId: WA.phoneNumberId, graphVersion: "v25.0", appUrl: null });
    expect(c!.allowed).toEqual([{ waId: WA.alex, name: "Alex" }, { waId: WA.sam, name: "Sam" }]);
    expect(whatsAppConfigIssues({ ...WA_ENV })).toEqual([]);
  });
  it("sin nada → null", () => {
    expect(getWhatsAppConfig({})).toBeNull();
    expect(whatsAppConfigIssues({})).toHaveLength(5);
  });
  it.each(Object.keys(WA_ENV))("falta %s → null", (k) => {
    expect(cfg({ [k]: undefined })).toBeNull();
    expect(cfg({ [k]: "" })).toBeNull();
    expect(cfg({ [k]: "   " })).toBeNull();
    expect(whatsAppConfigIssues({ ...WA_ENV, [k]: undefined })).toEqual([k]);
  });
  it.each([
    ["WHATSAPP_VERIFY_TOKEN", "x".repeat(15)],
    ["WHATSAPP_APP_SECRET", "x".repeat(15)],
    ["WHATSAPP_ACCESS_TOKEN", "x".repeat(19)],
    ["WHATSAPP_PHONE_NUMBER_ID", "12ab"],
    ["WHATSAPP_PHONE_NUMBER_ID", "1234"],
    ["WHATSAPP_PHONE_NUMBER_ID", "123 456 789"],
    ["WHATSAPP_GRAPH_VERSION", "23.0"],
    ["WHATSAPP_GRAPH_VERSION", "v23"],
    ["WHATSAPP_GRAPH_VERSION", "v23.0/../x"],
    ["WHATSAPP_GRAPH_VERSION", "latest"],
  ])("%s inválido (%s) → null", (k, v) => {
    expect(cfg({ [k]: v })).toBeNull();
  });
  it("longitudes mínimas exactas son válidas", () => {
    expect(cfg({ WHATSAPP_VERIFY_TOKEN: "x".repeat(16), WHATSAPP_APP_SECRET: "y".repeat(16), WHATSAPP_ACCESS_TOKEN: "z".repeat(20) })).not.toBeNull();
  });
  it("versión de Graph personalizada válida y recortada", () => {
    expect(cfg({ WHATSAPP_GRAPH_VERSION: " v24.1 " })!.graphVersion).toBe("v24.1");
    expect(cfg({ WHATSAPP_GRAPH_VERSION: "" })!.graphVersion).toBe("v25.0");
  });
  it("valores con espacios/saltos de línea de copiar y pegar se recortan", () => {
    expect(cfg({ WHATSAPP_VERIFY_TOKEN: `  ${WA.verifyToken}\n` })!.verifyToken).toBe(WA.verifyToken);
  });
  it("appUrl: APP_URL manda; si no, WEBSITE_HOSTNAME; valores raros se descartan", () => {
    expect(cfg({ WEBSITE_HOSTNAME: "mi-app.azurewebsites.net" })!.appUrl).toBe("https://mi-app.azurewebsites.net");
    expect(cfg({ APP_URL: "https://finanzas.example.com/ruta/", WEBSITE_HOSTNAME: "mi-app.azurewebsites.net" })!.appUrl).toBe("https://finanzas.example.com");
    expect(cfg({ APP_URL: "javascript:alert(1)", WEBSITE_HOSTNAME: "mi-app.azurewebsites.net" })!.appUrl).toBe("https://mi-app.azurewebsites.net");
    expect(cfg({ APP_URL: "https://u:p@x.example.com" })!.appUrl).toBeNull();
    expect(cfg({ WEBSITE_HOSTNAME: "a b/c" })!.appUrl).toBeNull();
  });
  it("las listas inválidas anulan toda la configuración", () => {
    for (const bad of ["", "5215511110001", "5215511110001=", "=Alex", "abc=Alex", "5215511110001=Uz1el"]) expect(cfg({ WHATSAPP_ALLOWED: bad })).toBeNull();
  });
  it("los errores y los avisos de configuración solo nombran variables, nunca valores", () => {
    const issues = whatsAppConfigIssues({ ...WA_ENV, WHATSAPP_VERIFY_TOKEN: "corto-secreto", WHATSAPP_ALLOWED: "5215511110001=Uz1el" });
    expect(issues).toEqual(["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_ALLOWED"]);
    expect(JSON.stringify(issues)).not.toContain("corto-secreto");
  });
  it("las variables de WhatsApp son opcionales y no rompen getEnv (ni siquiera con basura)", () => {
    const base = {
      ALLOWED_EMAIL: "yo@example.com", INGEST_TOKEN: "t".repeat(32), DB_SERVER: "localhost", DB_NAME: "x",
    };
    expect(() => getEnv({ ...base })).not.toThrow();
    expect(() => getEnv({ ...base, WHATSAPP_ALLOWED: "basura", WHATSAPP_APP_SECRET: "x", WHATSAPP_GRAPH_VERSION: "??" })).not.toThrow();
    expect(getEnv({ ...base, WHATSAPP_ALLOWED: "" }).WHATSAPP_ALLOWED).toBeUndefined();
  });
});

describe("lista blanca de remitentes", () => {
  it("parseAllowed: formatos válidos", () => {
    expect(parseAllowed("5215511110001=Alex")).toEqual([{ waId: "5215511110001", name: "Alex" }]);
    expect(parseAllowed(" +5215511110001 = María José ,  525522220002=Sam-Luz ")).toEqual([
      { waId: "5215511110001", name: "María José" },
      { waId: "525522220002", name: "Sam-Luz" },
    ]);
    expect(parseAllowed("5215511110001=O'Brien Jr.")).toHaveLength(1);
    expect(parseAllowed("5215511110001=Alex,")).toHaveLength(1); // coma final tolerada
  });
  it("parseAllowed: 5 personas sí, 6 no", () => {
    const n = (i: number) => `52155111100${String(i).padStart(2, "0")}=P${"abcdef"[i]}`;
    expect(parseAllowed([1, 2, 3, 4, 5].map(n).join(","))).toHaveLength(5);
    expect(parseAllowed([1, 2, 3, 4, 5, 6].map(n).join(","))).toBeNull();
  });
  it.each([
    ["vacío", ""],
    ["solo comas", ",,"],
    ["sin nombre", "5215511110001"],
    ["nombre vacío", "5215511110001=  "],
    ["número corto", "551111000=Alex"],
    ["10 dígitos sin lada de país", "5511110001=Alex"],
    ["lada con 0 inicial", "05215511110001=Alex"],
    ["número largo", "5215511110001999999=Alex"],
    ["letras en el número", "52155ab110001=Alex"],
    ["número con guiones", "52-1551-110001=Alex"],
    ["nombre con dígitos", "5215511110001=Alex2"],
    ["nombre con símbolos", "5215511110001=Alex;DROP"],
    ["nombre con inyección de salto", "5215511110001=Alex\nAna"],
    ["nombre de 31 caracteres", `5215511110001=${"a".repeat(31)}`],
    ["nombre solo puntuación", "5215511110001=..."],
    ["mismo número dos veces", "5215511110001=A,5215511110001=B"],
    ["mismo número con y sin 1", "5215511110001=A,525511110001=B"],
    ["mismo número con y sin 1 (orden inverso)", "525511110001=A,+52 1 55 1111 0001=B"],
    ["doble signo =", "5215511110001=A=B"],
  ])("parseAllowed rechaza: %s", (_n, raw) => {
    expect(parseAllowed(raw)).toBeNull();
  });
  it("mismos 10 dígitos pero otra lada de país son números DISTINTOS y ambos caben en la lista", () => {
    expect(parseAllowed("525511110001=Alex,15511110001=Sam")).toHaveLength(2);
    expect(parseAllowed("525511110001=Alex,5215511110001=Sam")).toBeNull(); // 521 y 52 de México sí son el mismo
  });
  it("límites de longitud: 11 dígitos sí, 15 sí, 16 no", () => {
    expect(parseAllowed("15511110001=Alex")).toHaveLength(1);
    expect(parseAllowed(`${"1".repeat(15)}=Alex`)).toHaveLength(1);
    expect(parseAllowed(`${"1".repeat(16)}=Alex`)).toBeNull();
  });
  it("nombre de 30 caracteres es válido", () => {
    expect(parseAllowed(`5215511110001=${"a".repeat(30)}`)).toHaveLength(1);
  });

  const allowed = parseAllowed("525511110001=Alex,+5215522220002=Sam")!;
  it("521… (lo que manda Meta) coincide con 52… configurado y viceversa (solo México), comparando el número completo", () => {
    expect(findSender(allowed, "5215511110001")).toEqual({ waId: "5215511110001", name: "Alex" });
    expect(findSender(allowed, "525511110001")).toEqual({ waId: "525511110001", name: "Alex" });
    expect(findSender(allowed, "525522220002")).toEqual({ waId: "525522220002", name: "Sam" });
    expect(findSender(allowed, "5215522220002")).toEqual({ waId: "5215522220002", name: "Sam" });
  });
  it("tolera espacios, + y separadores en el número entrante; el waId devuelto es solo dígitos", () => {
    expect(findSender(allowed, " +52 1 55 1111 0001 ")).toEqual({ waId: "5215511110001", name: "Alex" });
    expect(findSender(allowed, "+52-55-1111-0001")).toMatchObject({ name: "Alex" });
  });
  it("números desconocidos, cortos o vacíos → null", () => {
    expect(findSender(allowed, "5215599990009")).toBeNull();
    expect(findSender(allowed, "5511110001")).toBeNull(); // 10 dígitos sin lada: ya no coincide
    expect(findSender(allowed, "11110001")).toBeNull();
    expect(findSender(allowed, "")).toBeNull();
    expect(findSender(allowed, "abc")).toBeNull();
    expect(findSender([], WA.alex)).toBeNull();
  });
  it("NO hay suplantación por los mismos 10 dígitos con otra lada de país (+1 551 111 0001 ≠ +52 55 1111 0001)", () => {
    expect(findSender(allowed, "15511110001")).toBeNull();
    expect(findSender(allowed, "+1 551 111 0001")).toBeNull();
    expect(findSender(allowed, "445511110001")).toBeNull();
    // Y al revés: autorizado un número de EE. UU., un número de México con los mismos 10 dígitos no entra.
    const us = parseAllowed("15511110001=Alex")!;
    expect(findSender(us, "15511110001")).toMatchObject({ name: "Alex" });
    expect(findSender(us, "525511110001")).toBeNull();
    expect(findSender(us, "5215511110001")).toBeNull();
  });
  it("solo México se normaliza: 521 + 10 dígitos exactos; otros países con 1 después de la lada no", () => {
    expect(findSender(allowed, "52155111100010")).toBeNull(); // 11 dígitos tras 52: no es un móvil de México
    const ar = parseAllowed("5491155551234=Sam")!; // Argentina: 549… no se toca
    expect(findSender(ar, "5491155551234")).toMatchObject({ name: "Sam" });
    expect(findSender(ar, "541155551234")).toBeNull();
  });
  it("normalizeNumber", () => {
    expect(normalizeNumber("+52 1 55 1111 0001")).toBe("525511110001");
    expect(normalizeNumber("525511110001")).toBe("525511110001");
    expect(normalizeNumber("15511110001")).toBe("15511110001");
    expect(normalizeNumber("5215511110")).toBe("5215511110"); // incompleto: no se toca
  });
  it("maskNumber deja solo los últimos 4", () => {
    expect(maskNumber("5215511110001")).toBe("***0001");
    expect(maskNumber("+52 1 55 1111 0001")).toBe("***0001");
    expect(maskNumber("")).toBe("***");
    expect(maskNumber("5215511110001")).not.toContain("5511");
  });
});
