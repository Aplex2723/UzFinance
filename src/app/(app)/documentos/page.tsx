import { DocumentList } from "@/components/documents/DocumentList";
import { DocumentUploader } from "@/components/documents/DocumentUploader";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listDocuments } from "@/lib/repo/documents";

export default async function Page() {
  await requirePageUser();
  const documents = (await listDocuments(50)).map(({ sha256: _h, ...d }) => (void _h, d));
  const pending = documents.filter((d) => d.status === "needs_review").length;
  return (
    <>
      <PageTitle title="Documentos" subtitle="Sube comprobantes de transferencia y estados de cuenta en PDF." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Panel title="Subir PDF"><DocumentUploader /></Panel>
        <Panel title={pending > 0 ? `Documentos recientes · ${pending} por revisar` : "Documentos recientes"}><DocumentList documents={documents} /></Panel>
      </div>
    </>
  );
}
