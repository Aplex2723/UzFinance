"use client";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { DocumentDetail } from "@/lib/docs/detail";
import { formatDay, formatTime } from "@/lib/format";
import { formatMXN, MoneyParseError, parseAmountToCents } from "@/lib/money";
import { TZ } from "@/lib/time";
import type { Category } from "@/lib/types";
import { Panel } from "../ui/Panel";
import { Chip } from "./shared";

type Transfer = NonNullable<DocumentDetail["transfer"]>;

const SYSTEM_CARDS = new Set(["Domiciliación", "Sin asignar"]);
const localFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
/** ISO (UTC) → valor de <input type="datetime-local"> en hora de Ciudad de México. */
const toLocalInput = (iso: string) => localFmt.format(new Date(iso)).replace(" ", "T");
/** CDMX no tiene horario de verano desde 2022: -06:00 fijo (igual que el resto de la app). */
const fromLocalInput = (v: string) => new Date(`${v}:00-06:00`).toISOString();

/** Lo que se leyó del comprobante, para compararlo con el PDF. */
export function TransferSummary({ tr, read }: { tr: Transfer["transfer"]; read: Transfer["read"] }) {
  const dest = [tr.destName ?? tr.destAlias, tr.destBank, tr.destTail ? `···${tr.destTail}` : null].filter(Boolean).join(" · ");
  const rows: [string, string][] = [
    ["Monto", formatMXN(tr.amountCents)],
    ["Fecha y hora", `${formatDay(tr.occurredAt)} ${formatTime(tr.occurredAt)}`],
    ["Cuenta de origen", `${tr.originLabel} ···${tr.originTail}${tr.accountType ? ` · ${tr.accountType}` : ""}`],
    ["Destino", dest || "—"],
    ["Concepto", tr.concept ?? "—"],
    ["Clave de rastreo", tr.trackingKey],
  ];
  return (
    <dl className="divide-y divide-line" data-testid="transfer-summary">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 py-2">
          <dt className="text-muted">{k}</dt>
          <dd className="num min-w-0 break-all text-right">{v}</dd>
        </div>
      ))}
      <div className="flex justify-between gap-4 py-2"><dt className="text-muted">Cómo se leyó</dt><dd>{read === "ocr" ? "Reconocimiento de texto (OCR)" : "Texto del PDF"}</dd></div>
    </dl>
  );
}

export function TransferReview({ detail, categories }: { detail: DocumentDetail; categories: Category[] }) {
  const router = useRouter();
  const ex = detail.transfer as Transfer;
  const tr = ex.transfer;
  const cards = detail.cards.filter((c) => c.active && !SYSTEM_CARDS.has(c.name));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flagged = ex.conflicts.length > 0 || !!ex.reason;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    const body: Record<string, unknown> = { card_id: Number(f.get("card_id")), remember: f.get("remember") === "on" };
    const amount = String(f.get("amount") ?? "").trim();
    try {
      const cents = parseAmountToCents(amount);
      if (cents < 0) throw new MoneyParseError("el monto debe ser positivo");
      if (cents !== tr.amountCents) body.amount_cents = cents;
    } catch {
      return setError("Escribe un monto válido, por ejemplo 1,234.56");
    }
    const at = String(f.get("occurred_at") ?? "");
    if (!at) return setError("Indica la fecha y la hora");
    if (at !== toLocalInput(tr.occurredAt)) body.occurred_at = fromLocalInput(at);
    const key = String(f.get("tracking_key") ?? "").trim();
    if (!/^[A-Za-z0-9]{8,30}$/.test(key)) return setError("La clave de rastreo son de 8 a 30 letras o números");
    if (key.toUpperCase() !== tr.trackingKey.toUpperCase()) body.tracking_key = key;
    const merchant = String(f.get("merchant") ?? "").trim();
    if (merchant) body.merchant = merchant;
    if (f.get("category_id")) body.category_id = Number(f.get("category_id"));
    const notes = String(f.get("notes") ?? "").trim();
    if (notes) body.notes = notes;

    setBusy(true);
    const r = await apiFetch(`/api/documents/${detail.document.id}/confirm`, "POST", body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      <Panel title="Lo que leí del comprobante">
        {flagged && (
          <div role="alert" className="mb-3 rounded-xl border border-[#f59e0b]/40 bg-[#f59e0b]/10 p-3" data-testid="transfer-conflicts">
            <p className="mb-1 flex items-center gap-2 font-medium text-[#fbbf24]"><TriangleAlert size={14} aria-hidden /> Revisa esto antes de registrar</p>
            {ex.reason && <p className="text-fg">{ex.reason[0].toUpperCase()}{ex.reason.slice(1)}.</p>}
            {ex.conflicts.length > 0 && (
              <>
                <p className="mt-1 text-muted">Las dos lecturas del PDF no coincidieron en:</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">{ex.conflicts.map((c) => <li key={c}><Chip tone="warn">{c}</Chip></li>)}</ul>
              </>
            )}
            <p className="mt-2 text-[11px] text-muted">Compara con tu PDF y corrige lo que esté mal.</p>
          </div>
        )}
        <TransferSummary tr={tr} read={ex.read} />
      </Panel>

      <Panel title="Confirmar y registrar">
        <form onSubmit={submit} className="grid gap-3.5" data-testid="confirm-form">
          <div>
            <label className="label" htmlFor="c-card">¿De qué tarjeta salió?</label>
            <select id="c-card" name="card_id" required defaultValue={ex.candidate?.cardId ?? ""} className="field !h-11">
              <option value="" disabled>Elige una tarjeta…</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {ex.candidate && <p className="mt-1 text-[11px] text-muted">Sugerida por {ex.candidate.how === "aprendida" ? "lo que ya me habías indicado" : ex.candidate.how === "terminación" ? "la terminación de la cuenta" : "ser tu único débito"}.</p>}
          </div>
          <label className="flex items-start gap-2.5 text-muted">
            <input type="checkbox" name="remember" defaultChecked className="mt-0.5 h-5 w-5 accent-[#ff4d1c]" />
            <span>Recordar que la cuenta <b className="num text-fg">···{tr.originTail}</b> es esta tarjeta (la próxima vez ya no pregunto).</span>
          </label>

          <fieldset className="grid gap-3 rounded-xl border border-line p-3">
            <legend className="px-1 text-[11px] text-muted">Corregir solo si el OCR leyó mal</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="c-amount">Monto (MXN)</label>
                <input id="c-amount" name="amount" required inputMode="decimal" defaultValue={(tr.amountCents / 100).toFixed(2)} className="field !h-11" />
              </div>
              <div>
                <label className="label" htmlFor="c-date">Fecha y hora</label>
                <input id="c-date" name="occurred_at" type="datetime-local" required defaultValue={toLocalInput(tr.occurredAt)} className="field !h-11" />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="c-key">Clave de rastreo</label>
              <input id="c-key" name="tracking_key" required maxLength={30} defaultValue={tr.trackingKey} className="field !h-11 font-mono" autoCapitalize="characters" autoComplete="off" spellCheck={false} />
            </div>
          </fieldset>

          <div>
            <label className="label" htmlFor="c-merchant">Comercio o concepto <span className="text-faint">(opcional)</span></label>
            <input id="c-merchant" name="merchant" maxLength={120} className="field !h-11" placeholder={tr.concept ?? "Se usa el concepto del comprobante"} autoComplete="off" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="c-cat">Categoría <span className="text-faint">(opcional)</span></label>
              <select id="c-cat" name="category_id" defaultValue="" className="field !h-11">
                <option value="">Automática</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="c-notes">Nota <span className="text-faint">(opcional)</span></label>
              <input id="c-notes" name="notes" maxLength={300} className="field !h-11" autoComplete="off" />
            </div>
          </div>
          {error && <p role="alert" className="text-down" data-testid="confirm-error">{error}</p>}
          <button className="btn btn-primary !h-12 text-[14px]" disabled={busy} data-testid="confirm-submit">{busy ? "Registrando…" : "Confirmar y registrar"}</button>
        </form>
      </Panel>
    </div>
  );
}

/** Comprobante ya resuelto: solo lectura. */
export function TransferDone({ detail }: { detail: DocumentDetail }) {
  const ex = detail.transfer;
  if (!ex) return null;
  const txId = detail.document.tx_id;
  return (
    <Panel title="Lo que se leyó del comprobante" action={txId ? <Link href={`/transacciones?q=${encodeURIComponent(ex.transfer.trackingKey)}`} className="btn !h-9 text-[12px]">Ver el movimiento</Link> : undefined}>
      <TransferSummary tr={ex.transfer} read={ex.read} />
    </Panel>
  );
}
