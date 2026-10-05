"use client";
import { Ban, Check, CheckCheck, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import type { AlertRow } from "@/lib/repo/alerts";
import type { TxBrief } from "@/lib/repo/tx-lookup";
import { Chip, SEVERITY_LABEL, SEVERITY_TONE } from "../documents/shared";
import { Empty, Panel } from "../ui/Panel";
import { RULE_LABEL } from "./labels";

const ORDER = ["high", "warn", "info"] as const;

function linkFor(a: AlertRow, txs: Record<number, TxBrief>): { href: string; label: string } | null {
  if (a.documentId) return { href: `/documentos/${a.documentId}`, label: "Ver documento" };
  const b = a.txId ? txs[a.txId] : undefined;
  if (b) return { href: `/transacciones?${new URLSearchParams({ q: b.merchant.slice(0, 60), month: b.date.slice(0, 7), ...(b.kind === "card_payment" ? { kind: "card_payment" } : {}) })}`, label: "Ver movimiento" };
  if (a.rule === "spending_pace" || a.rule === "daily_spike") return { href: "/analitica", label: "Ver analítica" };
  if (a.rule === "goal_off_track") return { href: "/", label: "Ver mi meta" };
  return null;
}

export function AlertsList({ alerts: initial, txs }: { alerts: AlertRow[]; txs: Record<number, TxBrief> }) {
  const router = useRouter();
  const [alerts, setAlerts] = useState(initial);
  const [withDismissed, setWithDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cuando el servidor trae datos nuevos (LiveRefresh / router.refresh) se vuelve a tomar su lista.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    if (!withDismissed) setAlerts(initial);
  }

  async function toggleDismissed(on: boolean) {
    setWithDismissed(on);
    if (!on) return setAlerts(initial);
    const r = await apiFetch<{ alerts: AlertRow[] }>("/api/alerts?include_dismissed=true&limit=100", "GET");
    if (r.ok) setAlerts(r.data.alerts);
    else setError(r.error);
  }

  async function act(id: number, action: "read" | "dismiss") {
    setError(null);
    const r = await apiFetch(`/api/alerts/${id}`, "PATCH", { action });
    if (!r.ok) return setError(r.error);
    const now = new Date().toISOString();
    setAlerts((l) => l.map((a) => (a.id === id ? { ...a, readAt: a.readAt ?? now, dismissedAt: action === "dismiss" ? now : a.dismissedAt } : a)).filter((a) => withDismissed || !a.dismissedAt));
    router.refresh();
  }
  async function readAll() {
    setBusy(true);
    setError(null);
    const r = await apiFetch("/api/alerts/read-all", "POST", {});
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const now = new Date().toISOString();
    setAlerts((l) => l.map((a) => ({ ...a, readAt: a.readAt ?? now })));
    router.refresh();
  }

  const unreadNow = alerts.filter((a) => !a.readAt && !a.dismissedAt).length;
  const shown = unreadNow;
  const groups = ORDER.map((s) => [s, alerts.filter((a) => a.severity === s)] as const).filter(([, l]) => l.length);

  return (
    <Panel
      title={shown > 0 ? `Alertas · ${shown} sin leer` : "Alertas"}
      action={<button className="btn !h-9 text-[12px]" onClick={readAll} disabled={busy || shown === 0} data-testid="read-all"><CheckCheck size={13} aria-hidden /> Marcar todas como leídas</button>}
    >
      <label className="mb-3 flex items-center gap-2 text-muted">
        <input type="checkbox" checked={withDismissed} onChange={(e) => void toggleDismissed(e.target.checked)} className="h-4 w-4 accent-[#ff4d1c]" /> Mostrar también las descartadas
      </label>
      {error && <p role="alert" className="mb-2 text-down">{error}</p>}
      {alerts.length === 0 ? <Empty>No tienes alertas. Cuando algo merezca tu atención, aparecerá aquí.</Empty> : (
        <div className="grid gap-4">
          {groups.map(([sev, list]) => (
            <section key={sev} aria-label={`Alertas: ${SEVERITY_LABEL[sev]}`}>
              <h3 className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted"><Chip tone={SEVERITY_TONE[sev]}>{SEVERITY_LABEL[sev]}</Chip> {list.length}</h3>
              <ul className="grid gap-2">
                {list.map((a) => {
                  const link = linkFor(a, txs);
                  const isUnread = !a.readAt && !a.dismissedAt;
                  return (
                    <li key={a.id} className={`rounded-xl border p-3 ${isUnread ? "border-white/20 bg-white/[0.05]" : "border-line bg-black/20"} ${a.dismissedAt ? "opacity-60" : ""}`} data-testid="alert-row" data-unread={isUnread}>
                      <div className="flex flex-wrap items-center gap-2">
                        {isUnread && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />}
                        <p className="min-w-0 flex-1 basis-[200px] font-medium">{a.title}{isUnread && <span className="sr-only"> (sin leer)</span>}</p>
                        <span className="text-[11px] text-muted">{formatDay(a.createdAt)} {formatTime(a.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-muted">{a.body}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Chip>{RULE_LABEL[a.rule] ?? a.rule}</Chip>
                        {a.dismissedAt && <Chip>Descartada</Chip>}
                        <span className="ml-auto flex flex-wrap gap-2">
                          {link && <Link href={link.href} onClick={() => { if (isUnread) void act(a.id, "read"); }} className="btn !h-10 text-[12px]">{link.label} <ExternalLink size={12} aria-hidden /></Link>}
                          {isUnread && <button className="btn !h-10 text-[12px]" onClick={() => act(a.id, "read")}><Check size={13} aria-hidden /> Leída</button>}
                          {!a.dismissedAt && <button className="btn !h-10 text-[12px]" onClick={() => act(a.id, "dismiss")} aria-label={`Descartar: ${a.title}`}><Ban size={13} aria-hidden /> Descartar</button>}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}
