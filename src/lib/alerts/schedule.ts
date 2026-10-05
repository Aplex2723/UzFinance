import { evaluateTransactionAlerts, maybeRunPeriodicAlerts } from "@/lib/repo/alerts";

export { flushAlertWork, scheduleAlertWork } from "./background";
import { scheduleAlertWork } from "./background";

/**
 * Hook de ingesta: evalúa la transacción y, a lo más cada 15 min, las alertas periódicas. `maybeRunPeriodicAlerts` termina SIEMPRE
 * mandando a Telegram los avisos que hayan quedado en la cola (todo tras la respuesta: nada de esto retrasa la ingesta).
 */
export function scheduleTransactionAlerts(txId: number): void {
  scheduleAlertWork(async () => {
    await evaluateTransactionAlerts(txId);
    await maybeRunPeriodicAlerts();
  });
}
