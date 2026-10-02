import Link from "next/link";
import { Panel } from "@/components/ui/Panel";
import { monthLabel } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { MsiSummary } from "@/lib/msi";

/** Resumen corto de MSI para el inicio; el detalle está en /msi. No aparece si no hay planes vigentes. */
export function MsiPanel({ s }: { s: MsiSummary }) {
  if (s.active.length === 0) return null;
  const next = s.nextEnding;
  return (
    <Panel title="Meses sin intereses" action={<Link href="/msi" className="btn !h-7 !px-2.5 text-[11px]">Ver detalle</Link>} className="" >
      <div className="grid grid-cols-3 gap-3" data-testid="msi-summary">
        <div><p className="text-[11px] text-muted">Se cobra este mes</p><p className="num mt-1 text-xl font-semibold">{formatMXN(s.loadNow, { compact: true })}</p>{s.loadPct !== null && <p className="text-[11px] text-muted">{s.loadPct.toFixed(0)}% del ingreso</p>}</div>
        <div><p className="text-[11px] text-muted">Debes en total</p><p className="num mt-1 text-xl font-semibold">{formatMXN(s.remainingTotal, { compact: true })}</p><p className="text-[11px] text-muted">{s.active.length} plan{s.active.length === 1 ? "" : "es"}</p></div>
        <div><p className="text-[11px] text-muted">Termina el primero</p><p className="num mt-1 text-xl font-semibold">{next ? monthLabel(next.endMonth, true) : "—"}</p>{next && <p className="truncate text-[11px] text-muted">{next.merchant}</p>}</div>
      </div>
    </Panel>
  );
}
