import { scheduleTransactionAlerts } from "@/lib/alerts/schedule";
import { createAlert, transferRegisteredCandidate } from "@/lib/repo/alerts";
import { localDate } from "@/lib/time";
import type { StoredTransfer } from "./transfer-flow";

/** Avisos de la ingesta de documentos. Son "lo mejor posible": un fallo aquí nunca debe tumbar el registro del documento. */
export async function notifyTransferRegistered(txId: number, t: StoredTransfer): Promise<void> {
  try {
    await createAlert(
      transferRegisteredCandidate({ txId, amountCents: t.amountCents, counterparty: t.destAlias ?? t.destName, date: localDate(new Date(t.occurredAt)), trackingKey: t.trackingKey }),
    );
    // La transferencia también pasa por las reglas de gasto (compra fuerte, pico del día…), como cualquier otro movimiento.
    scheduleTransactionAlerts(txId);
  } catch (e) {
    console.error("[docs] alerta de transferencia falló:", (e as Error).message);
  }
}

export async function notifyDocumentReview(documentId: number, title: string | null, detail: string | null): Promise<void> {
  try {
    await createAlert({
      rule: "document_review",
      severity: "info",
      title: "Un documento necesita tu revisión",
      body: `${title ?? "Documento"}: ${detail ?? "revísalo en Documentos."}`.slice(0, 480),
      dedupeKey: `doc-review:${documentId}`,
      documentId,
    });
  } catch (e) {
    console.error("[docs] alerta de revisión falló:", (e as Error).message);
  }
}
