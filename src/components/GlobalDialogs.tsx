"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, EVENTS } from "@/lib/client";
import { formatMXN } from "@/lib/money";
import { isDebitCard, MSI_MAX, MSI_MIN } from "@/lib/msi";
import type { Card, Category, Transaction } from "@/lib/types";
import { Dialog } from "./ui/Dialog";

const localDt = (d: Date) => {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 16);
};

/** Meses que se ofrecen en el formulario (los planes de los bancos mexicanos casi siempre son uno de estos). */
const MSI_CHOICES = [...Array.from({ length: 23 }, (_, i) => i + MSI_MIN), 30, 36, MSI_MAX];

type Similar = { id: number; merchant: string; amount_cents: number; occurred_at: string; already_msi?: boolean };

function TransactionForm({ cards, categories, editing, msiPreset, onDone }: { cards: Card[]; categories: Category[]; editing: Transaction | null; msiPreset: boolean; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const selectable = cards.filter((c) => c.active || c.id === editing?.card_id);
  const [cardId, setCardId] = useState<number | undefined>(editing?.card_id ?? (msiPreset ? selectable.find((c) => !isDebitCard(c))?.id : undefined) ?? selectable[0]?.id);
  const [kind, setKind] = useState(editing && editing.amount_cents < 0 ? "refund" : "expense");
  const [months, setMonths] = useState<number | null>(msiPreset ? 3 : null);
  const [amountText, setAmountText] = useState(editing ? (Math.abs(editing.amount_cents) / 100).toFixed(2) : "");
  const [similar, setSimilar] = useState<{ found: Similar; body: Record<string, unknown> } | null>(null);
  const card = selectable.find((c) => c.id === cardId);
  const msiAllowed = kind === "expense" && !!card && !isDebitCard(card) && !editing?.plan_id;
  const amountNum = Number(amountText.replace(/[$,\s]/g, ""));
  const monthlyHint = msiAllowed && months && amountNum > 0 ? formatMXN(Math.round((amountNum * 100) / months)) : null;

  function done() {
    onDone();
    router.refresh();
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    setSimilar(null);
    let amount = String(f.get("amount") ?? "").replace(/^-/, "");
    if (kind === "refund") amount = `-${amount}`;
    const body = {
      date: new Date(String(f.get("date"))).toISOString(),
      amount,
      merchant: String(f.get("merchant")),
      card_id: Number(f.get("card_id")),
      category_id: f.get("category_id") ? Number(f.get("category_id")) : null,
      notes: String(f.get("notes") ?? "") || null,
    };
    const msi = msiAllowed && months ? months : null;
    if (editing) {
      const r = await apiFetch(`/api/transactions/${editing.id}`, "PUT", body);
      if (!r.ok) { setBusy(false); return setError(r.error); }
      if (msi) {
        const m = await apiFetch(`/api/transactions/${editing.id}/msi`, "POST", { months: msi });
        if (!m.ok) { setBusy(false); return setError(`Cambios guardados, pero no se pudo pasar a meses: ${m.error}`); }
      }
      setBusy(false);
      return done();
    }
    await create({ ...body, msi_months: msi });
  }

  async function create(body: Record<string, unknown>) {
    setBusy(true);
    const r = await apiFetch<{ msi_error?: string }>("/api/transactions", "POST", body);
    setBusy(false);
    if (!r.ok) {
      const found = r.status === 409 ? (r.body?.similar as Similar | undefined) : undefined;
      if (found) return setSimilar({ found, body });
      return setError(r.error);
    }
    if (r.data.msi_error) return setError(`Gasto guardado, pero sin plan a meses: ${r.data.msi_error}`);
    done();
  }

  /** La compra ya estaba registrada (Atajo, correo, chat): se pasa ESA a meses en vez de duplicarla. */
  async function useExisting() {
    if (!similar) return;
    setBusy(true);
    const r = await apiFetch(`/api/transactions/${similar.found.id}/msi`, "POST", { months: similar.body.msi_months });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    done();
  }

  if (similar) {
    const s = similar.found;
    return (
      <div className="grid gap-3.5" data-testid="msi-similar">
        <p>Ya está registrada esta compra en <b>{card?.name}</b>:</p>
        <div className="rounded-lg border border-line p-3">
          <p className="font-medium">{s.merchant}</p>
          <p className="text-[12px] text-muted"><span className="num">{formatMXN(s.amount_cents)}</span> · {new Date(s.occurred_at).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
        {s.already_msi ? (
          <p className="text-muted">Esa compra ya está a meses sin intereses. Si es la misma, no hace falta agregar nada.</p>
        ) : (
          <p className="text-muted">¿Es la misma? Si sí, solo se pasa a {String(similar.body.msi_months)} meses sin intereses (no se duplica el gasto).</p>
        )}
        {error && <p role="alert" className="text-down">{error}</p>}
        {s.already_msi ? (
          <button className="btn btn-primary !h-10" disabled={busy} onClick={onDone}>Sí, es la misma: cerrar</button>
        ) : (
          <button className="btn btn-primary !h-10" disabled={busy} onClick={useExisting}>{busy ? "Guardando…" : "Sí, pasar esa a meses"}</button>
        )}
        <button className="btn !h-10" disabled={busy} onClick={() => create({ ...similar.body, allow_duplicate: true })}>No, es otra compra: agregarla</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3.5">
      <div>
        <label className="label" htmlFor="tx-merchant">Comercio</label>
        <input id="tx-merchant" name="merchant" required maxLength={120} defaultValue={editing?.merchant_raw} className="field" autoComplete="off" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="tx-amount">Monto (MXN)</label>
          <input id="tx-amount" name="amount" required inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} className="field" />
        </div>
        <div>
          <label className="label" htmlFor="tx-kind">Tipo</label>
          <select id="tx-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className="field">
            <option value="expense">Gasto</option>
            <option value="refund">Reembolso</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="tx-card">Tarjeta</label>
          <select id="tx-card" name="card_id" required value={cardId} onChange={(e) => setCardId(Number(e.target.value))} className="field">
            {selectable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="tx-cat">Categoría</label>
          <select id="tx-cat" name="category_id" defaultValue={editing?.category_id ?? ""} className="field">
            <option value="">Sin categoría</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="tx-date">Fecha y hora</label>
        <input id="tx-date" name="date" type="datetime-local" required defaultValue={localDt(editing ? new Date(editing.occurred_at) : new Date())} className="field" />
      </div>
      {editing?.plan_id ? (
        <p className="text-[12px] text-muted" data-testid="tx-msi-linked">A meses sin intereses · <Link href="/msi" className="underline">ver plan</Link></p>
      ) : msiAllowed ? (
        <div>
          <label className="label" htmlFor="tx-msi">A meses sin intereses</label>
          <select id="tx-msi" value={months ?? ""} onChange={(e) => setMonths(e.target.value ? Number(e.target.value) : null)} className="field">
            <option value="">No, de contado</option>
            {MSI_CHOICES.map((n) => <option key={n} value={n}>{n} meses</option>)}
          </select>
          {monthlyHint && <p className="mt-1 text-[11px] text-muted">≈ <span className="num">{monthlyHint}</span> al mes · el gasto se registra completo y el plan aparece en MSI</p>}
        </div>
      ) : null}
      <div>
        <label className="label" htmlFor="tx-notes">Notas</label>
        <input id="tx-notes" name="notes" maxLength={500} defaultValue={editing?.notes ?? ""} className="field" />
      </div>
      {error && <p role="alert" className="text-down">{error}</p>}
      <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : msiAllowed && months ? `Agregar a ${months} MSI` : "Agregar gasto"}</button>
    </form>
  );
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setMsg({ ok: false, text: "El archivo excede 2 MB" });
    setBusy(true);
    setMsg(null);
    const r = await apiFetch<{ inserted: number; duplicates: number; skipped: number }>("/api/transactions/import", "POST", await file.text(), "text/csv");
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({ ok: true, text: `Importadas: ${r.data.inserted} · duplicadas omitidas: ${r.data.duplicates} · filas con error: ${r.data.skipped}` });
    router.refresh();
    if (r.data.inserted > 0 && r.data.skipped === 0) setTimeout(onDone, 1200);
  }

  return (
    <form onSubmit={submit} className="grid gap-3.5">
      <p className="text-muted">
        CSV con encabezados <code className="text-fg">fecha, comercio, monto, tarjeta</code> (opcional: <code className="text-fg">categoria, notas</code>). Fechas AAAA-MM-DD o DD/MM/AAAA. Reembolsos con monto negativo. Máx. 2 MB / 5,000 filas.
      </p>
      <input name="file" type="file" accept=".csv,text/csv" required className="field !h-auto py-2" aria-label="Archivo CSV" />
      {msg && <p role="status" className={msg.ok ? "text-up" : "text-down"}>{msg.text}</p>}
      <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Importando…" : "Importar"}</button>
    </form>
  );
}

export function GlobalDialogs({ cards, categories }: { cards: Card[]; categories: Category[] }) {
  const [add, setAdd] = useState(false);
  const [csv, setCsv] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [msiPreset, setMsiPreset] = useState(false);
  const [openSeq, setOpenSeq] = useState(0);

  useEffect(() => {
    const onAdd = (e: Event) => { setEditing(null); setMsiPreset(!!(e as CustomEvent<{ msi?: boolean } | undefined>).detail?.msi); setOpenSeq((n) => n + 1); setAdd(true); };
    const onCsv = () => setCsv(true);
    const onEdit = (e: Event) => { setEditing((e as CustomEvent<Transaction>).detail); setMsiPreset(false); setOpenSeq((n) => n + 1); setAdd(true); };
    window.addEventListener(EVENTS.addExpense, onAdd);
    window.addEventListener(EVENTS.importCsv, onCsv);
    window.addEventListener(EVENTS.editTransaction, onEdit);
    return () => {
      window.removeEventListener(EVENTS.addExpense, onAdd);
      window.removeEventListener(EVENTS.importCsv, onCsv);
      window.removeEventListener(EVENTS.editTransaction, onEdit);
    };
  }, []);

  return (
    <>
      <Dialog open={add} onClose={() => setAdd(false)} title={editing ? "Editar movimiento" : msiPreset ? "Agregar compra a meses sin intereses" : "Agregar gasto"}>
        <TransactionForm key={`${editing?.id ?? "new"}-${openSeq}`} cards={cards} categories={categories} editing={editing} msiPreset={msiPreset} onDone={() => setAdd(false)} />
      </Dialog>
      <Dialog open={csv} onClose={() => setCsv(false)} title="Importar CSV">
        <ImportForm onDone={() => setCsv(false)} />
      </Dialog>
    </>
  );
}
