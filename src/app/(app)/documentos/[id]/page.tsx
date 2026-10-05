import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DeleteDocumentButton } from "@/components/documents/DeleteDocumentButton";
import { KIND_LABEL, StatusChip } from "@/components/documents/shared";
import { MappingEditor, StatementMapping } from "@/components/documents/StatementMapping";
import { StatementReport } from "@/components/documents/StatementReport";
import { TransferDone, TransferReview } from "@/components/documents/TransferReview";
import { Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { getDocumentDetail } from "@/lib/docs/detail";
import { formatDay, formatTime } from "@/lib/format";
import { listCategories } from "@/lib/repo/categories";
import { idParam } from "@/lib/schemas";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const id = idParam.safeParse((await params).id);
  if (!id.success) notFound();
  const detail = await getDocumentDetail(id.data);
  if (!detail) notFound();
  const { document: d, transfer, statement, cards } = detail;
  const categories = transfer && d.status === "needs_review" ? await listCategories() : [];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/documentos" className="mb-3 inline-flex items-center gap-1.5 text-muted hover:text-fg"><ArrowLeft size={14} aria-hidden /> Documentos</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="num break-words text-2xl font-semibold" data-testid="doc-heading">{d.title ?? KIND_LABEL[d.kind]}</h1>
            <p className="mt-1 text-muted">{KIND_LABEL[d.kind]} · subido {formatDay(d.created_at)} {formatTime(d.created_at)}{d.origin === "whatsapp" ? " · por WhatsApp" : ""}{d.pages ? ` · ${d.pages} pág.` : ""}</p>
          </div>
          <div className="flex items-center gap-2"><StatusChip status={d.status} /><DeleteDocumentButton id={d.id} statement={d.kind === "statement"} /></div>
        </div>
        {d.detail && <p className="mt-2 text-muted" data-testid="doc-detail">{d.detail}</p>}
      </div>

      {transfer && d.status === "needs_review" && <TransferReview detail={detail} categories={categories} />}
      {transfer && d.status !== "needs_review" && <TransferDone detail={detail} />}

      {statement && (
        <>
          {statement.needsMapping.length > 0 ? <StatementMapping doc={d} statement={statement} cards={cards} /> : <MappingEditor doc={d} statement={statement} cards={cards} />}
          <StatementReport statement={statement} />
          {statement.runs.length === 0 && statement.needsMapping.length === 0 && (
            <Panel title="Sin conciliación"><p className="text-muted">Este estado todavía no tiene una conciliación. Si acabas de indicar las tarjetas, espera un momento; si no, vuelve a subir el PDF.</p></Panel>
          )}
        </>
      )}

      {!transfer && !statement && (
        <Panel title={d.status === "failed" ? "No se pudo leer" : "Sin datos para revisar"}>
          <p className="text-muted">{d.detail ?? "Este documento no trae datos que revisar."}</p>
          {d.status === "failed" && <p className="mt-2 text-muted">Puedes volver a subir el mismo PDF desde <Link href="/documentos" className="text-accent-2 underline">Documentos</Link>; se intentará de nuevo.</p>}
        </Panel>
      )}
    </div>
  );
}
