"use client";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useOptimistic, useTransition, type ReactNode } from "react";
import { CLEARED, serializeTxParams, todayLocal, type TxView } from "@/lib/tx-filters";

type Ctx = {
  /** Estado de los filtros: el de la URL, y mientras carga, el que la persona acaba de elegir (respuesta inmediata). */
  view: TxView;
  /** Hoy (CDMX) según el servidor: se usa para resaltar el atajo activo sin diferencias de hidratación. */
  today: string;
  /** Hay una navegación de filtros en curso (la lista y las tarjetitas se atenúan). */
  pending: boolean;
  /** Cambia filtros: actualiza la URL con router.replace (sin recargar, sin saltar al inicio) y vuelve a la página 1. */
  update: (patch: Partial<TxView>) => void;
  clear: () => void;
};

const FiltersCtx = createContext<Ctx | null>(null);

export function useTxFilters(): Ctx {
  const c = useContext(FiltersCtx);
  if (!c) throw new Error("useTxFilters fuera de <TxFiltersProvider>");
  return c;
}

/**
 * La URL es la fuente de verdad: la página (servidor) interpreta los parámetros y pasa `view`; aquí solo se escribe la URL.
 * No usa useSearchParams (el estado ya viene resuelto del servidor), así que no necesita Suspense.
 */
export function TxFiltersProvider({ view: serverView, today, children }: { view: TxView; today: string; children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [view, setOptimistic] = useOptimistic(serverView);

  const update = useCallback((patch: Partial<TxView>) => {
    const next: TxView = { ...view, ...patch, page: patch.page ?? 1 };
    const qs = serializeTxParams(next, todayLocal()).toString();
    startTransition(() => {
      setOptimistic(next);
      router.replace(qs ? `/transacciones?${qs}` : "/transacciones", { scroll: false });
    });
  }, [view, router, setOptimistic]);

  const clear = useCallback(() => update(CLEARED), [update]);
  const value = useMemo<Ctx>(() => ({ view, today, pending, update, clear }), [view, today, pending, update, clear]);
  return <FiltersCtx.Provider value={value}>{children}</FiltersCtx.Provider>;
}

/** Atenúa lo que contiene mientras se cargan los filtros nuevos (sin quitarlo: evita saltos y parpadeos). */
export function PendingDim({ children, className = "" }: { children: ReactNode; className?: string }) {
  const { pending } = useTxFilters();
  return <div aria-busy={pending} data-pending={pending ? "1" : undefined} className={`transition-opacity duration-150 ${pending ? "opacity-60" : ""} ${className}`}>{children}</div>;
}
