"use client";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { Dialog } from "../ui/Dialog";

export function DeleteDocumentButton({ id, statement }: { id: number; statement: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const r = await apiFetch(`/api/documents/${id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.push("/documentos");
    router.refresh();
  }

  return (
    <>
      <button className="btn btn-danger !h-10" onClick={() => setOpen(true)} data-testid="delete-document"><Trash2 size={14} aria-hidden /> Borrar</button>
      <Dialog open={open} onClose={() => setOpen(false)} title="¿Borrar este documento?">
        <div className="grid gap-3">
          <p className="text-muted">
            Se borra el registro del documento{statement ? " y sus conciliaciones (incluidas las diferencias que ya descartaste)" : ""}.
            <b className="text-fg"> No se borra ningún movimiento de tus gastos.</b>
          </p>
          {error && <p role="alert" className="text-down">{error}</p>}
          <div className="flex gap-2">
            <button className="btn !h-11 flex-1" onClick={() => setOpen(false)} disabled={busy}>Cancelar</button>
            <button className="btn btn-danger !h-11 flex-1" onClick={remove} disabled={busy} data-testid="confirm-delete">{busy ? "Borrando…" : "Borrar documento"}</button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
