import { ArrowDownRight, ArrowUpRight } from "lucide-react";

/**
 * Para GASTO, que suba es malo (rojo) y que baje es bueno (verde).
 * `invert` permite lo contrario si algún día se muestran ingresos.
 */
export function Delta({ pct, invert = false, label }: { pct: number | null; invert?: boolean; label?: string }) {
  if (pct === null) return <span className="text-[11px] text-faint">{label ?? "sin base"}</span>;
  const up = pct >= 0;
  const good = invert ? up : !up;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${good ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}
      aria-label={`${up ? "Subió" : "Bajó"} ${Math.abs(pct).toFixed(0)} por ciento`}
    >
      <Icon size={12} aria-hidden />
      {Math.abs(pct).toFixed(0)}%
    </span>
  );
}
