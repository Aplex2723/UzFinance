import { docSchema, type StatementDoc } from "@/lib/import/statements";
import { detectStatement, extractStatement } from "@/lib/pdf/statements";
import type { PdfText } from "@/lib/pdf/text";
import { createAlert, statementDiffCandidate, type AlertSeverity } from "@/lib/repo/alerts";
import { getExtracted, patchDocument, type DocStatus } from "@/lib/repo/documents";
import { listCards } from "@/lib/repo/cards";
import { getStatementCardMap, listRuns, reconcileDocument, setStatementCardMap, unmappedCardKeys } from "@/lib/repo/recon";
import { suggestCardMap } from "./card-suggest";

/**
 * Estado de cuenta → conciliación. La extracción es DETERMINISTA (nada de OCR ni de LLM en cifras): si el PDF no trae texto
 * o no es de un banco conocido, se dice así y no se intenta adivinar. Los `checks` del extractor (sumas y conteos contra los
 * totales impresos en el propio estado) son la defensa contra una lectura errónea: uno fallido deja el documento en revisión.
 */
export type StatementAnalysis =
  | { kind: "ok"; docs: StatementDoc[]; title: string; periodStart: string; periodEnd: string }
  | { kind: "unknown"; reason: string };

export function analyzeStatement(pdf: PdfText): StatementAnalysis {
  const d = detectStatement(pdf);
  if (d.kind === null) return { kind: "unknown", reason: d.reason };
  let docs: StatementDoc[];
  try {
    docs = extractStatement(pdf, d.kind);
  } catch (e) {
    return { kind: "unknown", reason: `No se pudo extraer el estado: ${(e as Error).message}` };
  }
  if (!docs.length) return { kind: "unknown", reason: "El estado no trae movimientos legibles." };
  const starts = docs.map((x) => x.period.start).sort();
  const ends = docs.map((x) => x.period.end).sort();
  const labels = [...new Set(docs.map((x) => x.card_key))].join(", ");
  return { kind: "ok", docs, title: `Estado de cuenta · ${labels} · ${starts[0]} a ${ends.at(-1)}`, periodStart: starts[0], periodEnd: ends.at(-1)! };
}

export type StatementOutcome = { status: DocStatus; detail: string; needsMapping?: string[]; openFindings?: number; highFindings?: number };

const rank: Record<AlertSeverity, number> = { info: 0, warn: 1, high: 2 };

/** Concilia (o vuelve a conciliar, p. ej. tras indicar el mapa de tarjetas) el estado guardado en el documento. */
export async function reconcileStatements(documentId: number): Promise<StatementOutcome> {
  const stored = await getExtracted<{ statements?: unknown[] }>(documentId);
  const parsed = (stored?.statements ?? []).map((s) => docSchema.safeParse(s));
  if (!parsed.length || parsed.some((p) => !p.success)) {
    const o: StatementOutcome = { status: "failed", detail: "Los datos extraídos del estado están dañados: vuelve a subir el PDF." };
    await patchDocument(documentId, { status: o.status, detail: o.detail });
    return o;
  }
  const docs = parsed.map((p) => (p as { data: StatementDoc }).data);

  let map = await getStatementCardMap();
  let auto: string[] = [];
  if (docs.some((d) => unmappedCardKeys(d, map).length)) {
    // Lo que es inequívoco (única tarjeta del emisor/producto) se asigna solo y queda guardado; lo ambiguo lo decide el usuario.
    const suggested = suggestCardMap(docs, await listCards(false), map);
    auto = Object.keys(suggested);
    if (auto.length) {
      map = { ...(map ?? {}), ...suggested };
      await setStatementCardMap(map);
    }
  }
  const needsMapping = [...new Set(docs.flatMap((d) => unmappedCardKeys(d, map)))];
  if (needsMapping.length || !map) {
    const keys = needsMapping.length ? needsMapping : [...new Set(docs.map((d) => d.card_key))];
    const o: StatementOutcome = { status: "needs_review", detail: `Falta indicar a qué tarjeta de la app corresponde: ${keys.join(", ")}.`, needsMapping: keys };
    await patchDocument(documentId, { status: o.status, detail: o.detail });
    return o;
  }

  const badChecks = docs.flatMap((d) => d.checks.filter((c) => !c.ok).map((c) => `${d.card_key}: ${c.name}`));
  let open = 0;
  let high = 0;
  try {
    for (const d of docs) {
      const r = await reconcileDocument(documentId, d, map);
      open += r.openFindings;
      high += r.highFindings;
    }
  } catch (e) {
    // Típico: el mapa apunta a una tarjeta que ya no existe. No se escribió nada a medias que haya que deshacer a mano.
    const o: StatementOutcome = { status: "needs_review", detail: `No pude conciliar: ${(e as Error).message}` };
    await patchDocument(documentId, { status: o.status, detail: o.detail });
    return o;
  }

  await alertOnFindings(documentId);

  let status: DocStatus = "processed";
  let detail = open === 0 ? "Conciliado: todo cuadra con lo registrado." : `Conciliado: ${open} diferencia(s) por revisar${high ? ` (${high} grave${high === 1 ? "" : "s"})` : ""}.`;
  if (auto.length) detail += ` Asigné automáticamente la tarjeta de: ${auto.join(", ")} (puedes cambiarlo en Documentos).`;
  if (badChecks.length) {
    status = "needs_review";
    detail = `Los totales extraídos del PDF no cuadran (${badChecks.slice(0, 3).join("; ")}): no importes nada de este estado sin revisarlo. ${detail}`;
  }
  await patchDocument(documentId, { status, detail });
  return { status, detail, openFindings: open, highFindings: high };
}

/** Una alerta por tarjeta con diferencias graves o de aviso. Nunca rompe la ingesta del documento. */
async function alertOnFindings(documentId: number): Promise<void> {
  try {
    for (const run of await listRuns(documentId)) {
      if (run.high + run.warn === 0) continue;
      const open = run.findingList.filter((f) => f.status === "open");
      const c = statementDiffCandidate({
        documentId, label: run.label, statementCents: run.statementCents, appCents: run.appCents,
        missingInApp: open.filter((f) => f.kind === "missing_in_app").length, notInStatement: open.filter((f) => f.kind === "not_in_statement").length,
      });
      // Hay hallazgos graves (duplicados, extracción dudosa…) aunque el monto total sea pequeño: la severidad no baja de ahí.
      const floor: AlertSeverity = run.high > 0 ? "high" : "warn";
      await createAlert({ ...c, severity: rank[c.severity] >= rank[floor] ? c.severity : floor });
    }
  } catch (e) {
    console.error("[docs] alerta de estado de cuenta falló:", (e as Error).message);
  }
}
