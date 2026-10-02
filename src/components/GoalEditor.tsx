"use client";
import { Pencil, Target } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { Goal } from "@/lib/goals";
import { Dialog } from "./ui/Dialog";

/** Meta de ahorro: nombre, cuánto juntar, para cuándo y cuánto llevas hoy. */
export function GoalEditor({ goal, variant = "link" }: { goal: Goal | null; variant?: "link" | "button" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    const r = await apiFetch("/api/settings/goal", "PUT", {
      name: String(f.get("name")).trim(),
      target: String(f.get("target")).trim(),
      target_date: String(f.get("target_date")),
      saved: String(f.get("saved")).trim(),
    });
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
        data-testid="edit-goal"
      >
        {goal ? <Pencil size={11} aria-hidden /> : <Target size={12} aria-hidden />} {goal ? (variant === "button" ? "Editar meta" : "Actualizar") : "Crear meta de ahorro"}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Meta de ahorro">
        <form onSubmit={submit} className="grid gap-3.5">
          <p className="text-muted">Pon cuánto quieres juntar y para cuándo; calculo cuánto debes apartar cada mes. Actualiza “Ahorrado hoy” cada vez que hagas un depósito.</p>
          <div>
            <label className="label" htmlFor="goal-name">Nombre</label>
            <input id="goal-name" name="name" required maxLength={80} defaultValue={goal?.name ?? ""} placeholder="Pago de departamento" className="field" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="goal-target">Meta (MXN)</label>
              <input id="goal-target" name="target" required inputMode="decimal" autoComplete="off" defaultValue={goal ? String(goal.targetCents / 100) : ""} placeholder="1600000" className="field" />
            </div>
            <div>
              <label className="label" htmlFor="goal-date">Fecha límite</label>
              <input id="goal-date" name="target_date" type="date" required defaultValue={goal?.targetDate ?? ""} className="field" />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="goal-saved">Ahorrado hoy (MXN)</label>
            <input id="goal-saved" name="saved" required inputMode="decimal" autoComplete="off" defaultValue={goal ? String(goal.savedCents / 100) : "0"} placeholder="308500" className="field" />
          </div>
          {error && <p role="alert" className="text-down">{error}</p>}
          <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
        </form>
      </Dialog>
    </>
  );
}
