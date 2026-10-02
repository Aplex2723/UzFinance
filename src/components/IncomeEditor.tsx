"use client";
import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatMXN } from "@/lib/money";
import { Dialog } from "./ui/Dialog";

/** Ingreso mensual: se edita aquí y alimenta todos los porcentajes y proyecciones. */
export function IncomeEditor({ cents, variant = "link" }: { cents: number; variant?: "link" | "button" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const amount = String(new FormData(e.currentTarget).get("amount")).trim();
    setBusy(true); setError(null);
    const r = await apiFetch("/api/settings/income", "PUT", { amount });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={variant === "button" ? "btn" : "inline-flex items-center gap-1 text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"}
        data-testid="edit-income"
      >
        <Pencil size={11} aria-hidden /> {variant === "button" ? "Editar ingreso" : "Editar"}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Ingreso mensual">
        <form onSubmit={submit} className="grid gap-3.5">
          <p className="text-muted">Lo que percibes al mes (neto). Se usa para calcular qué porcentaje gastas, tu ahorro y la proyección del mes. Ahora: <b className="num text-fg">{formatMXN(cents)}</b>.</p>
          <div>
            <label className="label" htmlFor="income-amount">Monto mensual (MXN)</label>
            <input id="income-amount" name="amount" required inputMode="decimal" autoComplete="off" defaultValue={cents > 0 ? String(cents / 100) : ""} placeholder="350000" className="field" />
          </div>
          {error && <p role="alert" className="text-down">{error}</p>}
          <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
        </form>
      </Dialog>
    </>
  );
}
