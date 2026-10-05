import { query, t } from "@/lib/db/pool";

/** Un PDF recibido (de la app o, más adelante, de WhatsApp). El archivo NO se guarda: solo su huella y lo extraído. */
export type DocKind = "transfer_receipt" | "statement" | "unknown";
export type DocOrigin = "app" | "whatsapp" | "telegram";
export type DocStatus = "processed" | "needs_review" | "rejected" | "failed";

export type DocRow = {
  id: number;
  sha256: string;
  kind: DocKind;
  origin: DocOrigin;
  status: DocStatus;
  title: string | null;
  detail: string | null;
  card_id: number | null;
  tx_id: number | null;
  period_start: string | null;
  period_end: string | null;
  size_bytes: number;
  pages: number | null;
  created_at: string;
  updated_at: string;
};

type Raw = Omit<DocRow, "created_at" | "updated_at" | "id" | "tx_id" | "card_id"> & { id: number; tx_id: number | null; card_id: number | null; created_at: Date; updated_at: Date };
const COLS = `id, sha256, kind, origin, status, title, detail, card_id, tx_id, CONVERT(char(10), period_start, 23) AS period_start, CONVERT(char(10), period_end, 23) AS period_end, size_bytes, pages, created_at, updated_at`;
const map = (r: Raw): DocRow => ({ ...r, id: Number(r.id), card_id: r.card_id === null ? null : Number(r.card_id), tx_id: r.tx_id === null ? null : Number(r.tx_id), created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString() });

export async function findDocumentBySha(sha256: string): Promise<DocRow | null> {
  const r = await query<Raw>(`SELECT ${COLS} FROM dbo.documents WHERE sha256=@h`, { h: t.char(sha256) });
  return r[0] ? map(r[0]) : null;
}

export async function getDocument(id: number): Promise<DocRow | null> {
  const r = await query<Raw>(`SELECT ${COLS} FROM dbo.documents WHERE id=@id`, { id: t.int(id) });
  return r[0] ? map(r[0]) : null;
}

export async function listDocuments(limit = 50): Promise<DocRow[]> {
  const r = await query<Raw>(`SELECT TOP (@n) ${COLS} FROM dbo.documents ORDER BY created_at DESC, id DESC`, { n: t.int(Math.min(Math.max(limit, 1), 200)) });
  return r.map(map);
}

/** JSON extraído (puede traer nombres y montos): solo se lee por id, nunca en listados. */
export async function getExtracted<T = unknown>(id: number): Promise<T | null> {
  const r = await query<{ extracted: string | null }>("SELECT extracted FROM dbo.documents WHERE id=@id", { id: t.int(id) });
  if (!r[0]?.extracted) return null;
  try {
    return JSON.parse(r[0].extracted) as T;
  } catch {
    return null;
  }
}

export type DocWrite = {
  kind: DocKind;
  origin: DocOrigin;
  status: DocStatus;
  title?: string | null;
  detail?: string | null;
  extracted?: unknown;
  cardId?: number | null;
  txId?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  pages?: number | null;
};

const params = (d: DocWrite) => ({
  kind: t.varchar(d.kind), origin: t.varchar(d.origin), status: t.varchar(d.status), title: t.str(d.title?.slice(0, 200) ?? null), detail: t.str(d.detail?.slice(0, 500) ?? null),
  extracted: t.str(d.extracted === undefined ? null : JSON.stringify(d.extracted)), card: t.int(d.cardId ?? null), tx: t.big(d.txId ?? null),
  ps: t.date(d.periodStart ?? null), pe: t.date(d.periodEnd ?? null), pages: t.int(d.pages ?? null),
});

export async function createDocument(sha256: string, sizeBytes: number, d: DocWrite): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT dbo.documents (sha256, kind, origin, status, title, detail, extracted, card_id, tx_id, period_start, period_end, size_bytes, pages)
     OUTPUT INSERTED.id VALUES (@h, @kind, @origin, @status, @title, @detail, @extracted, @card, @tx, @ps, @pe, @size, @pages)`,
    { ...params(d), h: t.char(sha256), size: t.int(sizeBytes) },
  );
  return Number(r[0].id);
}

/** Reprocesa un documento existente (falló o estaba en revisión): conserva id y huella. */
export async function rewriteDocument(id: number, d: DocWrite): Promise<void> {
  await query(
    `UPDATE dbo.documents SET kind=@kind, origin=@origin, status=@status, title=@title, detail=@detail, extracted=@extracted, card_id=@card, tx_id=@tx,
       period_start=@ps, period_end=@pe, pages=@pages, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { ...params(d), id: t.int(id) },
  );
}

export async function patchDocument(id: number, p: { status?: DocStatus; detail?: string | null; title?: string | null; txId?: number | null; cardId?: number | null; extracted?: unknown }): Promise<void> {
  await query(
    `UPDATE dbo.documents SET
       status = COALESCE(@status, status), detail = CASE WHEN @hasDetail = 1 THEN @detail ELSE detail END,
       title = COALESCE(@title, title), tx_id = COALESCE(@tx, tx_id), card_id = COALESCE(@card, card_id),
       extracted = CASE WHEN @hasExtracted = 1 THEN @extracted ELSE extracted END, updated_at = SYSUTCDATETIME()
     WHERE id=@id`,
    {
      id: t.int(id), status: t.varchar(p.status ?? null), hasDetail: t.bit(p.detail !== undefined), detail: t.str(p.detail?.slice(0, 500) ?? null), title: t.str(p.title?.slice(0, 200) ?? null),
      tx: t.big(p.txId ?? null), card: t.int(p.cardId ?? null), hasExtracted: t.bit(p.extracted !== undefined), extracted: t.str(p.extracted === undefined ? null : JSON.stringify(p.extracted)),
    },
  );
}

export async function deleteDocument(id: number): Promise<boolean> {
  return (await query("DELETE dbo.documents OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) })).length > 0;
}

export async function pendingDocumentCount(): Promise<number> {
  const r = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.documents WHERE status='needs_review'");
  return r[0].n;
}
