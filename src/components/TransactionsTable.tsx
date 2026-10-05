"use client";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { sourcesLabel } from "@/lib/chat-sources";
import { apiFetch, emit, EVENTS } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { Transaction } from "@/lib/types";

export function TransactionsTable({ rows }: { rows: Transaction[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function remove(tx: Transaction) {
    if (!window.confirm(`¿Eliminar "${tx.merchant_raw}" por ${formatMXN(Math.abs(tx.amount_cents))}?`)) return;
    const r = await apiFetch(`/api/transactions/${tx.id}`, "DELETE");
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  if (!rows.length) return <p className="py-10 text-center text-muted">Sin resultados.</p>;
  return (
    <div>
      {error && <p role="alert" className="mb-2 text-down">{error}</p>}
      <ul className="divide-y divide-line" aria-label="Transacciones">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 sm:flex-nowrap" data-testid="tx-row">
            <div className="w-[88px] shrink-0 text-[11px] text-muted">
              <p>{formatDay(r.occurred_at)}</p>
              <p>{formatTime(r.occurred_at)}</p>
            </div>
            <div className="min-w-0 flex-1 basis-[180px]">
              <p className="truncate font-medium">{r.merchant_raw}</p>
              <p className="truncate text-[11px] text-muted">{r.account_ref ? `Domiciliación ···${r.account_ref}` : r.card_name} · {sourcesLabel(r.sources)}{r.notes ? ` · ${r.notes}` : ""}</p>
              {(r.unconfirmed || r.is_recurring || r.plan_id !== null || r.category_source === "jev") && (
                <p className="mt-0.5 flex flex-wrap gap-1.5 text-[10px]">
                  {r.plan_id !== null && <span className="rounded-full border border-accent/50 px-2 py-0.5 text-accent-2" data-testid="msi-badge">A meses (MSI)</span>}
                  {r.category_source === "jev" && <span className="rounded-full border border-[#60a5fa]/40 px-2 py-0.5 text-[#60a5fa]" title="Categoría sugerida por IA (Jev). Si no es la correcta, edítala: la próxima vez se respeta." data-testid="ai-badge">IA{r.category_confidence !== null ? ` ${Math.round(r.category_confidence * 100)}%` : ""}</span>}
                  {r.unconfirmed && <span className="rounded-full border border-[#f59e0b]/50 px-2 py-0.5 text-[#f59e0b]" data-testid="unconfirmed">Sin confirmación bancaria</span>}
                  {r.is_recurring && <span className="rounded-full border border-line px-2 py-0.5 text-muted">Recurrente</span>}
                </p>
              )}
            </div>
            <p className="hidden w-[130px] shrink-0 sm:block">
              {r.category_name ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px]"><span className="h-1.5 w-1.5 rounded-full" style={{ background: r.category_color ?? "#999" }} />{r.category_name}</span>
              ) : <span className="text-[11px] text-faint">Sin categoría</span>}
            </p>
            <p className={`num w-[110px] shrink-0 text-right font-medium ${r.amount_cents < 0 ? "text-up" : ""}`}>{r.amount_cents < 0 ? "+" : ""}{formatMXN(-r.amount_cents).replace("-", "")}</p>
            <div className="flex shrink-0 gap-1">
              <button className="btn !h-8 !w-8 !p-0" aria-label={`Editar ${r.merchant_raw}`} onClick={() => emit(EVENTS.editTransaction, r)}><Pencil size={13} /></button>
              <button className="btn btn-danger !h-8 !w-8 !p-0" aria-label={`Eliminar ${r.merchant_raw}`} onClick={() => remove(r)}><Trash2 size={13} /></button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
