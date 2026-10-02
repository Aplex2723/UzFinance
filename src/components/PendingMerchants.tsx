"use client";
import { Tags } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatMXN } from "@/lib/money";
import type { PendingMerchant } from "@/lib/repo/transactions";
import type { Category } from "@/lib/types";

/**
 * Comercios que la IA no pudo categorizar con seguridad (p. ej. vendedores de Mercado Pago). Eliges la categoría una vez:
 * se aplica a todos sus movimientos y, desde entonces, a los que lleguen (queda en tu historial).
 */
export function PendingMerchants({ merchants, categories }: { merchants: PendingMerchant[]; categories: Category[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!merchants.length || !categories.length) return null;

  async function apply(m: PendingMerchant, categoryId: number) {
    setError(null);
    setBusy(m.merchant);
    const r = await apiFetch("/api/merchants/categorize", "POST", { merchant: m.merchant, category_id: categoryId });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <section aria-label="Comercios por categorizar" className="glass flex flex-col gap-3 border-l-2 border-l-[#60a5fa] p-4 sm:p-5" data-testid="pending-merchants">
      <h2 className="flex items-center gap-2 text-[12px] font-medium"><Tags size={14} aria-hidden /> Comercios por categorizar</h2>
      <p className="text-muted">No pude clasificarlos con seguridad. Elige la categoría una vez y se aplica a todos sus movimientos y a los futuros.</p>
      {error && <p role="alert" className="text-down">{error}</p>}
      <ul className="divide-y divide-line">
        {merchants.map((m) => (
          <li key={m.merchant} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2" data-testid="pending-merchant">
            <div className="min-w-0 flex-1 basis-[160px]">
              <p className="truncate font-medium">{m.sample}</p>
              <p className="text-[11px] text-muted">{m.count} movimiento{m.count === 1 ? "" : "s"} · {formatMXN(m.cents, { compact: true })}</p>
            </div>
            <select
              aria-label={`Categoría para ${m.sample}`}
              className="field !h-9 w-[190px] max-w-full"
              defaultValue=""
              disabled={busy === m.merchant}
              onChange={(e) => e.target.value && apply(m, Number(e.target.value))}
            >
              <option value="">Elegir categoría…</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
