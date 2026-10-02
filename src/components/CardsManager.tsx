"use client";
import { Plus, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { ISSUER_COLOR, ISSUER_LABEL } from "@/lib/format";
import type { Card } from "@/lib/types";
import { Dialog } from "./ui/Dialog";

function CardForm({ card, onDone }: { card: Card | null; onDone: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      name: String(f.get("name")), issuer: String(f.get("issuer")),
      last4: String(f.get("last4") ?? "") || null, aliases: String(f.get("aliases") ?? "") || null,
      color: String(f.get("color")), active: f.get("active") === "on",
    };
    setBusy(true); setError(null);
    const r = card ? await apiFetch(`/api/cards/${card.id}`, "PUT", body) : await apiFetch("/api/cards", "POST", body);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    onDone(); router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-3.5">
      <div><label className="label" htmlFor="c-name">Nombre</label><input id="c-name" name="name" required maxLength={60} defaultValue={card?.name} className="field" /></div>
      <div className="grid grid-cols-2 gap-3">
        <div><label className="label" htmlFor="c-issuer">Emisor</label>
          <select id="c-issuer" name="issuer" defaultValue={card?.issuer ?? "banamex"} className="field" onChange={(e) => { if (!card) { const c = e.currentTarget.form?.elements.namedItem("color") as HTMLInputElement | null; if (c) c.value = ISSUER_COLOR[e.currentTarget.value as keyof typeof ISSUER_COLOR] ?? c.value; } }}>{(["amex", "banamex", "nu", "other"] as const).map((i) => <option key={i} value={i}>{ISSUER_LABEL[i]}</option>)}</select></div>
        <div><label className="label" htmlFor="c-last4">Últimos 4</label><input id="c-last4" name="last4" pattern="\d{4}" inputMode="numeric" maxLength={4} defaultValue={card?.last4 ?? ""} className="field" /></div>
      </div>
      <div><label className="label" htmlFor="c-alias">Alias (separados por coma, como los manda Wallet)</label><input id="c-alias" name="aliases" maxLength={300} defaultValue={card?.aliases ?? ""} className="field" placeholder="Ej. Nu, Nu Bank, NuBank" /></div>
      <div className="grid grid-cols-2 items-end gap-3">
        <div><label className="label" htmlFor="c-color">Color</label><input id="c-color" name="color" type="color" defaultValue={card?.color ?? "#ff4d1c"} className="field !p-1" /></div>
        {card && <label className="flex h-[38px] items-center gap-2"><input type="checkbox" name="active" defaultChecked={card.active} /> Activa</label>}
        {!card && <input type="hidden" name="active" value="on" />}
      </div>
      {error && <p role="alert" className="text-down">{error}</p>}
      <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
    </form>
  );
}

export function CardsManager({ cards }: { cards: Card[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [editing, setEditing] = useState<Card | null>(null);
  const [open, setOpen] = useState(params.get("new") === "1");
  const [error, setError] = useState<string | null>(null);

  async function remove(c: Card) {
    if (!window.confirm(`¿Eliminar la tarjeta "${c.name}"? Si tiene movimientos solo se desactivará.`)) return;
    const r = await apiFetch(`/api/cards/${c.id}`, "DELETE");
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <>
      <div className="mb-3 flex justify-end"><button className="btn btn-primary" onClick={() => { setEditing(null); setOpen(true); }}><Plus size={14} /> Nueva tarjeta</button></div>
      {error && <p role="alert" className="mb-2 text-down">{error}</p>}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <li key={c.id} className={`glass p-4 ${c.active ? "" : "opacity-50"}`}>
            <div className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ background: c.color }} aria-hidden /><b className="truncate">{c.name}</b>{!c.active && <span className="text-[10px] text-faint">inactiva</span>}</div>
            <p className="mt-1 text-muted">{ISSUER_LABEL[c.issuer]}{c.last4 ? ` · •••• ${c.last4}` : ""}</p>
            {c.aliases && <p className="mt-1 truncate text-[11px] text-faint">Alias: {c.aliases}</p>}
            <div className="mt-3 flex gap-2">
              <button className="btn" onClick={() => { setEditing(c); setOpen(true); }}>Editar</button>
              <button className="btn btn-danger !w-9 !p-0" aria-label={`Eliminar ${c.name}`} onClick={() => remove(c)}><Trash2 size={13} /></button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "Editar tarjeta" : "Nueva tarjeta"}>
        <CardForm key={editing?.id ?? "new"} card={editing} onDone={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
