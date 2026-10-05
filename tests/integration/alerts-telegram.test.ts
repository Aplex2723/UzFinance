import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushAlertWork } from "@/lib/alerts/background";
import { localMinutes } from "@/lib/alerts/quiet";
import { chatIdOf, flushTelegramOutbox, safeError } from "@/lib/alerts/telegram-sender";
import { closePool, query, t } from "@/lib/db/pool";
import { createAlert, dismissAlert, markAlertRead, maybeRunPeriodicAlerts, setAlertConfig, type AlertCandidate } from "@/lib/repo/alerts";
import { resetDb } from "../helpers";

// El envío en segundo plano que dispara createAlert se apaga (salvo en el bloque que lo prueba): así cada prueba decide cuándo y con qué IO corre.
const bg = vi.hoisted(() => ({ off: true }));
vi.mock("@/lib/alerts/background", async (orig) => {
  const m = await orig<typeof import("@/lib/alerts/background")>();
  return { ...m, scheduleAlertWork: (fn: () => Promise<unknown>) => (bg.off ? undefined : m.scheduleAlertWork(fn)) };
});

// IO y red falsos: ninguna prueba toca Telegram. Todo con datos inventados.
const BOT_TOKEN = "123456789:AAFakeTokenFakeTokenFakeTokenFake_123";
const SECRET = "s".repeat(40);
const ANA = { waId: "tg111", name: "Ana" };
const LUIS = { waId: "tg222", name: "Luis" };
const CFG = { allowed: [ANA, LUIS], botToken: BOT_TOKEN, appUrl: null };

type Call = { to: string; body: string };
function fakeIO(opts: { failFor?: string[]; delayMs?: number; throwMsg?: string } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    async sendText(to: string, body: string) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      calls.push({ to, body });
      if (opts.failFor?.includes(to)) throw new Error(opts.throwMsg ?? "falló el envío");
    },
    async downloadMedia(): Promise<never> {
      throw new Error("no se usa");
    },
  };
}

let seq = 0;
const candidate = (o: Partial<AlertCandidate> = {}): AlertCandidate => ({ rule: "large_purchase", severity: "warn", title: "Compra fuerte", body: "Detalle de prueba", dedupeKey: `k:${++seq}`, ...o });
type Row = { id: number; alert_id: number; channel: string; status: string; attempts: number; last_error: string | null; sent_to: string | null; sent_at: Date | null };
const outbox = (channel = "telegram") => query<Row>("SELECT id, alert_id, channel, status, attempts, last_error, sent_to, sent_at FROM dbo.alert_outbox WHERE channel=@c ORDER BY id", { c: t.varchar(channel) });
const min = (m: number, base: Date) => new Date(base.getTime() + m * 60_000);
/** HH:MM de Ciudad de México de un instante. */
const hhmm = (d: Date) => `${String(Math.floor(localMinutes(d) / 60)).padStart(2, "0")}:${String(localMinutes(d) % 60).padStart(2, "0")}`;

const logs: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
const ENV_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED", "TELEGRAM_BOT_USERNAME", "APP_URL", "WEBSITE_HOSTNAME"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  bg.off = true;
  await resetDb();
  logs.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  await setAlertConfig({ telegram: { enabled: true, minSeverity: "warn" } });
});
afterEach(async () => {
  await flushAlertWork();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
afterAll(closePool);

const useEnv = () => {
  process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_ALLOWED = "111=Ana,222=Luis";
};
const tokenLeaked = async () => {
  const rows = await query("SELECT last_error, sent_to FROM dbo.alert_outbox");
  expect(JSON.stringify(rows)).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(rows)).not.toMatch(/\d{6,12}:[A-Za-z0-9_-]{20,}/);
  expect(logs.join("\n")).not.toContain(BOT_TOKEN);
  expect(logs.join("\n")).not.toContain("api.telegram.org");
};

describe("encolado por canal", () => {
  it("apagado por omisión: sin Telegram en la configuración no se encola nada", async () => {
    await setAlertConfig({ telegram: { enabled: false } });
    await createAlert(candidate({ severity: "high" }));
    expect(await outbox()).toEqual([]);
  });
  it("encendido: solo severidad ≥ minSeverity, y una sola fila por alerta (UNIQUE alert_id + channel)", async () => {
    await createAlert(candidate({ severity: "info" }));
    const c = candidate({ severity: "warn" });
    const w = await createAlert(c);
    await createAlert(c); // misma dedupe_key: no es otra alerta
    const h = await createAlert(candidate({ severity: "high" }));
    const rows = await outbox();
    expect(rows.map((r) => Number(r.alert_id)).sort()).toEqual([w.id, h.id].sort());
    expect(rows.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
    await expect(query("INSERT dbo.alert_outbox (alert_id, channel) VALUES (@id, 'telegram')", { id: t.big(w.id!) })).rejects.toThrow();
  });
  it("minSeverity high filtra warn", async () => {
    await setAlertConfig({ telegram: { minSeverity: "high" } });
    await createAlert(candidate({ severity: "warn" }));
    expect(await outbox()).toEqual([]);
    await createAlert(candidate({ severity: "high" }));
    expect(await outbox()).toHaveLength(1);
  });
  it("WhatsApp y Telegram son canales independientes (cada uno con su fila)", async () => {
    await setAlertConfig({ whatsapp: { enabled: true, minSeverity: "high" }, telegram: { enabled: true, minSeverity: "warn" } });
    await createAlert(candidate({ severity: "warn" }));
    await createAlert(candidate({ severity: "high" }));
    expect((await outbox("telegram")).length).toBe(2);
    expect((await outbox("whatsapp")).length).toBe(1);
  });
  it("las restricciones de la migración 010: canal 'telegram' sí, otros no", async () => {
    const id = Number((await createAlert(candidate())).id);
    await expect(query(`INSERT dbo.alert_outbox (alert_id, channel) VALUES (${id}, 'sms')`)).rejects.toThrow();
    await query(`INSERT dbo.alert_outbox (alert_id, channel) VALUES (${id}, 'whatsapp')`); // el canal anterior sigue válido
  });
});

describe("flushTelegramOutbox", () => {
  it("manda a CADA persona autorizada (id numérico sin 'tg'), marca sent y no repite en la siguiente corrida", async () => {
    const io = fakeIO();
    await createAlert(candidate({ severity: "high", title: "Compra de $6,000.00", body: "En LIVERPOOL" }));
    const base = new Date();
    expect(await flushTelegramOutbox({ io, config: CFG, now: base })).toEqual({ sent: 1, failed: 0, skipped: 0, held: 0 });
    expect(io.calls.map((c) => c.to)).toEqual(["111", "222"]);
    expect(io.calls[0].body).toBe("🚨 Compra de $6,000.00\nEn LIVERPOOL");
    const [r] = await outbox();
    expect(r).toMatchObject({ status: "sent", attempts: 1, last_error: null, sent_to: "111,222" });
    expect(r.sent_at).toBeInstanceOf(Date);
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(10, base) })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
    expect(io.calls).toHaveLength(2);
  });

  it("texto plano: sin negritas ni marcado, con enlace a la app si se conoce", async () => {
    const io = fakeIO();
    await createAlert(candidate({ severity: "warn", title: "Comercio *nuevo*", body: "Monto: $3,000.00" }));
    await flushTelegramOutbox({ io, config: { ...CFG, appUrl: "https://uzfinance.example.com" } });
    const body = io.calls[0].body;
    expect(body.startsWith("⚠️ Comercio *nuevo*")).toBe(true); // el texto de terceros queda tal cual (sin parse_mode no es marcado)
    expect(body).not.toMatch(/^\*|\*⚠/);
    expect(body.endsWith("Ver en la app: https://uzfinance.example.com/alertas")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(4096);
  });

  it("Telegram no configurado (config nula o entorno inválido) → NO descarta: lo pendiente espera y sale al corregirlo", async () => {
    const io = fakeIO();
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ io, config: null, now: base })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
    expect(io.calls).toEqual([]);
    expect(await outbox()).toMatchObject([{ status: "pending", attempts: 0, last_error: null }]);
    // el entorno vacío tampoco lo descarta
    expect(await flushTelegramOutbox({ io, now: min(1, base) })).toMatchObject({ sent: 0, skipped: 0 });
    // un TELEGRAM_ALLOWED mal escrito (configuración inválida) tampoco; el log nombra la variable y nunca su valor
    useEnv();
    process.env.TELEGRAM_ALLOWED = "esto-no-es-un-id=Ana";
    expect(await flushTelegramOutbox({ io, now: min(2, base) })).toMatchObject({ sent: 0, skipped: 0 });
    expect((await outbox())[0].status).toBe("pending");
    expect(logs.join("\n")).not.toContain("esto-no-es-un-id");
    // se corrige: sale
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(3, base) })).toMatchObject({ sent: 1 });
    expect((await outbox())[0]).toMatchObject({ status: "sent" });
  });

  it("sin destinatarios (modo descubrimiento) → tampoco descarta: queda pending", async () => {
    const io = fakeIO();
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ io, config: { ...CFG, allowed: [] } })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
    expect(io.calls).toEqual([]);
    expect(await outbox()).toMatchObject([{ status: "pending", attempts: 0 }]);
  });

  it("mal configurado, lo pendiente caduca solo a las 24 h (skipped por antigüedad)", async () => {
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ io: fakeIO(), config: null, now: min(23 * 60, base) })).toMatchObject({ skipped: 0 });
    expect(await flushTelegramOutbox({ io: fakeIO(), config: null, now: min(25 * 60, base) })).toMatchObject({ skipped: 1 });
    expect(await outbox()).toMatchObject([{ status: "skipped", last_error: "caducó (más de 24 h)" }]);
  });

  it("si el usuario apaga el canal en la configuración de alertas antes del envío, lo pendiente se descarta (skipped)", async () => {
    const io = fakeIO();
    await createAlert(candidate({ severity: "high" }));
    await setAlertConfig({ telegram: { enabled: false } });
    expect(await flushTelegramOutbox({ io, config: CFG })).toMatchObject({ skipped: 1 });
    expect(io.calls).toEqual([]);
    expect(await outbox()).toMatchObject([{ status: "skipped", last_error: "avisos por Telegram apagados" }]);
    // y apagado manda sobre una configuración inválida: también se descarta
    await setAlertConfig({ telegram: { enabled: true } });
    await createAlert(candidate({ severity: "high" }));
    await setAlertConfig({ telegram: { enabled: false } });
    expect(await flushTelegramOutbox({ io, config: null })).toMatchObject({ skipped: 1 });
  });

  it("horas de silencio: la grave sale, la de atención espera (pending, sin gastar intentos) y sale al terminar", async () => {
    const io = fakeIO();
    const base = new Date();
    await setAlertConfig({ quietHours: { enabled: true, start: hhmm(min(-60, base)), end: hhmm(min(60, base)) } });
    await createAlert(candidate({ severity: "warn", title: "Espera", body: "" }));
    await createAlert(candidate({ severity: "high", title: "Urgente", body: "" }));
    expect(await flushTelegramOutbox({ io, config: CFG, now: base })).toEqual({ sent: 1, failed: 0, skipped: 0, held: 1 });
    expect(io.calls.map((c) => c.body)).toEqual(["🚨 Urgente", "🚨 Urgente"]);
    const rows = await outbox();
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([["pending", 0], ["sent", 1]]);
    // sigue en silencio: nada nuevo
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(30, base) })).toMatchObject({ sent: 0, held: 1 });
    // terminó el silencio: sale la retenida
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(120, base) })).toMatchObject({ sent: 1, held: 0 });
    expect(io.calls.map((c) => c.body).slice(2)).toEqual(["⚠️ Espera", "⚠️ Espera"]);
  });

  it("reintentos: espera creciente (5 y 30 min), solo a quien falló, tope de 3 intentos", async () => {
    const io = fakeIO({ failFor: ["222"], throwMsg: "red caída" });
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ io, config: CFG, now: base })).toMatchObject({ sent: 0, failed: 1 });
    let [r] = await outbox();
    expect(r).toMatchObject({ status: "failed", attempts: 1, sent_to: "111" });
    expect(r.last_error).toContain("red caída");
    expect(io.calls.map((c) => c.to)).toEqual(["111", "222"]);

    // antes de 5 min no se reintenta
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(4, base) })).toMatchObject({ sent: 0, failed: 0 });
    expect(io.calls).toHaveLength(2);
    // intento 2: solo a Luis (Ana ya lo recibió)
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(6, base) })).toMatchObject({ failed: 1 });
    expect(io.calls.map((c) => c.to)).toEqual(["111", "222", "222"]);
    [r] = await outbox();
    expect(r).toMatchObject({ status: "failed", attempts: 2, sent_to: "111" });
    // la siguiente espera 30 min
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(20, base) })).toMatchObject({ failed: 0 });
    expect(io.calls).toHaveLength(3);
    // intento 3 (último)
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(40, base) })).toMatchObject({ failed: 1 });
    expect(io.calls).toHaveLength(4);
    [r] = await outbox();
    expect(r).toMatchObject({ status: "failed", attempts: 3 });
    // tope: ya no se intenta más
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(600, base) })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
    expect(io.calls).toHaveLength(4);
  });

  it("un reintento que sí llega cierra como sent y limpia el error", async () => {
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    await flushTelegramOutbox({ io: fakeIO({ failFor: ["111", "222"] }), config: CFG, now: base });
    expect((await outbox())[0]).toMatchObject({ status: "failed", sent_to: null });
    const ok = fakeIO();
    expect(await flushTelegramOutbox({ io: ok, config: CFG, now: min(6, base) })).toMatchObject({ sent: 1 });
    expect(ok.calls.map((c) => c.to)).toEqual(["111", "222"]);
    expect((await outbox())[0]).toMatchObject({ status: "sent", attempts: 2, last_error: null, sent_to: "111,222" });
  });

  it("antigüedad: una alerta de más de 24 h no se envía (skipped)", async () => {
    const io = fakeIO();
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(25 * 60, base) })).toMatchObject({ sent: 0, skipped: 1 });
    expect(io.calls).toEqual([]);
    expect(await outbox()).toMatchObject([{ status: "skipped", last_error: "caducó (más de 24 h)" }]);
  });

  it("alerta descartada o leída antes de enviar: no se envía", async () => {
    const io = fakeIO();
    const a = (await createAlert(candidate({ severity: "high", title: "Descartada", body: "" }))).id!;
    const b = (await createAlert(candidate({ severity: "high", title: "Leída", body: "" }))).id!;
    const c = (await createAlert(candidate({ severity: "high", title: "Vigente", body: "" }))).id!;
    await dismissAlert(a);
    await markAlertRead(b);
    expect(await flushTelegramOutbox({ io, config: CFG })).toMatchObject({ sent: 1, skipped: 2 });
    expect([...new Set(io.calls.map((x) => x.body))]).toEqual(["🚨 Vigente"]);
    const rows = await outbox();
    expect(rows.find((r) => Number(r.alert_id) === a)?.status).toBe("skipped");
    expect(rows.find((r) => Number(r.alert_id) === b)?.status).toBe("skipped");
    expect(rows.find((r) => Number(r.alert_id) === c)?.status).toBe("sent");
  });

  it("concurrencia: dos corridas simultáneas mandan UN aviso por persona", async () => {
    const io = fakeIO({ delayMs: 40 });
    await createAlert(candidate({ severity: "high" }));
    await createAlert(candidate({ severity: "high" }));
    const [x, y] = await Promise.all([flushTelegramOutbox({ io, config: CFG }), flushTelegramOutbox({ io, config: CFG })]);
    expect(x.sent + y.sent).toBe(2);
    expect(io.calls).toHaveLength(4); // 2 alertas × 2 personas, nunca el doble
    expect((await outbox()).map((r) => [r.status, r.attempts])).toEqual([["sent", 1], ["sent", 1]]);
    const six = await Promise.all(Array.from({ length: 6 }, () => flushTelegramOutbox({ io, config: CFG })));
    expect(six.reduce((n, r) => n + r.sent, 0)).toBe(0);
    expect(io.calls).toHaveLength(4);
  });

  it("una corrida manda a lo más `limit` avisos; el resto sale en la siguiente (más antiguos primero)", async () => {
    const io = fakeIO();
    for (let i = 1; i <= 5; i++) await createAlert(candidate({ severity: "high", title: `n${i}`, body: "" }));
    expect(await flushTelegramOutbox({ io, config: { ...CFG, allowed: [ANA] }, limit: 2 })).toMatchObject({ sent: 2 });
    expect(io.calls.map((c) => c.body)).toEqual(["🚨 n1", "🚨 n2"]);
    expect(await flushTelegramOutbox({ io, config: { ...CFG, allowed: [ANA] } })).toMatchObject({ sent: 3 });
    expect(io.calls).toHaveLength(5);
  });

  it("una reserva vieja (el proceso murió a medias) se recupera tras 5 min, no antes", async () => {
    const io = fakeIO();
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    await query("UPDATE dbo.alert_outbox SET claimed_at=@t, attempts=1", { t: t.dt(base) });
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(2, base) })).toMatchObject({ sent: 0 });
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(6, base) })).toMatchObject({ sent: 1 });
    expect((await outbox())[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("sin nada abierto no consulta la configuración ni falla (salida temprana)", async () => {
    expect(await flushTelegramOutbox({ io: fakeIO(), config: CFG })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
  });

  it("ruta caliente: sin filas abiertas es UNA consulta; en silencio con avisos retenidos, dos (no ~6 por render)", async () => {
    const pool = await import("@/lib/db/pool");
    const spy = vi.spyOn(pool, "query");
    try {
      spy.mockClear();
      await flushTelegramOutbox({ io: fakeIO(), config: CFG });
      expect(spy).toHaveBeenCalledTimes(1);

      const base = new Date();
      await setAlertConfig({ quietHours: { enabled: true, start: hhmm(min(-60, base)), end: hhmm(min(60, base)) } });
      await createAlert(candidate({ severity: "warn", title: "Espera", body: "" }));
      await createAlert(candidate({ severity: "warn", title: "Espera 2", body: "" }));
      spy.mockClear();
      const io = fakeIO();
      expect(await flushTelegramOutbox({ io, config: CFG, now: base })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 2 });
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
      expect(io.calls).toEqual([]);
      // una corrida vigente de otro proceso (reserva reciente): abierta pero no vencida → una sola consulta
      await query("UPDATE dbo.alert_outbox SET claimed_at=@t, attempts=1", { t: t.dt(base) });
      await setAlertConfig({ quietHours: { enabled: false } });
      spy.mockClear();
      expect(await flushTelegramOutbox({ io, config: CFG, now: min(1, base) })).toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("silencio con avisos retenidos y una grave: la grave sale y las retenidas siguen pendientes", async () => {
    const io = fakeIO();
    const base = new Date();
    await setAlertConfig({ quietHours: { enabled: true, start: hhmm(min(-60, base)), end: hhmm(min(60, base)) } });
    await createAlert(candidate({ severity: "warn", title: "Espera", body: "" }));
    await createAlert(candidate({ severity: "high", title: "Urgente", body: "" }));
    expect(await flushTelegramOutbox({ io, config: CFG, now: base })).toMatchObject({ sent: 1, held: 1 });
    expect((await outbox()).map((r) => r.status)).toEqual(["pending", "sent"]);
  });

  it("sent_to se guarda después de CADA persona: si el proceso muere tras enviar a la primera, el reintento no la repite", async () => {
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    // el envío a la segunda persona "mata" el proceso (la promesa nunca vuelve): se observa la fila en ese instante
    let seen: string | null | undefined;
    const dying = {
      calls: [] as string[],
      async sendText(to: string) {
        dying.calls.push(to);
        if (to === "222") {
          seen = (await outbox())[0].sent_to;
          throw new Error("proceso muerto");
        }
      },
      async downloadMedia(): Promise<never> {
        throw new Error("no se usa");
      },
    };
    await flushTelegramOutbox({ io: dying, config: CFG, now: base });
    expect(seen).toBe("111"); // ya estaba guardado ANTES de intentar con la segunda persona
    const [r] = await outbox();
    expect(r).toMatchObject({ status: "failed", sent_to: "111" });
    // reintento (la reserva venció o el fallo ya esperó): solo a la que faltó
    const ok = fakeIO();
    await flushTelegramOutbox({ io: ok, config: CFG, now: min(6, base) });
    expect(ok.calls.map((c) => c.to)).toEqual(["222"]);
  });

  it("proceso muerto a media entrega (fila pending reservada con sent_to parcial): al vencer la reserva solo se le manda a quien falta", async () => {
    const io = fakeIO();
    const base = new Date();
    await createAlert(candidate({ severity: "high" }));
    await query("UPDATE dbo.alert_outbox SET claimed_at=@t, attempts=1, sent_to='111'", { t: t.dt(base) });
    expect(await flushTelegramOutbox({ io, config: CFG, now: min(6, base) })).toMatchObject({ sent: 1 });
    expect(io.calls.map((c) => c.to)).toEqual(["222"]);
    expect((await outbox())[0]).toMatchObject({ status: "sent", sent_to: "111,222" });
  });

  it("NUNCA lanza, aunque la base falle", async () => {
    await createAlert(candidate({ severity: "high" }));
    const spy = vi.spyOn(await import("@/lib/db/pool"), "query").mockRejectedValue(new Error("base caída"));
    await expect(flushTelegramOutbox({ io: fakeIO(), config: CFG })).resolves.toEqual({ sent: 0, failed: 0, skipped: 0, held: 0 });
    spy.mockRestore();
  });
});

describe("secretos: nada de tokens ni URLs en errores, logs ni base", () => {
  it("un error del transporte con el token dentro se guarda limpio", async () => {
    const io = fakeIO({ failFor: ["111", "222"], throwMsg: `fetch a https://api.telegram.org/bot${BOT_TOKEN}/sendMessage falló (${BOT_TOKEN})` });
    await createAlert(candidate({ severity: "high" }));
    await flushTelegramOutbox({ io, config: CFG });
    const [r] = await outbox();
    expect(r.status).toBe("failed");
    expect(r.last_error).toContain("[url]");
    await tokenLeaked();
  });
  it("cliente real con fetch falso: 403 → failed con estado HTTP, sin token; la URL llevó el token pero no se guarda", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), { status: 403 }));
    vi.stubGlobal("fetch", f);
    await createAlert(candidate({ severity: "high" }));
    expect(await flushTelegramOutbox({ config: { ...CFG, allowed: [ANA] } })).toMatchObject({ sent: 0, failed: 1 });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0][0])).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`); // sí lleva el token, en la petición
    const [r] = await outbox();
    expect(r.last_error).toContain("Telegram respondió 403");
    expect(r.last_error).not.toContain("blocked");
    await tokenLeaked();
  });
  it("cliente real: error de red → failed 'error de red'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError(`fetch failed https://api.telegram.org/bot${BOT_TOKEN}`);
    }));
    await createAlert(candidate({ severity: "high" }));
    await flushTelegramOutbox({ config: { ...CFG, allowed: [ANA] } });
    expect((await outbox())[0]).toMatchObject({ status: "failed", last_error: expect.stringContaining("error de red") });
    await tokenLeaked();
  });
  it("cliente real: 200 → sent; chat_id numérico sin 'tg', texto plano y sin parse_mode", async () => {
    const f = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await createAlert(candidate({ severity: "high", title: "Hola", body: "Cuerpo" }));
    expect(await flushTelegramOutbox({ config: CFG })).toMatchObject({ sent: 1 });
    expect(f).toHaveBeenCalledTimes(2);
    const bodies = f.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));
    expect(bodies.map((b) => b.chat_id)).toEqual(["111", "222"]);
    expect(bodies[0].text).toBe("🚨 Hola\nCuerpo");
    expect(bodies[0]).not.toHaveProperty("parse_mode");
    await tokenLeaked();
  });
  it("safeError y chatIdOf", () => {
    expect(safeError(`x ${BOT_TOKEN} y https://a.b/c?d=1`)).toBe("x [token] y [url]");
    expect(safeError(undefined)).toBe("error");
    expect(safeError("a".repeat(500)).length).toBe(200);
    expect(chatIdOf("tg123456")).toBe("123456");
    expect(chatIdOf("123456")).toBe("123456");
  });
});

describe("integración con createAlert y la corrida periódica", () => {
  beforeEach(() => {
    bg.off = false;
  });
  it("createAlert dispara el envío en segundo plano y devuelve de inmediato; un fallo de red no lo rompe", async () => {
    useEnv();
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", f);
    const r = await createAlert(candidate({ severity: "high" }));
    expect(r.created).toBe(true);
    await flushAlertWork();
    expect(f).toHaveBeenCalled();
    expect((await outbox())[0]).toMatchObject({ status: "failed", attempts: 1 });
    await tokenLeaked();
  });
  it("createAlert con Telegram configurado y funcionando: llega una vez por persona aunque se repita", async () => {
    useEnv();
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const c = candidate({ severity: "high" });
    await createAlert(c);
    await createAlert(c);
    await flushAlertWork();
    await flushTelegramOutbox();
    expect(f).toHaveBeenCalledTimes(2);
    expect((await outbox())).toHaveLength(1);
  });
  it("sin Telegram configurado, createAlert funciona igual (el aviso queda pending, no se pierde)", async () => {
    const r = await createAlert(candidate({ severity: "high" }));
    await flushAlertWork();
    expect(r.created).toBe(true);
    expect((await outbox())[0].status).toBe("pending");
  });
  it("maybeRunPeriodicAlerts reintenta lo pendiente aunque la corrida periódica esté en espera", async () => {
    await createAlert(candidate({ severity: "high" })); // sin Telegram configurado aún: se descarta... así que lo configuramos primero
    await query("DELETE dbo.alert_outbox");
    useEnv();
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", f);
    const a = (await query<{ id: number }>("SELECT TOP 1 id FROM dbo.alerts"))[0].id;
    await query(`INSERT dbo.alert_outbox (alert_id, channel) VALUES (${a}, 'telegram')`);
    await maybeRunPeriodicAlerts(); // reserva la corrida
    expect(f).toHaveBeenCalledTimes(2);
    expect((await outbox())[0].status).toBe("sent");
    const b = (await createAlert(candidate({ severity: "high" }))).id!;
    await flushAlertWork();
    await query("DELETE dbo.alert_outbox WHERE alert_id=@a", { a: t.big(b) });
    await query(`INSERT dbo.alert_outbox (alert_id, channel) VALUES (${b}, 'telegram')`);
    f.mockClear();
    await maybeRunPeriodicAlerts(); // dentro de los 15 min: no evalúa reglas, pero sí envía
    expect(f).toHaveBeenCalledTimes(2);
  });
});
