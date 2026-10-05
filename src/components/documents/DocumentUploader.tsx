"use client";
import { CheckCircle2, FileUp, Loader2, Lock, TriangleAlert, XCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { IntakeResult } from "@/lib/docs/intake";
import { Chip, KIND_LABEL, type Tone } from "./shared";

const MAX_BYTES = 12 * 1024 * 1024;

type Outcome = { id: number; name: string; result?: IntakeResult; error?: string };
type Phase = "idle" | "reading" | "reconciling";

const PASSWORD_RE = /contrase/i;

/** Qué le decimos al usuario según lo que respondió el backend. */
export function describeResult(r: IntakeResult): { label: string; tone: Tone; Icon: typeof CheckCircle2 } {
  if (r.status === "processed") {
    if (r.already || r.registered === "duplicate") return { label: r.kind === "statement" ? "Ya lo habías subido" : "Ya estaba registrada", tone: "info", Icon: CheckCircle2 };
    return { label: r.kind === "statement" ? "Estado conciliado" : "Registrada", tone: "good", Icon: CheckCircle2 };
  }
  if (r.status === "needs_review") return { label: "Necesita tu revisión", tone: "warn", Icon: TriangleAlert };
  if (r.status === "rejected") return { label: "Rechazada", tone: "mute", Icon: XCircle };
  return { label: "No se pudo leer", tone: "bad", Icon: XCircle };
}

export function needsPassword(r: IntakeResult): boolean {
  return r.status === "failed" && PASSWORD_RE.test(r.detail ?? "");
}

async function upload(file: File, password?: string): Promise<{ ok: true; data: IntakeResult } | { ok: false; error: string }> {
  const form = new FormData();
  form.set("file", file);
  if (password) form.set("password", password);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 130_000);
  try {
    const res = await fetch("/api/documents", { method: "POST", body: form, credentials: "same-origin", signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error ?? `Error ${res.status}` };
    return { ok: true, data: data as IntakeResult };
  } catch (e) {
    return { ok: false, error: (e as Error).name === "AbortError" ? "Tardó demasiado: intenta de nuevo en un momento" : "Sin conexión con el servidor" };
  } finally {
    clearTimeout(timer);
  }
}

/** Subir PDF: arrastrar y soltar en escritorio, botón que abre Archivos en el celular. */
export function DocumentUploader() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [current, setCurrent] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  /** PDF protegido: se conserva para reintentar con la contraseña. */
  const [locked, setLocked] = useState<{ file: File; wrong: boolean } | null>(null);
  const [password, setPassword] = useState("");

  // El OCR tarda unos segundos: tras un momento el texto cambia para que se note que sigue trabajando.
  useEffect(() => {
    if (phase !== "reading") return;
    const h = setTimeout(() => setPhase("reconciling"), 3500);
    return () => clearTimeout(h);
  }, [phase, current]);

  async function send(file: File, pw?: string) {
    const id = ++seq.current;
    if (file.size > MAX_BYTES) return setOutcomes((o) => [{ id, name: file.name, error: "El PDF pesa demasiado (máximo 12 MB)" }, ...o]);
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) return setOutcomes((o) => [{ id, name: file.name, error: "Solo se aceptan archivos PDF" }, ...o]);
    setCurrent(file.name);
    setPhase("reading");
    const r = await upload(file, pw);
    setPhase("idle");
    setCurrent(null);
    if (!r.ok) return setOutcomes((o) => [{ id, name: file.name, error: r.error }, ...o]);
    if (needsPassword(r.data)) {
      setLocked({ file, wrong: pw !== undefined });
      setPassword("");
      return;
    }
    setLocked(null);
    setOutcomes((o) => [{ id, name: file.name, result: r.data }, ...o]);
    router.refresh();
  }

  async function sendAll(files: FileList | File[]) {
    setLocked(null);
    for (const f of Array.from(files).slice(0, 5)) await send(f);
  }

  const busy = phase !== "idle";
  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label="Subir PDF"
        data-testid="drop-zone"
        onDragOver={(e) => { e.preventDefault(); if (!busy) setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!busy && e.dataTransfer.files.length) void sendAll(e.dataTransfer.files); }}
        className={`flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${drag ? "border-accent bg-accent/10" : "border-line bg-black/20"}`}
      >
        {busy ? (
          <div role="status" aria-live="polite" className="flex flex-col items-center gap-2" data-testid="upload-busy">
            <Loader2 size={28} className="animate-spin text-accent-2" aria-hidden />
            <p className="text-[15px] font-medium">{phase === "reading" ? "Leyendo…" : "Conciliando…"}</p>
            <p className="max-w-[320px] text-muted">{current}. {phase === "reconciling" ? "Esto puede tardar unos segundos; no cierres la pantalla." : "Estoy revisando el PDF."}</p>
          </div>
        ) : (
          <>
            <FileUp size={30} className="text-muted" aria-hidden />
            <div>
              <p className="text-[15px] font-medium">Sube un comprobante o un estado de cuenta</p>
              <p className="mt-1 text-muted">PDF de Banamex, Amex o Nu · máximo 12 MB. El archivo no se guarda: solo lo que se lee.</p>
            </div>
            <button type="button" className="btn btn-primary !h-12 !px-6 text-[14px]" onClick={() => input.current?.click()} data-testid="pick-pdf">
              <FileUp size={16} aria-hidden /> Elegir PDF
            </button>
            <p className="hidden text-[11px] text-faint lg:block">o arrástralo y suéltalo aquí</p>
          </>
        )}
        <input
          ref={input}
          type="file"
          accept="application/pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-label="Archivo PDF"
          data-testid="pdf-input"
          disabled={busy}
          onChange={(e) => { const f = e.currentTarget.files; if (f?.length) void sendAll(Array.from(f)); e.currentTarget.value = ""; }}
        />
      </div>

      {locked && !busy && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (password) void send(locked.file, password); }}
          className="glass flex flex-col gap-3 border-l-2 border-l-[#f59e0b] p-4"
          data-testid="password-form"
        >
          <p className="flex items-center gap-2 font-medium"><Lock size={14} aria-hidden /> El PDF está protegido</p>
          <p className="text-muted">
            {locked.wrong ? "La contraseña no es correcta. " : ""}Escribe la contraseña de <b className="text-fg">{locked.file.name}</b>. No se guarda en ningún lado.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="sr-only" htmlFor="pdf-password">Contraseña del PDF</label>
            <input id="pdf-password" type="password" autoComplete="off" maxLength={100} value={password} onChange={(e) => setPassword(e.target.value)} className="field !h-11" placeholder="Contraseña del PDF" autoFocus />
            <button className="btn btn-primary !h-11 sm:!px-6" disabled={!password}>Reintentar</button>
            <button type="button" className="btn !h-11" onClick={() => setLocked(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {outcomes.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Resultado de lo que subiste" aria-live="polite" data-testid="upload-results">
          {outcomes.slice(0, 5).map((o) => {
            const d = o.result ? describeResult(o.result) : null;
            return (
              <li key={o.id} className="glass flex flex-col gap-1.5 p-3.5" data-testid="upload-result">
                <div className="flex flex-wrap items-center gap-2">
                  {d ? <d.Icon size={16} aria-hidden className={d.tone === "good" ? "text-up" : d.tone === "bad" ? "text-down" : d.tone === "warn" ? "text-[#fbbf24]" : "text-muted"} /> : <XCircle size={16} aria-hidden className="text-down" />}
                  <p className="text-[14px] font-medium" data-testid="result-label">{d ? d.label : "No se pudo subir"}</p>
                  {o.result && <Chip>{KIND_LABEL[o.result.kind]}</Chip>}
                </div>
                <p className="truncate text-[11px] text-faint">{o.name}</p>
                {o.result?.title && <p className="font-medium">{o.result.title}</p>}
                {(o.result?.detail || o.error) && <p className={o.error ? "text-down" : "text-muted"}>{o.error ?? o.result?.detail}</p>}
                {o.result?.kind === "statement" && o.result.status !== "failed" && typeof o.result.openFindings === "number" && (
                  <p className="text-muted">{o.result.openFindings === 0 ? "Sin diferencias abiertas." : `${o.result.openFindings} diferencia${o.result.openFindings === 1 ? "" : "s"} por revisar${o.result.highFindings ? ` · ${o.result.highFindings} grave${o.result.highFindings === 1 ? "" : "s"}` : ""}.`}</p>
                )}
                {o.result && o.result.status !== "failed" && o.result.status !== "rejected" && (
                  <div>
                    <Link href={`/documentos/${o.result.documentId}`} className={`btn !h-10 ${o.result.status === "needs_review" ? "btn-primary" : ""}`} data-testid="open-result">
                      {o.result.status === "needs_review" ? "Revisar ahora" : "Ver detalle"}
                    </Link>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
