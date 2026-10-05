import { docSchema, type CardMap } from "@/lib/import/statements";
import { getDocument, getExtracted, type DocRow } from "@/lib/repo/documents";
import { listCards } from "@/lib/repo/cards";
import { getStatementCardMap, listRuns, unmappedCardKeys, type ReconRunDetail } from "@/lib/repo/recon";
import { resolveOriginCard } from "@/lib/repo/transfers";
import { getTransactionBriefs, type TxBrief } from "@/lib/repo/tx-lookup";
import type { Card } from "@/lib/types";
import type { TransferExtract } from "./transfer-flow";

/**
 * Todo lo que la pantalla de un documento necesita (solo lectura). Lo comparten la página y GET /api/documents/[id].
 * La huella (sha256) es interna y nunca sale.
 */
export type StatementKey = { card_key: string; documents: string[]; holders: string[]; sections: string[]; domiciliation: boolean };

export type DocumentDetail = {
  document: Omit<DocRow, "sha256">;
  /** Comprobante: lo leído, los desacuerdos del OCR y la tarjeta candidata (si la hay). */
  transfer: (TransferExtract & { candidate: { cardId: number; cardName: string; how: string } | null }) | null;
  /** Estado de cuenta: corridas con hallazgos, mapa actual y qué falta por mapear. */
  statement: {
    runs: ReconRunDetail[];
    keys: StatementKey[];
    needsMapping: string[];
    map: CardMap | null;
    /** Movimientos a los que se refieren los hallazgos (por id). */
    transactions: Record<number, TxBrief>;
    /** Revisiones del PDF que no cuadraron: la extracción no es confiable. */
    failedChecks: string[];
  } | null;
  cards: Card[];
};

const ids = (runs: ReconRunDetail[]): number[] =>
  runs.flatMap((r) => r.findingList.flatMap((f) => [f.txId, f.otherTxId, typeof f.detail?.appId === "number" ? (f.detail.appId as number) : null])).filter((n): n is number => typeof n === "number");

export async function getDocumentDetail(id: number): Promise<DocumentDetail | null> {
  const doc = await getDocument(id);
  if (!doc) return null;
  const { sha256: _omit, ...document } = doc;
  void _omit;
  const cards = await listCards(true);
  let transfer: DocumentDetail["transfer"] = null;
  let statement: DocumentDetail["statement"] = null;

  if (doc.kind === "transfer_receipt") {
    const ex = await getExtracted<TransferExtract>(id);
    if (ex?.transfer) {
      const origin = await resolveOriginCard(ex.transfer).catch(() => null);
      transfer = {
        transfer: ex.transfer, read: ex.read, conflicts: Array.isArray(ex.conflicts) ? ex.conflicts : [], reason: ex.reason ?? null,
        candidate: origin ? { cardId: origin.card.id, cardName: origin.card.name, how: origin.how } : null,
      };
    }
  } else if (doc.kind === "statement") {
    const ex = await getExtracted<{ statements?: unknown[] }>(id);
    const parsed = (ex?.statements ?? []).map((s) => docSchema.safeParse(s)).flatMap((p) => (p.success ? [p.data] : []));
    const map = await getStatementCardMap();
    const byKey = new Map<string, { documents: Set<string>; holders: Set<string>; sections: Set<string>; domiciliation: boolean }>();
    for (const d of parsed) {
      const k = byKey.get(d.card_key) ?? { documents: new Set(), holders: new Set(), sections: new Set(), domiciliation: false };
      k.documents.add(d.document);
      for (const x of d.transactions) {
        if (x.holder) k.holders.add(x.holder);
        if (x.section) k.sections.add(x.section);
        if (x.type === "domiciliation_other" || x.type === "domiciliation_card_payment") k.domiciliation = true;
      }
      for (const p of d.plans) if (p.holder) k.holders.add(p.holder);
      byKey.set(d.card_key, k);
    }
    const runs = await listRuns(id);
    statement = {
      runs,
      keys: [...byKey].map(([card_key, k]) => ({ card_key, documents: [...k.documents], holders: [...k.holders].sort(), sections: [...k.sections].sort(), domiciliation: k.domiciliation })),
      needsMapping: [...new Set(parsed.flatMap((d) => unmappedCardKeys(d, map)))],
      map,
      transactions: Object.fromEntries((await getTransactionBriefs(ids(runs))).map((b) => [b.id, b])),
      failedChecks: parsed.flatMap((d) => d.checks.filter((c) => !c.ok).map((c) => `${d.card_key}: ${c.name}`)),
    };
  }
  return { document, transfer, statement, cards };
}
