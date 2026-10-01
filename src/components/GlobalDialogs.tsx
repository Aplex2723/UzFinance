"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, EVENTS } from "@/lib/client";
import type { Card, Category, Transaction } from "@/lib/types";
import { Dialog } from "./ui/Dialog";

const localDt = (d: Date) => {
  const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return p.toISOString().slice(0, 16);
};

function TransactionForm({ cards, categories, editing, onDone }: { cards: Card[]; categories: Category[]; editing: Transaction | null; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const kind = f.get("kind");
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
    const r = editing ? await apiFetch(`/api/transactions/${editing.id}`, "PUT", body) : await apiFetch("/api/transactions", "POST", body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone();
    router.refresh();
  }

  const refund = editing ? editing.amount_cents < 0 : false;
  return (
    <form onSubmit={submit} className="grid gap-3.5">
      <div>
        <label className="label" htmlFor="tx-merchant">Comercio</label>
        <input id="tx-merchant" name="merchant" required maxLength={120} defaultValue={editing?.merchant_raw} className="field" autoComplete="off" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="tx-amount">Monto (MXN)</label>
          <input id="tx-amount" name="amount" required inputMode="decimal" placeholder="0.00" defaultValue={editing ? (Math.abs(editing.amount_cents) / 100).toFixed(2) : ""} className="field" />
        </div>
        <div>
          <label className="label" htmlFor="tx-kind">Tipo</label>
          <select id="tx-kind" name="kind" defaultValue={refund ? "refund" : "expense"} className="field">
            <option value="expense">Gasto</option>
            <option value="refund">Reembolso</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor="tx-card">Tarjeta</label>
          <select id="tx-card" name="card_id" required defaultValue={editing?.card_id} className="field">
            {cards.filter((c) => c.active || c.id === editing?.card_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
      <div>
        <label className="label" htmlFor="tx-notes">Notas</label>
        <input id="tx-notes" name="notes" maxLength={500} defaultValue={editing?.notes ?? ""} className="field" />
      </div>
      {error && <p role="alert" className="text-down">{error}</p>}
      <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Agregar gasto"}</button>
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

  useEffect(() => {
    const onAdd = () => { setEditing(null); setAdd(true); };
    const onCsv = () => setCsv(true);
    const onEdit = (e: Event) => { setEditing((e as CustomEvent<Transaction>).detail); setAdd(true); };
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
      <Dialog open={add} onClose={() => setAdd(false)} title={editing ? "Editar movimiento" : "Agregar gasto"}>
        <TransactionForm key={editing?.id ?? "new"} cards={cards} categories={categories} editing={editing} onDone={() => setAdd(false)} />
      </Dialog>
      <Dialog open={csv} onClose={() => setCsv(false)} title="Importar CSV">
        <ImportForm onDone={() => setCsv(false)} />
      </Dialog>
    </>
  );
}
