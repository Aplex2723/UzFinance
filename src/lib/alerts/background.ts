import { after } from "next/server";

const pending = new Set<Promise<unknown>>();

function track(p: Promise<unknown>) {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}

/**
 * Corre trabajo de alertas sin retrasar ni romper la respuesta: con `after()` de Next cuando hay solicitud;
 * fuera de una (pruebas, scripts) como tarea suelta. Cualquier error se registra y se descarta.
 * (Vive aparte de `schedule.ts` para que el repositorio de alertas lo use sin importar de vuelta al repositorio.)
 */
export function scheduleAlertWork(fn: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await fn();
    } catch (e) {
      console.error("[alerts] trabajo en segundo plano falló:", (e as Error)?.message);
    }
  };
  try {
    after(run);
  } catch {
    track(run());
  }
}

/** Para pruebas: espera a que terminen las tareas sueltas. */
export async function flushAlertWork(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
