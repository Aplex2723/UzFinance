import { describe, expect, it } from "vitest";
import { clampBody, chatText, clampTitle, safeText, shortHash, statementDiffCandidate, transferRegisteredCandidate, truncate, whatsappText } from "@/lib/alerts/text";

describe("texto seguro", () => {
  it("safeText: quita control y bidi, colapsa espacios, trunca", () => {
    expect(safeText("a\u0000b\n\tc‮d  e", 50)).toBe("a b c d e");
    expect(safeText(null, 5)).toBe("");
    expect(safeText("x".repeat(100), 10)).toHaveLength(10);
    expect(safeText("x".repeat(100), 10).endsWith("…")).toBe(true);
  });
  it("truncate no parte emojis a la mitad", () => {
    const s = "😀".repeat(10);
    const t = truncate(s, 5);
    expect(t.length).toBeLessThanOrEqual(5);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
  it("clampTitle ≤ 120 y clampBody ≤ 500 caracteres Unicode", () => {
    expect(clampTitle("t".repeat(500)).length).toBeLessThanOrEqual(120);
    expect(clampBody("b".repeat(2000)).length).toBeLessThanOrEqual(500);
    expect(clampBody("😀".repeat(2000)).length).toBeLessThanOrEqual(500); // NVARCHAR cuenta unidades UTF-16
  });
  it("clampBody conserva saltos de línea pero no controles", () => {
    expect(clampBody("uno\r\ndos\u0000\n\n\n\ntres")).toBe("uno\ndos\n\ntres");
  });
  it("shortHash es determinístico", () => {
    expect(shortHash("a")).toBe(shortHash("a"));
    expect(shortHash("a")).not.toBe(shortHash("b"));
    expect(shortHash("a")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("whatsappText", () => {
  it("corto, con negritas de WhatsApp y marca de severidad", () => {
    const t = whatsappText({ title: "Compra fuerte: $6,000.00", body: "Detalle", severity: "high" });
    expect(t).toContain("*Compra fuerte: $6,000.00*");
    expect(t).toContain("Detalle");
    expect(t.length).toBeLessThanOrEqual(300);
  });
  it("no deja que el texto de terceros rompa el formato ni se alargue", () => {
    const t = whatsappText({ title: "*x*\n*y*", body: "b*".repeat(500), severity: "warn" });
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t.match(/\*/g)).toHaveLength(2);
  });
  it("distintas severidades, distinto marcador", () => {
    const m = (s: "info" | "warn" | "high") => whatsappText({ title: "t", body: "b", severity: s }).split(" ")[0];
    expect(new Set([m("info"), m("warn"), m("high")]).size).toBe(3);
  });
});

describe("statement_diff y transfer_registered (formatos para el integrador)", () => {
  it("statement_diff: diferencia, severidad por magnitud y clave estable", () => {
    const base = { documentId: 7, label: "Amex Platinum · sep 2026", statementCents: 10_000_00 };
    const a = statementDiffCandidate({ ...base, appCents: 9_950_00 });
    expect(a).toMatchObject({ rule: "statement_diff", severity: "info", documentId: 7 });
    expect(a.title).toContain("$50.00");
    expect(statementDiffCandidate({ ...base, appCents: 9_000_00 }).severity).toBe("warn");
    const big = statementDiffCandidate({ ...base, appCents: 5_000_00, missingInApp: 3, notInStatement: 1 });
    expect(big.severity).toBe("high");
    expect(big.body).toContain("3 movimiento(s) del estado no están en la app");
    expect(big.dedupeKey).toBe(statementDiffCandidate({ ...base, appCents: 1 }).dedupeKey);
    expect(statementDiffCandidate({ ...base, label: "Otra", appCents: 1 }).dedupeKey).not.toBe(big.dedupeKey);
    expect(big.dedupeKey.length).toBeLessThanOrEqual(120);
  });
  it("statement_diff: cuadra (diferencia 0) y sobran en la app", () => {
    expect(statementDiffCandidate({ documentId: 1, label: "X", statementCents: 5_00, appCents: 5_00 }).body).toContain("cuadra");
    expect(statementDiffCandidate({ documentId: 1, label: "X", statementCents: 1_000_00, appCents: 1_500_00 }).body).toContain("sobran");
  });
  it("transfer_registered: info por defecto, clave por movimiento, texto hostil contenido", () => {
    const c = transferRegisteredCandidate({ txId: 5, amountCents: 1_200_00, counterparty: `Juan\n${"P".repeat(200)}`, date: "2026-10-03", trackingKey: "ABC123" });
    expect(c).toMatchObject({ rule: "transfer_registered", severity: "info", dedupeKey: "transfer:5", txId: 5 });
    expect(c.title).toContain("$1,200.00");
    expect(c.title).not.toContain("\n");
    expect(c.body).toContain("ABC123");
    expect(transferRegisteredCandidate({ txId: 5, amountCents: 1, severity: "warn" }).severity).toBe("warn");
  });
});

describe("chatText (aviso de Telegram en texto plano)", () => {
  const a = { title: "Compra fuerte: $6,000.00", body: "Detalle de la compra.\nSegunda línea.", severity: "high" as const };
  it("título, cuerpo y marca de severidad, sin negritas ni marcado", () => {
    const t = chatText(a);
    expect(t).toBe("🚨 Compra fuerte: $6,000.00\nDetalle de la compra.\nSegunda línea.");
    expect(t).not.toMatch(/[*_`]/);
    expect(chatText({ ...a, severity: "warn" }).startsWith("⚠️ ")).toBe(true);
    expect(chatText({ ...a, severity: "info" }).startsWith("ℹ️ ")).toBe(true);
  });
  it("lo que viene de terceros no se interpreta: queda tal cual (sin parse_mode no es marcado)", () => {
    expect(chatText({ title: "AMZN *MKT", body: "x", severity: "warn" })).toContain("AMZN *MKT");
  });
  it("sin cuerpo no deja una línea vacía; con enlace lo agrega al final", () => {
    expect(chatText({ title: "t", body: "", severity: "info" })).toBe("ℹ️ t");
    expect(chatText(a, "https://app.example.com/")).toMatch(/\n\nVer en la app: https:\/\/app\.example\.com\/alertas$/);
  });
  it("nunca pasa de 4096 unidades ni parte un emoji (título/cuerpo desmedidos)", () => {
    const t = chatText({ title: "t".repeat(9000), body: "😀".repeat(9000), severity: "high" }, "https://x.example");
    expect(t.length).toBeLessThanOrEqual(4096);
    expect(t.endsWith("\uD83D")).toBe(false);
  });
  it("sin caracteres de control ni de dirección", () => {
    const t = chatText({ title: "a\u202eb\u0007c", body: "x\u0000y", severity: "info" });
    expect(t).not.toMatch(/[\u0000-\u0008\u202e]/);
  });
});
