import { Car, GraduationCap, Home, Plane, ShieldCheck, Target, type LucideIcon } from "lucide-react";
import type { GoalKind, GoalStatus } from "@/lib/goals";

export const KIND_ICON: Record<GoalKind, LucideIcon> = { casa: Home, auto: Car, viaje: Plane, emergencia: ShieldCheck, educacion: GraduationCap, otro: Target };

export const STATUS_UI: Record<GoalStatus, { label: string; cls: string }> = {
  done: { label: "Lograda", cls: "text-up bg-up/10" },
  on_track: { label: "A tiempo", cls: "text-up bg-up/10" },
  tight: { label: "A tiempo, justa", cls: "text-[#60a5fa] bg-[#60a5fa]/10" },
  late: { label: "Se retrasa", cls: "text-[#f59e0b] bg-[#f59e0b]/10" },
  unreachable: { label: "No alcanza", cls: "text-down bg-down/10" },
  overdue: { label: "Vencida", cls: "text-down bg-down/10" },
  no_data: { label: "Sin datos", cls: "text-muted bg-white/5" },
};

export function StatusChip({ status }: { status: GoalStatus }) {
  const s = STATUS_UI[status];
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${s.cls}`} data-testid="goal-status">{s.label}</span>;
}

/** Barra de avance de una meta. */
export function GoalBar({ pct, status }: { pct: number; status: GoalStatus }) {
  const color = status === "done" || status === "on_track" ? "bg-up" : status === "tight" ? "bg-[#60a5fa]" : status === "late" ? "bg-[#f59e0b]" : status === "unreachable" || status === "overdue" ? "bg-down" : "bg-accent";
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.07]" role="img" aria-label={`Llevas ${pct.toFixed(0)} por ciento`}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(Math.max(pct, pct > 0 ? 1.5 : 0), 100)}%` }} />
    </div>
  );
}
