import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { beforeEach, describe, expect, it } from "vitest";
import { A } from "../fixtures/banamex-emails";

/**
 * Ejecuta el Code.gs REAL en un sandbox con dobles de GmailApp/UrlFetchApp/PropertiesService,
 * para probar hilos de varios mensajes, reintentos y cursor sin salir de Node.
 */
const SRC = readFileSync(path.join(process.cwd(), "integrations/gmail-apps-script/Code.gs"), "utf8");
const FROM = "notificaciones@banamex.com";
const SUBJECT = "Retiro/Compra con tarjeta Banamex";

type Msg = { id: string; from: string; subject: string; date: Date; plain: string; html?: string; thread: Thread };
type Thread = { labels: string[]; messages: Msg[]; addLabel(l: { name: string }): void };

function world() {
  const props: Record<string, string> = { UZ_URL: "https://app.example.net", UZ_TOKEN: "t".repeat(40) };
  const threads: Thread[] = [];
  const posts: { body: Record<string, string>; headers: Record<string, string> }[] = [];
  const logs: string[] = [];
  const responses: number[] = []; // cola de códigos; vacía → 200
  const labels = new Map<string, { name: string }>();
  const wrap = (m: Msg) => ({
    getId: () => m.id, getFrom: () => m.from, getSubject: () => m.subject, getDate: () => m.date,
    getPlainBody: () => m.plain, getBody: () => m.html ?? m.plain, getThread: () => m.thread,
  });
  const sandbox = {
    console: { log: (s: string) => logs.push(String(s)), warn: (s: string) => logs.push(String(s)) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => props[k] ?? null, setProperty: (k: string, v: string) => { props[k] = v; }, deleteProperty: (k: string) => { delete props[k]; } }) },
    GmailApp: {
      search: (_q: string, start: number, max: number) => threads.slice(start, start + max).map((t) => ({ t })),
      getMessagesForThreads: (ts: { t: Thread }[]) => ts.map((x) => x.t.messages.map(wrap)),
      getUserLabelByName: (n: string) => labels.get(n) ?? null,
      createLabel: (n: string) => { const l = { name: n }; labels.set(n, l); return l; },
    },
    UrlFetchApp: {
      fetch: (_url: string, opt: { payload: string; headers: Record<string, string> }) => {
        posts.push({ body: JSON.parse(opt.payload), headers: opt.headers });
        const code = responses.length ? responses.shift()! : 200;
        return { getResponseCode: () => code, getContentText: () => "{}" };
      },
    },
    Utilities: { sleep: () => {} },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger: () => {}, newTrigger: () => ({}) },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx);
  const call = (fn: string) => vm.runInContext(`${fn}()`, ctx);
  let n = 0;
  const thread = (): Thread => {
    const t: Thread = { labels: [], messages: [], addLabel(l) { this.labels.push(l.name); } };
    threads.push(t);
    return t;
  };
  const add = (t: Thread, over: Partial<Msg> = {}) => {
    const m: Msg = { id: `gm${String(++n).padStart(4, "0")}`, from: `Banamex <${FROM}>`, subject: SUBJECT, date: new Date(Date.now() - (50 - n) * 60_000), plain: A.body, thread: t, ...over };
    t.messages.push(m);
    return m;
  };
  return { props, threads, posts, logs, responses, call, thread, add };
}

let w: ReturnType<typeof world>;
beforeEach(() => { w = world(); });

describe("Apps Script: hilos con varios mensajes", () => {
  it("un hilo de 3 mensajes (2 compras + 1 de otro asunto) envía CADA compra con su propio messageId", () => {
    const t = w.thread();
    const m1 = w.add(t); const m2 = w.add(t); w.add(t, { subject: "Alta de cuenta" });
    w.call("processNew");
    expect(w.posts.map((p) => p.body.messageId)).toEqual([m1.id, m2.id]);
    expect(new Set(w.posts.map((p) => p.body.messageId)).size).toBe(2);
    expect(t.labels).toContain("uzfinance-enviado");
  });
  it("no reenvía lo ya enviado, y un mensaje NUEVO en un hilo ya etiquetado sí se envía", () => {
    const t = w.thread();
    w.add(t); w.add(t);
    w.call("processNew");
    expect(w.posts).toHaveLength(2);
    w.call("processNew");
    expect(w.posts).toHaveLength(2); // sin correos nuevos no hay llamadas (no despierta la base de datos)
    const m3 = w.add(t, { date: new Date() });
    w.call("processNew");
    expect(w.posts).toHaveLength(3);
    expect(w.posts[2].body.messageId).toBe(m3.id);
  });
  it("no depende de la etiqueta: aunque el hilo ya esté etiquetado, se envían los mensajes pendientes", () => {
    const t = w.thread();
    t.labels.push("uzfinance-enviado");
    const m = w.add(t);
    w.call("processNew");
    expect(w.posts.map((p) => p.body.messageId)).toEqual([m.id]);
  });
});

describe("Apps Script: filtros, errores y reintentos", () => {
  it("solo remitente exacto y asuntos soportados", () => {
    const t = w.thread();
    w.add(t, { from: "Fraude <notificaciones@banamex.com.evil.io>" });
    w.add(t, { from: "marketingdir@email.banamex.com" });
    w.add(t, { subject: "Promoción" });
    const ok = w.add(t, { from: "NOTIFICACIONES@banamex.com", subject: "  RETIRO/COMPRA con TARJETA adicional " });
    w.call("processNew");
    expect(w.posts.map((p) => p.body.messageId)).toEqual([ok.id]);
  });
  it("envía solo los campos acordados, con Bearer, sin el token en el payload", () => {
    w.add(w.thread());
    w.call("processNew");
    expect(Object.keys(w.posts[0].body).sort()).toEqual(["bodyText", "from", "messageId", "receivedAt", "subject"]);
    expect(w.posts[0].body.from).toBe(FROM);
    expect(w.posts[0].headers.Authorization).toBe(`Bearer ${"t".repeat(40)}`);
    expect(JSON.stringify(w.posts[0].body)).not.toContain("tttttttt");
  });
  it("error transitorio (503): el mensaje no se marca, se detiene y la siguiente corrida lo reintenta sin duplicar el anterior", () => {
    const t = w.thread();
    const m1 = w.add(t); const m2 = w.add(t);
    w.responses.push(200, 503, 503, 503); // m1 ok; m2 falla 3 veces (3 intentos)
    w.call("processNew");
    expect(w.posts.map((p) => p.body.messageId)).toEqual([m1.id, m2.id, m2.id, m2.id]);
    w.posts.length = 0;
    w.call("processNew");
    expect(w.posts.map((p) => p.body.messageId)).toEqual([m2.id]);
  });
  it("rechazo permanente (400): se etiqueta el hilo como rechazado, no se reintenta y se sigue con el siguiente", () => {
    const t = w.thread();
    w.add(t); const m2 = w.add(t);
    w.responses.push(400);
    w.call("processNew");
    expect(w.posts).toHaveLength(2);
    expect(w.posts[1].body.messageId).toBe(m2.id);
    expect(t.labels).toContain("uzfinance-rechazado");
    w.call("processNew");
    expect(w.posts).toHaveLength(2);
  });
  it("401 detiene el script con un error claro", () => {
    w.add(w.thread());
    w.responses.push(401);
    expect(() => w.call("processNew")).toThrow(/401/);
  });
  it("faltan propiedades → error claro", () => {
    delete w.props.UZ_TOKEN;
    w.add(w.thread());
    expect(() => w.call("processNew")).toThrow(/UZ_TOKEN/);
  });
});

describe("Apps Script: backfill por lotes e idempotente", () => {
  it("procesa 120 mensajes repartidos en 120 hilos (varias páginas) y una segunda corrida no reenvía", () => {
    for (let i = 0; i < 120; i++) w.add(w.thread(), { date: new Date(Date.now() - (200 - i) * 3600_000) });
    w.call("backfill");
    expect(w.posts).toHaveLength(120);
    w.call("backfill");
    expect(w.posts).toHaveLength(120);
  });
  it("si falla a la mitad, continúa donde se quedó", () => {
    for (let i = 0; i < 10; i++) w.add(w.thread(), { date: new Date(Date.now() - (100 - i) * 3600_000) });
    w.responses.push(200, 200, 200, 503, 503, 503);
    w.call("backfill");
    expect(w.posts).toHaveLength(6);
    w.posts.length = 0;
    w.call("backfill");
    expect(w.posts).toHaveLength(7); // el 4.º (fallido) y los 6 restantes
    expect(new Set(w.posts.map((p) => p.body.messageId)).size).toBe(7);
  });
});

describe("Apps Script: cuerpo desordenado → HTML", () => {
  const html = "<table><tr><td>Monto</td><td>$1,423.58</td></tr><tr><td>Establecimiento</td><td>FERRETERIA &amp; CIA</td></tr><tr><td>Fecha y hora</td><td>2026/10/1 12:44:22 PM</td></tr></table><style>x{}</style>";
  it("si el texto plano pierde las etiquetas se reconstruye desde getBody() con una celda por línea", () => {
    w.add(w.thread(), { plain: "MontoEstablecimiento$1,423.58FERRETERIA", html });
    w.call("processNew");
    expect(w.posts[0].body.bodyText).toBe("Monto\n$1,423.58\nEstablecimiento\nFERRETERIA & CIA\nFecha y hora\n2026/10/1 12:44:22 PM");
  });
  it("decodifica entidades con acentos (&oacute;, &ntilde;…) para que las etiquetas sigan reconocibles", () => {
    w.add(w.thread(), { plain: "sin etiquetas", html: "<td>Monto</td><td>$1.00</td><td>Fecha y hora</td><td>2026/10/1 1:00:00 AM</td><td>No. Autorizaci&oacute;n</td><td>Espa&ntilde;a &iexcl;Hola!</td>" });
    w.call("processNew");
    expect(w.posts[0].body.bodyText).toContain("No. Autorización");
    expect(w.posts[0].body.bodyText).toContain("España ¡Hola!");
  });
  it("si el texto plano está bien, se usa tal cual", () => {
    w.add(w.thread(), { html });
    w.call("processNew");
    expect(w.posts[0].body.bodyText).toBe(A.body);
  });
});

describe("Apps Script: testConnection imprime la estructura enmascarada", () => {
  it("muestra etiquetas legibles y NINGÚN valor real, y usa dry-run", () => {
    const secret = A.body.replace("FERRETERIA EJEMPLO SA", "TIENDA SECRETA 987654").replace("000000", "424242");
    w.add(w.thread(), { plain: secret });
    w.call("testConnection");
    const out = w.logs.join("\n");
    expect(out).toContain("Monto");
    expect(out).toContain("Fecha y hora");
    expect(out).toContain("9999/99/9 99:99:99 XX"); // forma de la fecha, sin el valor
    for (const leak of ["1,423.58", "SECRETA", "987654", "424242", "EJEMPLO", "EXPLORA", "JUAN"]) expect(out).not.toContain(leak);
    expect(w.posts[0].headers["X-Dry-Run"]).toBe("1");
    expect(out).toMatch(/Se enviará: texto plano/);
  });
});
