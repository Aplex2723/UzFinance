import type { ReactNode } from "react";

/** Cifra clave: etiqueta pequeña, valor grande y una línea de contexto. */
export function KpiTile({ label, value, sub, tone = "default", testId }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "default" | "good" | "bad"; testId?: string }) {
  return (
    <div className="glass flex min-w-0 flex-col gap-1.5 p-3.5 sm:p-4">
      <p className="truncate text-[11px] text-muted">{label}</p>
      <p className={`num truncate text-[22px] font-semibold leading-none sm:text-2xl ${tone === "good" ? "text-up" : tone === "bad" ? "text-down" : ""}`} data-testid={testId}>{value}</p>
      {sub && <div className="min-h-[16px] text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
