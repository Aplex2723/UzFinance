"use client";
import { AlertTriangle, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import type { UnparsedEmail } from "@/lib/repo/emails";
import type { Card } from "@/lib/types";

/** Lo que necesita tu atención: tarjetas creadas por correo sin nombre y correos que no se entendieron. */
export function ReviewPanel({ unnamed, unparsed }: { unnamed: Card[]; unparsed: UnparsedEmail[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  if (!unnamed.length && !unparsed.length) return null;

  async function dismiss(id: string) {
    const r = await apiFetch(`/api/unparsed/${encodeURIComponent(id)}`, "DELETE");
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  return (
    <section aria-label="Pendiente de revisión" className="glass flex flex-col gap-3 border-l-2 border-l-[#f59e0b] p-4 sm:p-5" data-testid="review-panel">
      <h2 className="flex items-center gap-2 text-[12px] font-medium"><AlertTriangle size={14} aria-hidden /> Pendiente de revisión</h2>
      {error && <p role="alert" className="text-down">{error}</p>}
      {unnamed.length > 0 && (
        <div>
          <p className="text-muted">Llegaron cargos de tarjetas que aún no nombras. Ponles nombre (Explora, adicional, débito…) y alias de Wallet:</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {unnamed.map((c) => (
              <li key={c.id}><Link href="/tarjetas" className="btn !h-8 text-[12px]" data-testid="unnamed-card">{c.name}</Link></li>
            ))}
          </ul>
        </div>
      )}
      {unparsed.length > 0 && (
        <div>
          <p className="text-muted">Correos de Banamex que no se pudieron interpretar (captúralos a mano y descártalos):</p>
          <ul className="mt-2 divide-y divide-line" aria-label="Correos sin interpretar">
            {unparsed.map((u) => (
              <li key={u.message_id} className="flex items-center gap-3 py-2" data-testid="unparsed-row">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{u.subject}</p>
                  <p className="truncate text-[11px] text-muted">{formatDay(u.received_at)} {formatTime(u.received_at)} · {u.reason}</p>
                </div>
                <button className="btn !h-8 !w-8 !p-0" aria-label={`Descartar ${u.subject}`} onClick={() => dismiss(u.message_id)}><X size={14} /></button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
