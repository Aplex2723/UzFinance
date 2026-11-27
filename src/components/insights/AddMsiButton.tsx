"use client";
import { Plus } from "lucide-react";
import { emit, EVENTS } from "@/lib/client";

/** Abre el diálogo de gasto con "a meses sin intereses" ya elegido (si la compra ya llegó por el Atajo o el correo, el diálogo ofrece pasar ESA a meses). */
export function AddMsiButton({ className = "btn !h-7 !px-2.5 text-[11px]", label = "Agregar" }: { className?: string; label?: string }) {
  return (
    <button type="button" className={className} onClick={() => emit(EVENTS.addExpense, { msi: true })} data-testid="add-msi">
      <Plus size={12} aria-hidden /> {label}
    </button>
  );
}
