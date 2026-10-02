"use client";
import { Plus, Sparkles, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, emit, EVENTS } from "@/lib/client";

export function DashboardActions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function categorize() {
    setBusy(true);
    setMsg(null);
    const r = await apiFetch<{ updated: number; remaining: number }>("/api/transactions/categorize", "POST", {});
    setBusy(false);
    setMsg(r.ok ? `${r.data.updated} categorizadas · ${r.data.remaining} sin regla` : r.error);
    if (r.ok) router.refresh();
  }

  return (
    <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-0.5 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&>*]:shrink-0">
      <button className="btn btn-primary" onClick={() => emit(EVENTS.addExpense)}><Plus size={14} aria-hidden /> Agregar gasto</button>
      <button className="btn" onClick={() => emit(EVENTS.importCsv)}><Upload size={13} aria-hidden /> Importar CSV</button>
      <button className="btn" onClick={categorize} disabled={busy}><Sparkles size={13} aria-hidden /> {busy ? "Categorizando…" : "Categorizar"}</button>
      {msg && <span role="status" className="text-[11px] text-muted">{msg}</span>}
    </div>
  );
}
