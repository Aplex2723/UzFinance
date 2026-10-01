"use client";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** <dialog> nativo: foco atrapado, Esc para cerrar y rol correcto sin dependencias. */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label={title} className="w-full sm:w-[460px]">
      {open && (
        <div className="glass m-3 p-5 sm:m-0">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="num text-lg font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="btn !h-8 !w-8 !p-0" aria-label="Cerrar">
              <X size={14} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
