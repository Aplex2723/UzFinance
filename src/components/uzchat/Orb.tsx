import type { CSSProperties } from "react";

/** Orbe de UzChat (estilo Siri). El tamaño sale de `size` en px; `busy` acelera el flujo de color mientras el agente piensa. */
export function Orb({ size = 56, busy = false }: { size?: number; busy?: boolean }) {
  return (
    <span className="uz-orb" data-busy={busy} style={{ "--s": `${size}px` } as CSSProperties} aria-hidden>
      <span className="uz-orb-core"><i /><i /><i /><i /></span>
      <span className="uz-orb-shine" />
    </span>
  );
}
