import { Check } from "lucide-react";
import type { ReactNode } from "react";

/** Botón de opción (filtro): `aria-pressed`, objetivo táctil de 40 px en celular y la selección no depende solo del color. */
export function Chip({ active, onClick, children, title, testId, className = "" }: { active: boolean; onClick: () => void; children: ReactNode; title?: string; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      title={title}
      data-testid={testId}
      className={`inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3.5 text-[12px] font-medium transition-colors sm:h-9 ${
        active ? "border-accent/70 bg-accent/15 text-fg" : "border-line bg-surface-2 text-muted hover:bg-white/10 hover:text-fg"
      } ${className}`}
    >
      {active && <Check size={13} aria-hidden className="text-accent-2" />}
      {children}
    </button>
  );
}

/** Fila de chips: en celular se desplaza en horizontal (sin desbordar la página); en escritorio se acomoda en varias líneas. */
export function ChipRow({ label, children, testId, className = "" }: { label: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <div role="group" aria-label={label} data-testid={testId} className={`-my-1 flex items-center gap-2 overflow-x-auto py-1 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible [&::-webkit-scrollbar]:hidden ${className}`}>
      {children}
    </div>
  );
}
