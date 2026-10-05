"use client";
import { Ban, CheckCheck, Download, ExternalLink, OctagonAlert, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { DocumentDetail } from "@/lib/docs/detail";
import type { ImportReport } from "@/lib/import/statements";
import { formatMXN } from "@/lib/money";
import { formatDay } from "@/lib/format";
import type { FindingRow, ReconRunDetail } from "@/lib/repo/recon";
import type { TxBrief } from "@/lib/repo/tx-lookup";
import { Dialog } from "../ui/Dialog";
import { Panel } from "../ui/Panel";
import { Chip, SEVERITY_LABEL, SEVERITY_TONE } from "./shared";

type Statement = NonNullable<DocumentDetail["statement"]>;

const KIND_LABEL: Record<string, string> = {
  missing_in_app: "Falta en la app",
  not_in_statement: "No aparece en el estado",
  duplicate_suspect: "Posible duplicado",
  amount_mismatch: "Monto distinto",
  total_mismatch: "El total no cuadra",
  extraction_check_failed: "Lectura del PDF dudosa",
};
/** Por qué importa cada tipo de hallazgo, en una frase. */
const WHY: Record<string, string> = {
  missing_in_app: "El banco te cobró algo que no tienes registrado: puede ser un gasto que se te pasó o que no llegó el correo.",
  not_in_statement: "Tienes registrado un movimiento de este periodo que el banco no cobró (todavía): puede estar de más, ser de otra tarjeta o postearse después.",
  duplicate_suspect: "La app tiene más movimientos iguales que cargos en el estado: puede haberse registrado dos veces (por ejemplo, Atajo y correo) y estar inflando tu gasto.",
  amount_mismatch: "Es la misma compra pero con otro monto: revisa cuál es el correcto (propina, tipo de cambio o un error de captura).",
  total_mismatch: "La suma de lo que cobró el banco no coincide con la de la app en este periodo: algo falta o sobra aunque no se vea a primera vista.",
  extraction_check_failed: "Los totales leídos del PDF no cuadran con los impresos en el propio estado, así que esta lectura no es confiable.",
};
const SOURCE_LABEL: Record<string, string> = { shortcut: "Atajo", email: "Correo", statement: "Estado", manual: "Manual", receipt: "Comprobante" };

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? formatMXN(n) : null);

function txLink(b: TxBrief): string {
  const u = new URLSearchParams({ q: b.merchant.slice(0, 60), month: b.date.slice(0, 7) });
  if (b.kind === "card_payment") u.set("kind", "card_payment");
  return `/transacciones?${u}`;
}

function TxLine({ b }: { b: TxBrief }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-black/25 px-2.5 py-1.5 text-[12px]" data-testid="finding-tx">
      <span className="num text-muted">#{b.id}</span>
      <span className="min-w-0 flex-1 basis-[140px] truncate">{b.merchant}</span>
      <span className="num">{formatMXN(b.cents)}</span>
      <span className="text-muted">{formatDay(`${b.date}T12:00:00Z`)} · {b.card} · {SOURCE_LABEL[b.source] ?? b.source}</span>
      <Link href={txLink(b)} className="inline-flex items-center gap-1 text-accent-2 hover:underline" aria-label={`Ver ${b.merchant} en Transacciones`}>Ver <ExternalLink size={11} aria-hidden /></Link>
    </li>
  );
}

function ReportView({ r }: { r: ImportReport }) {
  const ins = r.docs.reduce((a, d) => a + d.inserted, 0);
  const cents = r.docs.reduce((a, d) => a + d.insertedCents, 0);
  const existing = r.docs.reduce((a, d) => a + d.existing, 0);
  return (
    <div className="grid gap-2">
      <p><b className="num text-[18px]">{ins}</b> movimiento{ins === 1 ? "" : "s"} · <b className="num">{formatMXN(cents)}</b></p>
      {existing > 0 && <p className="text-muted">{existing} ya existía{existing === 1 ? "" : "n"} y no se duplica.</p>}
      {Object.keys(r.byCategory).length > 0 && (
        <ul className="flex flex-wrap gap-1.5">{Object.entries(r.byCategory).map(([k, n]) => <li key={k}><Chip>{k}: {n}</Chip></li>)}</ul>
      )}
      {r.warnings.map((w) => <p key={w} className="text-[#fbbf24]">{w}</p>)}
    </div>
  );
}

function FindingCard({ f, run, st, trusted, busy, onStatus, onImport }: {
  f: FindingRow; run: ReconRunDetail; st: Statement; trusted: boolean; busy: boolean;
  onStatus: (id: number, s: "open" | "resolved" | "dismissed") => void; onImport: (id: number) => void;
}) {
  const d = f.detail ?? {};
  const importable = f.kind === "missing_in_app" && d.importable === true && trusted && f.status === "open";
  const briefIds = [...new Set([f.txId, f.otherTxId, typeof d.appId === "number" ? d.appId : null].filter((n): n is number => typeof n === "number"))];
  const briefs = briefIds.map((id) => st.transactions[id]).filter(Boolean);
  const amt = money(f.stmtAmountCents);
  const closed = f.status !== "open";
  return (
    <li className={`rounded-xl border p-3 ${f.kind === "extraction_check_failed" ? "border-[#ef4444]/50 bg-[#ef4444]/8" : "border-line bg-black/20"} ${closed ? "opacity-70" : ""}`} data-testid="finding" data-kind={f.kind} data-severity={f.severity}>
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <Chip tone={SEVERITY_TONE[f.severity]}>{SEVERITY_LABEL[f.severity]}</Chip>
        <span className="font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
        {closed && <Chip>{f.status === "resolved" ? "Resuelto" : "Descartado"}</Chip>}
        {amt && <span className="num ml-auto text-[15px] font-semibold">{amt}</span>}
      </div>
      <p>{f.message}</p>
      {(f.stmtMerchant || f.stmtDate) && (
        <p className="mt-0.5 text-[11px] text-muted">
          Estado: {[f.stmtMerchant, f.stmtDate ? formatDay(`${f.stmtDate}T12:00:00Z`) : null].filter(Boolean).join(" · ")}
          {typeof d.holder === "string" && d.holder ? ` · ${d.holder}` : ""}
        </p>
      )}
      {f.kind === "total_mismatch" && typeof d.unexplainedCents === "number" && d.unexplainedCents !== 0 && <p className="mt-0.5 text-muted">Sin explicar: <b className="num text-fg">{money(d.unexplainedCents)}</b> (estado {money(d.statementCents)} contra app {money(d.appCents)}).</p>}
      <p className="mt-1.5 text-[11px] text-muted">{WHY[f.kind] ?? ""}</p>
      {f.kind === "extraction_check_failed" && <p role="alert" className="mt-1.5 font-medium text-down">No importes nada de este estado: la lectura no es confiable. Revisa el PDF original.</p>}
      {briefs.length > 0 && <ul className="mt-2 grid gap-1" aria-label="Movimientos relacionados">{briefs.map((b) => <TxLine key={b.id} b={b} />)}</ul>}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {importable && <button className="btn btn-primary !h-10" disabled={busy} onClick={() => onImport(f.id)} data-testid="import-one"><Download size={14} aria-hidden /> Importar a la app</button>}
        {f.status === "open" ? (
          <>
            <button className="btn !h-10" disabled={busy} onClick={() => onStatus(f.id, "resolved")}><CheckCheck size={14} aria-hidden /> Marcar como resuelto</button>
            <button className="btn !h-10" disabled={busy} onClick={() => onStatus(f.id, "dismissed")} data-testid="dismiss-finding"><Ban size={14} aria-hidden /> Descartar</button>
          </>
        ) : (
          <button className="btn !h-10" disabled={busy} onClick={() => onStatus(f.id, "open")}><RotateCcw size={14} aria-hidden /> Reabrir</button>
        )}
      </div>
      <span className="sr-only">{run.label}</span>
    </li>
  );
}

function RunPanel({ run, st, docTrusted, onMsg }: { run: ReconRunDetail; st: Statement; docTrusted: boolean; onMsg: (m: { ok: boolean; text: string } | null) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [bulk, setBulk] = useState<{ ids: number[]; preview: ImportReport | null; error: string | null; done: ImportReport | null } | null>(null);
  const trusted = run.trusted && docTrusted;
  const open = run.findingList.filter((f) => f.status === "open");
  const closed = run.findingList.filter((f) => f.status !== "open");
  const diff = run.statementCents - run.appCents;
  const importableIds = open.filter((f) => f.kind === "missing_in_app" && f.detail?.importable === true).map((f) => f.id);
  const groups = (["high", "warn", "info"] as const).map((s) => [s, open.filter((f) => f.severity === s)] as const).filter(([, l]) => l.length);

  async function setStatus(id: number, status: "open" | "resolved" | "dismissed") {
    setBusy(true);
    onMsg(null);
    const r = await apiFetch(`/api/recon/findings/${id}`, "PATCH", { status });
    setBusy(false);
    if (!r.ok) return onMsg({ ok: false, text: r.error });
    router.refresh();
  }
  async function importOne(id: number) {
    setBusy(true);
    onMsg(null);
    const r = await apiFetch<ImportReport>(`/api/documents/${run.documentId}/import-missing`, "POST", { finding_ids: [id] });
    setBusy(false);
    if (!r.ok) return onMsg({ ok: false, text: r.error });
    const n = r.data.docs.reduce((a, d) => a + d.inserted, 0);
    onMsg({ ok: n > 0, text: n > 0 ? "Listo: la compra se agregó a la app." : r.data.warnings[0] ?? "No se agregó nada: ya existía." });
    router.refresh();
  }
  async function openBulk() {
    setBulk({ ids: importableIds, preview: null, error: null, done: null });
    const r = await apiFetch<ImportReport>(`/api/documents/${run.documentId}/import-missing`, "POST", { finding_ids: importableIds, dry_run: true });
    setBulk((b) => (b ? { ...b, preview: r.ok ? r.data : null, error: r.ok ? null : r.error } : b));
  }
  async function confirmBulk() {
    if (!bulk) return;
    setBusy(true);
    const r = await apiFetch<ImportReport>(`/api/documents/${run.documentId}/import-missing`, "POST", { finding_ids: bulk.ids });
    setBusy(false);
    setBulk((b) => (b ? { ...b, done: r.ok ? r.data : null, error: r.ok ? null : r.error } : b));
    if (r.ok) router.refresh();
  }

  const stat = (label: string, value: string, tone = "") => (
    <div className="rounded-xl bg-black/25 p-2.5"><p className="text-[11px] text-muted">{label}</p><p className={`num mt-0.5 text-[16px] font-semibold ${tone}`}>{value}</p></div>
  );

  return (
    <Panel title={`${run.label} · ${run.periodStart} a ${run.periodEnd}`}>
      <div data-testid="run" className="grid gap-3">
        {!trusted && (
          <div role="alert" className="flex gap-2 rounded-xl border border-[#ef4444]/50 bg-[#ef4444]/10 p-3 text-down" data-testid="untrusted">
            <OctagonAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <p><b>No se debe importar de este estado.</b> Los totales que se leyeron del PDF no cuadran con los impresos en el estado; podría haber cargos mal leídos. Las diferencias de abajo son solo informativas.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {stat("Según el estado", formatMXN(run.statementCents))}
          {stat("Según tu app", formatMXN(run.appCents))}
          {stat("Diferencia", `${diff > 0 ? "+" : diff < 0 ? "−" : ""}${formatMXN(Math.abs(diff))}`, diff === 0 ? "text-up" : "text-[#fbbf24]")}
          {stat("Conciliados", `${run.matched} de ${run.statementCount}`)}
        </div>
        <p className="text-[11px] text-muted">La app tiene {run.appCount} movimiento{run.appCount === 1 ? "" : "s"} en el periodo. «Diferencia» es estado menos app: positiva = el banco cobró más de lo que tienes registrado.</p>

        {open.length === 0 && <p className="rounded-xl bg-[#22c55e]/10 p-3 text-up" data-testid="all-clear">Todo cuadra: no hay diferencias abiertas en esta tarjeta.</p>}

        {trusted && importableIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-black/20 p-3">
            <p className="min-w-0 flex-1 basis-[200px]"><b>{importableIds.length}</b> compra{importableIds.length === 1 ? "" : "s"} del estado no está{importableIds.length === 1 ? "" : "n"} en la app.</p>
            <button className="btn btn-primary !h-11" onClick={openBulk} disabled={busy} data-testid="import-all"><Download size={14} aria-hidden /> Importar todos los faltantes ({importableIds.length})</button>
          </div>
        )}

        {groups.map(([sev, list]) => (
          <section key={sev} aria-label={`Hallazgos: ${SEVERITY_LABEL[sev]}`}>
            <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted"><Chip tone={SEVERITY_TONE[sev]}>{SEVERITY_LABEL[sev]}</Chip> {list.length} por revisar</h3>
            <ul className="grid gap-2">{list.map((f) => <FindingCard key={f.id} f={f} run={run} st={st} trusted={trusted} busy={busy} onStatus={setStatus} onImport={importOne} />)}</ul>
          </section>
        ))}

        {closed.length > 0 && (
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer text-muted">Ya revisadas ({closed.length})</summary>
            <ul className="mt-2 grid gap-2">{closed.map((f) => <FindingCard key={f.id} f={f} run={run} st={st} trusted={trusted} busy={busy} onStatus={setStatus} onImport={importOne} />)}</ul>
          </details>
        )}
      </div>

      <Dialog open={bulk !== null} onClose={() => setBulk(null)} title={bulk?.done ? "Importación lista" : "Importar faltantes"}>
        {bulk && (
          <div className="grid gap-3" data-testid="bulk-dialog">
            {bulk.error && <p role="alert" className="text-down">{bulk.error}</p>}
            {!bulk.error && !bulk.preview && !bulk.done && <p role="status" className="text-muted">Calculando vista previa…</p>}
            {bulk.done ? (
              <>
                <ReportView r={bulk.done} />
                <button className="btn btn-primary !h-11" onClick={() => setBulk(null)}>Listo</button>
              </>
            ) : bulk.preview && (
              <>
                <p className="text-muted">Esto es lo que se agregaría (vista previa, aún no se guarda nada). Solo se agregan compras nuevas; tus movimientos existentes no se tocan.</p>
                <ReportView r={bulk.preview} />
                <div className="flex gap-2">
                  <button className="btn !h-11 flex-1" onClick={() => setBulk(null)} disabled={busy}>Cancelar</button>
                  <button className="btn btn-primary !h-11 flex-1" onClick={confirmBulk} disabled={busy} data-testid="confirm-import">{busy ? "Importando…" : "Confirmar importación"}</button>
                </div>
              </>
            )}
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

export function StatementReport({ statement }: { statement: Statement }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const docTrusted = statement.failedChecks.length === 0;
  if (!statement.runs.length) return null;
  return (
    <div className="flex flex-col gap-4" data-testid="statement-report">
      {!docTrusted && (
        <div role="alert" className="flex gap-2 rounded-xl border border-[#ef4444]/50 bg-[#ef4444]/10 p-3 text-down" data-testid="checks-failed">
          <OctagonAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
          <p><b>Los totales leídos del PDF no cuadran</b> ({statement.failedChecks.slice(0, 3).join("; ")}). No importes nada de este estado sin revisarlo contra el PDF original.</p>
        </div>
      )}
      {msg && <p role="status" className={`rounded-xl p-3 ${msg.ok ? "bg-[#22c55e]/10 text-up" : "bg-[#f59e0b]/10 text-[#fbbf24]"}`}>{msg.text}</p>}
      {statement.runs.map((run) => <RunPanel key={run.runId} run={run} st={statement} docTrusted={docTrusted} onMsg={setMsg} />)}
    </div>
  );
}
