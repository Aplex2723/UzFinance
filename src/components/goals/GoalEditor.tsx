"use client";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { GOAL_KINDS, KIND_LABEL, PRIORITY_LABEL, type GoalPriority, type GoalRow } from "@/lib/goals";
import { Dialog } from "../ui/Dialog";

/** Crear o editar una meta de ahorro (con el botón para eliminarla al editar). */
export function GoalEditor({ goal, variant = "button" }: { goal?: GoalRow; variant?: "button" | "icon" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [monthOnly, setMonthOnly] = useState(goal?.monthOnly ?? false);

  function close() {
    setOpen(false);
    setError(null);
    setConfirmDelete(false);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(null);
    const r = await apiFetch(goal ? `/api/goals/${goal.id}` : "/api/goals", goal ? "PUT" : "POST", {
      name: String(f.get("name")).trim(),
      kind: String(f.get("kind")),
      priority: Number(f.get("priority")),
      target: String(f.get("target")).trim(),
      target_date: String(f.get("target_date")),
      month_only: monthOnly,
      saved: String(f.get("saved")).trim() || "0",
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    close();
    router.refresh();
  }

  async function remove() {
    if (!goal) return;
    setBusy(true); setError(null);
    const r = await apiFetch(`/api/goals/${goal.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    close();
    router.refresh();
  }

  return (
    <>
      {variant === "icon" ? (
        <button type="button" onClick={() => setOpen(true)} className="btn !h-8 !w-8 !p-0" aria-label={goal ? `Editar meta ${goal.name}` : "Nueva meta"} data-testid="edit-goal">
          <Pencil size={13} aria-hidden />
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`btn ${goal ? "" : "btn-primary"}`} data-testid={goal ? "edit-goal" : "new-goal"}>
          {goal ? <Pencil size={12} aria-hidden /> : <Plus size={13} aria-hidden />} {goal ? "Editar" : "Nueva meta"}
        </button>
      )}
      <Dialog open={open} onClose={close} title={goal ? "Editar meta" : "Nueva meta"}>
        <form onSubmit={submit} className="grid gap-3.5">
          <p className="text-muted">Pon cuánto quieres juntar y para cuándo; calculo cuánto apartar al mes y si te alcanza. Actualiza “Ahorrado hoy” cada vez que hagas un depósito.</p>
          <div>
            <label className="label" htmlFor="goal-name">Nombre</label>
            <input id="goal-name" name="name" required maxLength={80} defaultValue={goal?.name ?? ""} placeholder="Tesla, Pago de departamento…" className="field" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="goal-kind">Tipo</label>
              <select id="goal-kind" name="kind" defaultValue={goal?.kind ?? "otro"} className="field">
                {GOAL_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="goal-priority">Prioridad</label>
              <select id="goal-priority" name="priority" defaultValue={goal?.priority ?? 2} className="field">
                {([1, 2, 3] as GoalPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="goal-target">Cuánto cuesta (MXN)</label>
              <input id="goal-target" name="target" required inputMode="decimal" autoComplete="off" defaultValue={goal ? String(goal.targetCents / 100) : ""} placeholder="1600000" className="field" />
            </div>
            <div>
              <label className="label" htmlFor="goal-saved">Ahorrado hoy (MXN)</label>
              <input id="goal-saved" name="saved" inputMode="decimal" autoComplete="off" defaultValue={goal ? String(goal.savedCents / 100) : "0"} placeholder="0" className="field" />
            </div>
          </div>
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <label className="label !mb-0" htmlFor="goal-date">Para cuándo</label>
              <span className="inline-flex rounded-lg border border-line p-0.5 text-[11px]" role="group" aria-label="Precisión de la fecha">
                {[false, true].map((m) => (
                  <button key={String(m)} type="button" aria-pressed={monthOnly === m} onClick={() => setMonthOnly(m)} className={`rounded-md px-2 py-0.5 ${monthOnly === m ? "bg-white/15 text-fg" : "text-muted"}`}>
                    {m ? "Solo el mes" : "Fecha exacta"}
                  </button>
                ))}
              </span>
            </div>
            <input
              key={monthOnly ? "m" : "d"}
              id="goal-date" name="target_date" required type={monthOnly ? "month" : "date"} className="field"
              defaultValue={goal ? (monthOnly ? goal.targetDate.slice(0, 7) : goal.targetDate) : ""}
              placeholder={monthOnly ? "2027-04" : "2027-04-11"}
            />
            {monthOnly && <p className="mt-1 text-[11px] text-faint">Se toma el último día del mes.</p>}
          </div>
          {error && <p role="alert" className="text-down">{error}</p>}
          <button className="btn btn-primary !h-10" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
          {goal && (
            confirmDelete ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-down/30 bg-down/5 p-3">
                <p className="text-[12px]">¿Eliminar “{goal.name}”?</p>
                <span className="flex gap-2">
                  <button type="button" className="btn !h-8" onClick={() => setConfirmDelete(false)} disabled={busy}>No</button>
                  <button type="button" className="btn btn-danger !h-8" onClick={remove} disabled={busy} data-testid="confirm-delete-goal">Sí, eliminar</button>
                </span>
              </div>
            ) : (
              <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)} data-testid="delete-goal"><Trash2 size={13} aria-hidden /> Eliminar meta</button>
            )
          )}
        </form>
      </Dialog>
    </>
  );
}
