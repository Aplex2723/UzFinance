"use client";
import { FileText, Receipt, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { originLabel } from "@/lib/chat-sources";
import { apiFetch } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import type { DocRow } from "@/lib/repo/documents";
import { Dialog } from "../ui/Dialog";
import { Empty } from "../ui/Panel";
import { KIND_LABEL, StatusChip } from "./shared";

export type DocListItem = Omit<DocRow, "sha256">;

const period = (d: DocListItem) => (d.period_start && d.period_end ? `${d.period_start} a ${d.period_end}` : null);

export function DocumentList({ documents }: { documents: DocListItem[] }) {
  const router = useRouter();
  const [target, setTarget] = useState<DocListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!target) return;
    setBusy(true);
    setError(null);
    const r = await apiFetch(`/api/documents/${target.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setTarget(null);
    router.refresh();
  }

  if (!documents.length) return <Empty>Aún no has subido ningún PDF.</Empty>;
  return (
    <>
      <ul className="divide-y divide-line" aria-label="Documentos recientes">
        {documents.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" data-testid="doc-row">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-2 text-muted" aria-hidden>
              {d.kind === "statement" ? <FileText size={16} /> : <Receipt size={16} />}
            </span>
            <div className="min-w-0 flex-1 basis-[200px]">
              <Link href={`/documentos/${d.id}`} className="block truncate font-medium hover:underline" data-testid="doc-title">{d.title ?? KIND_LABEL[d.kind]}</Link>
              <p className="truncate text-[11px] text-muted">
                {KIND_LABEL[d.kind]}{period(d) ? ` · ${period(d)}` : ""} · {formatDay(d.created_at)} {formatTime(d.created_at)}
                {originLabel(d.origin) ? ` · ${originLabel(d.origin)}` : ""}
              </p>
              {d.detail && d.status !== "processed" && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{d.detail}</p>}
            </div>
            <StatusChip status={d.status} />
            <div className="flex items-center gap-2">
              <Link href={`/documentos/${d.id}`} className={`btn !h-10 ${d.status === "needs_review" ? "btn-primary" : ""}`}>{d.status === "needs_review" ? "Revisar" : "Abrir"}</Link>
              <button className="btn btn-danger !h-10 !w-10 !p-0" aria-label={`Borrar ${d.title ?? KIND_LABEL[d.kind]}`} onClick={() => { setError(null); setTarget(d); }}>
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={target !== null} onClose={() => setTarget(null)} title="¿Borrar este documento?">
        <div className="grid gap-3">
          <p className="text-muted">
            Se borra el registro del documento
            {target?.kind === "statement" ? " y sus conciliaciones (incluidas las diferencias que ya descartaste)" : ""}.
            <b className="text-fg"> No se borra ningún movimiento de tus gastos.</b>
            {target?.status !== "processed" ? " Si lo vuelves a subir, se procesará de nuevo." : ""}
          </p>
          {error && <p role="alert" className="text-down">{error}</p>}
          <div className="flex gap-2">
            <button className="btn !h-11 flex-1" onClick={() => setTarget(null)} disabled={busy}>Cancelar</button>
            <button className="btn btn-danger !h-11 flex-1" onClick={remove} disabled={busy} data-testid="confirm-delete">{busy ? "Borrando…" : "Borrar documento"}</button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
