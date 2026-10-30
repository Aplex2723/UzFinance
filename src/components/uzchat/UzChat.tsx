"use client";
import { ArrowUp, Check, LoaderCircle, SquarePen, Square, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { parseEvents, type ChatEvent } from "@/lib/chat/events";
import { toHistory } from "@/lib/chat/history";
import { EVENTS } from "@/lib/client";
import { MiniMarkdown } from "../goals/MiniMarkdown";
import { Orb } from "./Orb";

type ToolStep = { id: string; label: string; state: "running" | "ok" | "error" };
type Msg = { id: string; role: "user" | "assistant"; content: string; tools: ToolStep[]; error?: string };

const STORE = "uzchat:v1";
const KEEP = 40;
const SUGGESTIONS = [
  "¿Cómo voy este mes contra mi ingreso?",
  "¿En qué categorías gasto más?",
  "Quiero ahorrar $50,000 en 6 meses, ¿se puede?",
  "¿Qué cargos recurrentes y MSI tengo?",
];

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

function loadSaved(): Msg[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "[]") as { role?: unknown; content?: unknown }[];
    return raw.flatMap((m) => ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content ? [{ id: uid(), role: m.role, content: m.content, tools: [] }] : []));
  } catch {
    return [];
  }
}

function save(messages: Msg[]) {
  try {
    // Una respuesta que falló o quedó a medias no se recuerda como si fuera completa (ni se le reenvía al modelo).
    const keep = messages.filter((m) => m.content && !m.error).slice(-KEEP).map(({ role, content }) => ({ role, content }));
    if (keep.length) localStorage.setItem(STORE, JSON.stringify(keep));
    else localStorage.removeItem(STORE);
  } catch { /* almacenamiento bloqueado (modo privado): el chat funciona igual, solo no se recuerda */ }
}

/** Lee la respuesta NDJSON del servidor y entrega cada evento; termina cuando se cierra el flujo. */
async function readEvents(res: Response, onEvent: (e: ChatEvent) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const { events, rest } = parseEvents(buf);
    buf = rest;
    events.forEach(onEvent);
  }
  buf += dec.decode();
  parseEvents(`${buf}\n`).events.forEach(onEvent);
}

function ToolPill({ step }: { step: ToolStep }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] text-muted">
      {step.state === "running" ? <LoaderCircle size={11} className="animate-spin" aria-hidden /> : step.state === "ok" ? <Check size={11} className="text-up" aria-hidden /> : <TriangleAlert size={11} className="text-[#f59e0b]" aria-hidden />}
      <span className={step.state === "running" ? "uz-shimmer" : ""}>{step.label}{step.state === "running" ? "…" : ""}</span>
    </span>
  );
}

function Message({ m, streaming, onRetry }: { m: Msg; streaming: boolean; onRetry?: () => void }) {
  if (m.role === "user") {
    return (
      <div className="uz-msg flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-gradient-to-b from-[#ff5a2a] to-[#f04012] px-3.5 py-2 text-[14px] leading-snug text-white shadow-[0_6px_18px_-8px_rgb(255_77_28/0.8)]">{m.content}</p>
      </div>
    );
  }
  const thinking = streaming && !m.content;
  return (
    <div className="uz-msg flex items-start gap-2.5">
      <div className="mt-0.5"><Orb size={26} busy={streaming} /></div>
      <div className="min-w-0 max-w-[88%] flex-1">
        {m.tools.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Consultas que hizo">{m.tools.map((t) => <ToolPill key={t.id} step={t} />)}</div>}
        {thinking && m.tools.length === 0 && <p className="uz-shimmer text-[13px]">Pensando…</p>}
        {m.content && (
          <div className="text-[14px] text-fg/95">
            <MiniMarkdown text={m.content} />
          </div>
        )}
        {m.error && (
          <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-down/30 bg-down/10 px-3 py-2 text-[13px] text-[#fca5a5]">
            <span className="flex-1">{m.error}</span>
            {onRetry && <button type="button" className="btn !h-7 !px-3" onClick={onRetry}>Reintentar</button>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * UzChat: orbe flotante (abajo a la derecha) que abre el chat con el asesor financiero. Al abrirse, un brillo de colores recorre el borde
 * de la pantalla; mientras el agente piensa el brillo y el orbe se aceleran. La conversación vive aquí (y en localStorage del
 * dispositivo); el servidor no guarda nada.
 */
export function UzChat({ configured }: { configured: boolean }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stickRef = useRef(true);
  const hydrated = useRef(false);
  const hideTimer = useRef<number | undefined>(undefined);
  /** Número de la petición en curso: lo que llegue de una anterior (cancelada o reiniciada) se ignora. */
  const reqRef = useRef(0);
  const pressedFrame = useRef(false);
  const titleId = useId();

  // Mientras llega una respuesta se guarda todo menos ella (si se recarga a media respuesta, la pregunta no se pierde).
  useEffect(() => { if (hydrated.current) save(busy ? messages.slice(0, -1) : messages); }, [messages, busy]);
  useEffect(() => () => { abortRef.current?.abort(); window.clearTimeout(hideTimer.current); }, []);

  // La conversación guardada en el dispositivo se recupera la primera vez que se abre el chat (no antes: así el servidor y el cliente pintan lo mismo).
  const show = useCallback(() => {
    if (!hydrated.current) { hydrated.current = true; setMessages(loadSaved()); }
    window.clearTimeout(hideTimer.current);
    setClosing(false);
    setOpen(true);
  }, []);
  const hide = useCallback(() => {
    setClosing(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { setOpen(false); setClosing(false); }, 220);
  }, []);

  useEffect(() => {
    const on = () => show();
    window.addEventListener(EVENTS.openChat, on);
    return () => window.removeEventListener(EVENTS.openChat, on);
  }, [show]);

  // <dialog> modal: foco atrapado, Esc cierra y todo lo demás queda inerte.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (!open) return;
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const vv = window.visualViewport;
    const sync = () => {
      d.style.setProperty("--uz-vh", `${vv?.height ?? window.innerHeight}px`);
      d.style.setProperty("--uz-vt", `${vv?.offsetTop ?? 0}px`);
    };
    sync();
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    const focus = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 120);
    return () => {
      document.documentElement.style.overflow = prevOverflow;
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
      window.clearTimeout(focus);
    };
  }, [open]);

  // Sigue el final de la conversación mientras llega la respuesta, salvo que la persona haya subido a releer.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // El campo de texto crece con lo que se escribe (hasta ~5 líneas).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input, open]);

  const patch = useCallback((id: string, f: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === id ? f(m) : m))), []);

  const send = useCallback(async (raw: string, base?: Msg[]) => {
    const text = raw.trim();
    if (!text || abortRef.current) return;
    const prior = base ?? messages;
    const user: Msg = { id: uid(), role: "user", content: text, tools: [] };
    const bot: Msg = { id: uid(), role: "assistant", content: "", tools: [] };
    // Las respuestas que fallaron (con o sin texto a medias) no viajan al modelo.
    const history = toHistory([...prior.filter((m) => !m.error), user]);
    setMessages([...prior, user, bot]);
    if (!base) setInput(""); // un reintento no borra lo que la persona esté escribiendo
    setBusy(true);
    stickRef.current = true;

    const ac = new AbortController();
    abortRef.current = ac;
    const mine = ++reqRef.current;
    const live = () => reqRef.current === mine;
    // Los pedazos de texto se juntan y se pintan una vez por cuadro (no un render por cada palabra).
    let pending = "";
    let raf = 0;
    const flush = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (!pending) return;
      const chunk = pending;
      pending = "";
      if (live()) patch(bot.id, (m) => ({ ...m, content: m.content + chunk }));
    };
    const fail = (error: string) => {
      flush();
      if (live()) patch(bot.id, (m) => ({ ...m, error, tools: m.tools.map((t) => (t.state === "running" ? { ...t, state: "error" } : t)) }));
    };
    // Solo el `done` del servidor cuenta como respuesta completa: si el flujo se cierra sin él (proxy, red), se avisa.
    let ended = false;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: history }), credentials: "same-origin", signal: ac.signal });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        ended = true;
        fail(err.error ?? `Error ${res.status}`);
        return;
      }
      await readEvents(res, (e) => {
        if (!live()) return;
        if (e.type === "text") { pending += e.delta; if (!raf) raf = requestAnimationFrame(flush); }
        else if (e.type === "tool") {
          flush();
          patch(bot.id, (m) => {
            const state: ToolStep["state"] = e.phase === "start" ? "running" : e.ok === false ? "error" : "ok";
            return m.tools.some((t) => t.id === e.id) ? { ...m, tools: m.tools.map((t) => (t.id === e.id ? { ...t, state } : t)) } : { ...m, tools: [...m.tools, { id: e.id, label: e.label, state }] };
          });
        } else if (e.type === "error") { ended = true; fail(e.message); }
        else if (e.type === "done") ended = true;
      });
      flush();
      if (!ended) fail("Se cortó la respuesta; intenta de nuevo");
    } catch (e) {
      if ((e as Error)?.name === "AbortError") flush();
      else fail("Sin conexión con el servidor");
    } finally {
      if (live()) { abortRef.current = null; setBusy(false); }
    }
  }, [messages, patch]);

  const stop = () => abortRef.current?.abort();
  const reset = () => {
    reqRef.current++; // lo que siga llegando de la petición anterior se descarta
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  };
  const retry = (botId: string) => {
    const i = messages.findIndex((m) => m.id === botId);
    const user = messages[i - 1];
    if (i < 1 || user?.role !== "user") return;
    void send(user.content, messages.slice(0, i - 1));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // En escritorio Enter envía (Mayús+Enter = salto de línea); en el celular Enter es salto de línea y se envía con el botón.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(hover: hover)").matches) {
      e.preventDefault();
      void send(input);
    }
  };

  const last = messages[messages.length - 1];
  const glowOn = open && !closing;
  return (
    <>
      <button type="button" onClick={show} className={`uz-fab group fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-30 rounded-full lg:bottom-6 lg:right-6 ${open ? "pointer-events-none invisible" : ""}`} aria-label="Abrir UzChat, tu asesor financiero" data-testid="uzchat-open">
        <span className="pointer-events-none absolute right-full top-1/2 mr-3 hidden -translate-y-1/2 whitespace-nowrap rounded-full border border-line bg-black/70 px-3 py-1.5 text-[12px] text-fg opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 lg:block">Pregúntale a UzChat</span>
        <Orb size={58} busy={busy} />
      </button>

      <dialog
        ref={dialogRef}
        className="uz-dialog"
        data-closing={closing}
        aria-labelledby={titleId}
        onCancel={(e) => { e.preventDefault(); hide(); }}
        data-testid="uzchat"
      >
        {open && (
          <>
            <i className="uz-edge" data-on={glowOn} aria-hidden />
            <div className="uz-glow" data-on={glowOn} data-busy={busy} aria-hidden><i className="uz-glow-soft" /></div>
            <div
              className="uz-frame flex items-end justify-end sm:p-6"
              onPointerDown={(e) => { pressedFrame.current = e.target === e.currentTarget; }}
              // Solo cierra si el clic empezó Y terminó fuera del panel (arrastrar una selección de texto hasta afuera no lo cierra).
              onClick={(e) => { if (e.target === e.currentTarget && pressedFrame.current) hide(); pressedFrame.current = false; }}
            >
              <section className="uz-panel flex h-full w-full flex-col overflow-hidden sm:h-[min(720px,100%)] sm:w-[440px] sm:rounded-[26px] sm:border sm:border-white/10">
                <header className="flex items-center gap-3 px-4 pb-3 pt-[max(0.9rem,env(safe-area-inset-top))] sm:pt-4">
                  <Orb size={34} busy={busy} />
                  <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="num text-[17px] font-semibold leading-tight">UzChat</h2>
                    <p className="truncate text-[12px] text-muted">{busy ? "Consultando tus cifras…" : "Tu asesor financiero personal"}</p>
                  </div>
                  <button type="button" className="btn !h-8 !w-8 !p-0" onClick={reset} disabled={!messages.length && !busy} aria-label="Nueva conversación" title="Nueva conversación"><SquarePen size={14} /></button>
                  <button type="button" className="btn !h-8 !w-8 !p-0" onClick={hide} aria-label="Cerrar UzChat"><X size={14} /></button>
                </header>

                <div
                  ref={scrollRef}
                  onScroll={(e) => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
                  className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-3"
                  role="log"
                  aria-live={busy ? "off" : "polite"}
                  aria-busy={busy}
                >
                  {messages.length === 0 ? (
                    <div className="m-auto flex w-full flex-col items-center gap-5 py-6 text-center">
                      <Orb size={84} busy={busy} />
                      <div>
                        <p className="num text-xl font-semibold">Hola, soy UzChat</p>
                        <p className="mx-auto mt-1.5 max-w-[300px] text-muted">Conozco tus gastos, tarjetas, MSI y metas. Pregúntame lo que quieras de tu dinero.</p>
                      </div>
                      {configured ? (
                        <div className="flex w-full flex-col gap-2">
                          {SUGGESTIONS.map((s) => (
                            <button key={s} type="button" onClick={() => void send(s)} className="rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-left text-[13px] text-fg/90 transition-colors hover:border-white/20 hover:bg-surface-2">{s}</button>
                          ))}
                        </div>
                      ) : (
                        <p role="status" className="rounded-2xl border border-line bg-surface px-3.5 py-3 text-[13px] text-muted">UzChat necesita una API key de OpenRouter. Agrégala como <code className="text-fg">OPENROUTER_API_KEY</code> y vuelve a abrir el chat.</p>
                      )}
                    </div>
                  ) : (
                    messages.map((m) => <Message key={m.id} m={m} streaming={busy && m === last} onRetry={m.error && !busy ? () => retry(m.id) : undefined} />)
                  )}
                </div>

                <form
                  className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2"
                  onSubmit={(e) => { e.preventDefault(); void send(input); }}
                >
                  <div className="flex items-end gap-2 rounded-[22px] border border-white/10 bg-black/40 p-1.5 pl-3.5 focus-within:border-white/25">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={onKeyDown}
                      rows={1}
                      maxLength={2000}
                      placeholder={configured ? "Pregunta sobre tu dinero…" : "UzChat no está configurado"}
                      disabled={!configured}
                      aria-label="Mensaje para UzChat"
                      className="max-h-[132px] min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-snug text-fg outline-none placeholder:text-faint sm:text-[14px]"
                      data-testid="uzchat-input"
                    />
                    {busy ? (
                      <button type="button" onClick={stop} className="btn btn-primary !h-9 !w-9 !p-0" aria-label="Detener respuesta"><Square size={13} fill="currentColor" /></button>
                    ) : (
                      <button type="submit" disabled={!configured || !input.trim()} className="btn btn-primary !h-9 !w-9 !p-0" aria-label="Enviar mensaje" data-testid="uzchat-send"><ArrowUp size={16} /></button>
                    )}
                  </div>
                  <p className="mt-2 px-2 text-center text-[10.5px] leading-snug text-faint">UzChat puede equivocarse: verifica lo importante. Tus preguntas y las cifras que consulta se envían al modelo (OpenRouter).</p>
                </form>
              </section>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
