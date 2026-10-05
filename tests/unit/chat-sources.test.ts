import { describe, expect, it } from "vitest";
import { CHAT_SOURCES, chatSourceTag, channelOf, DATED_CHAT_SOURCES, DOC_ORIGIN, isChatSource, isUndoableSources, MERGEABLE_CHAT_SOURCES, originLabel, SOURCE_LABELS, SOURCE_UI_LABELS, sourcesLabel, SQL } from "@/lib/chat-sources";

describe("fuentes de chat (módulo central)", () => {
  it("etiquetas por canal, con y sin fecha explícita", () => {
    expect(chatSourceTag("whatsapp", false)).toBe("whatsapp");
    expect(chatSourceTag("telegram", false)).toBe("telegram");
    expect(chatSourceTag("whatsapp", true)).toBe("whatsapp-d");
    expect(chatSourceTag("telegram", true)).toBe("telegram-d");
    expect(MERGEABLE_CHAT_SOURCES).toEqual(["whatsapp", "telegram"]);
    expect(DATED_CHAT_SOURCES).toEqual(["whatsapp-d", "telegram-d"]);
    expect(CHAT_SOURCES).toEqual(["whatsapp", "telegram", "whatsapp-d", "telegram-d"]);
    // caben en sources VARCHAR(40) aun con Atajo y correo
    expect("telegram-d,shortcut,email".length).toBeLessThanOrEqual(40);
  });

  it("canal por omisión WhatsApp", () => {
    expect(channelOf(undefined)).toBe("whatsapp");
    expect(channelOf("telegram")).toBe("telegram");
    expect(channelOf("otro")).toBe("whatsapp");
  });

  it("deshacer: solo una etiqueta de chat pura o comprobante; nada que alguien más ya tocó", () => {
    for (const ok of ["whatsapp", "telegram", "whatsapp-d", "telegram-d", "receipt"]) expect(isUndoableSources(ok), ok).toBe(true);
    for (const no of ["whatsapp,email", "telegram,shortcut", "shortcut", "email", "manual", "", "whatsapp-d,email", "receipt,email"]) expect(isUndoableSources(no), no).toBe(false);
    expect(isChatSource("telegram-d")).toBe(true);
    expect(isChatSource("shortcut")).toBe(false);
  });

  it("fragmentos SQL: fusionables sin las de fecha; sin confirmar con todas las de chat", () => {
    expect(SQL.mergeableChat).toBe("'whatsapp', 'telegram'");
    expect(SQL.emailMergeable).toBe("'shortcut', 'whatsapp', 'telegram', 'whatsapp,shortcut', 'telegram,shortcut'");
    expect(SQL.emailMergeable).not.toContain("-d");
    expect(SQL.undoable).toBe("'whatsapp', 'telegram', 'whatsapp-d', 'telegram-d', 'receipt'");
    const u = SQL.unconfirmed("x");
    for (const t of ["'shortcut'", "'whatsapp'", "'telegram'", "'whatsapp-d'", "'telegram-d'", "'whatsapp,shortcut'", "'telegram,shortcut'"]) expect(u).toContain(t);
    expect(u).toContain("x.email_message_id IS NULL");
    expect(SQL.unconfirmed("t")).toContain("t.sources IN");
  });

  it("etiquetas legibles y origen de documentos", () => {
    expect(SOURCE_LABELS).toMatchObject({ whatsapp: "WhatsApp", telegram: "Telegram", "telegram-d": "Telegram", shortcut: "Atajo", email: "correo" });
    // desde la migración 010, documents.origin admite 'telegram'
    expect(DOC_ORIGIN).toEqual({ whatsapp: "whatsapp", telegram: "telegram" });
  });
});

describe("etiquetas de fuente en la interfaz", () => {
  it("las fuentes de chat se ven en español; la de fecha explícita lo dice", () => {
    expect(sourcesLabel("whatsapp")).toBe("WhatsApp");
    expect(sourcesLabel("telegram")).toBe("Telegram");
    expect(sourcesLabel("whatsapp-d")).toBe("WhatsApp (fecha indicada)");
    expect(sourcesLabel("telegram-d")).toBe("Telegram (fecha indicada)");
  });

  it("combinaciones: orden de llegada, separador y sin repetir", () => {
    expect(sourcesLabel("whatsapp,email")).toBe("WhatsApp + Correo");
    expect(sourcesLabel("telegram,shortcut,email")).toBe("Telegram + Atajo + Correo");
    expect(sourcesLabel("telegram-d,email")).toBe("Telegram (fecha indicada) + Correo");
    expect(sourcesLabel("shortcut,shortcut, email ")).toBe("Atajo + Correo");
    expect(sourcesLabel("telegram,shortcut", " · ")).toBe("Telegram · Atajo");
    expect(sourcesLabel("receipt")).toBe("Comprobante PDF");
    expect(sourcesLabel("statement,manual")).toBe("Estado de cuenta + Manual");
  });

  it("vacío y fuentes desconocidas: nada se pierde ni se rompe", () => {
    expect(sourcesLabel("")).toBe("");
    expect(sourcesLabel(null)).toBe("");
    expect(sourcesLabel(undefined)).toBe("");
    expect(sourcesLabel(",,")).toBe("");
    expect(sourcesLabel("signal,email")).toBe("signal + Correo");
  });

  it("toda etiqueta de chat tiene texto de interfaz, y SOURCE_LABELS (respuestas del bot) no cambia", () => {
    for (const s of CHAT_SOURCES) expect(SOURCE_UI_LABELS[s], s).toBeTruthy();
    expect(SOURCE_LABELS["telegram-d"]).toBe("Telegram");
    expect(SOURCE_LABELS["whatsapp-d"]).toBe("WhatsApp");
  });

  it("origen de documentos", () => {
    expect(originLabel("whatsapp")).toBe("WhatsApp");
    expect(originLabel("telegram")).toBe("Telegram");
    expect(originLabel("app")).toBeNull();
    expect(originLabel(undefined)).toBeNull();
    for (const c of ["whatsapp", "telegram"] as const) expect(originLabel(DOC_ORIGIN[c])).not.toBeNull();
  });
});
