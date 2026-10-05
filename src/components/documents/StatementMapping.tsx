"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { DocumentDetail, StatementKey } from "@/lib/docs/detail";
import type { DocRow } from "@/lib/repo/documents";
import type { Card } from "@/lib/types";
import { Panel } from "../ui/Panel";

type Statement = NonNullable<DocumentDetail["statement"]>;
type Spec = { default: string; holders: Record<string, string>; sections: Record<string, string>; domiciliation: string };

const nameOf = (x: unknown): string => (typeof x === "string" ? x : (x as { name?: string } | undefined)?.name ?? "");
const recNames = (r: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, nameOf(v)]));

function initial(k: StatementKey, map: Statement["map"]): Spec {
  const m = map?.[k.card_key];
  return { default: nameOf(m?.default), holders: recNames(m?.holders), sections: recNames(m?.sections), domiciliation: nameOf(m?.domiciliation) };
}

function CardSelect({ id, value, onChange, cards, blank, label }: { id: string; value: string; onChange: (v: string) => void; cards: Card[]; blank: string; label: string }) {
  return (
    <select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="field !h-11">
      <option value="">{blank}</option>
      {cards.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
    </select>
  );
}

/** ¿A qué tarjeta de la app corresponde cada estado? Se pregunta una sola vez y se recuerda. */
export function StatementMapping({ doc, statement, cards, editing = false, onClose }: { doc: Omit<DocRow, "sha256">; statement: Statement; cards: Card[]; editing?: boolean; onClose?: () => void }) {
  const router = useRouter();
  const keys = statement.keys.filter((k) => editing || statement.needsMapping.includes(k.card_key));
  const [spec, setSpec] = useState<Record<string, Spec>>(() => Object.fromEntries(keys.map((k) => [k.card_key, initial(k, statement.map)])));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectable = cards.filter((c) => c.active);
  const patch = (key: string, f: (s: Spec) => Spec) => setSpec((p) => ({ ...p, [key]: f(p[key]) }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (keys.some((k) => !spec[k.card_key]?.default)) return setError("Elige una tarjeta para cada estado");
    // Se conserva el resto del mapa; los destinos se guardan como nombres de tarjetas existentes.
    const next: Record<string, unknown> = Object.fromEntries(Object.entries(statement.map ?? {}).map(([k, m]) => [k, {
      default: nameOf(m.default),
      ...(m.sections ? { sections: recNames(m.sections) } : {}),
      ...(m.holders ? { holders: recNames(m.holders) } : {}),
      ...(m.domiciliation ? { domiciliation: nameOf(m.domiciliation) } : {}),
    }]));
    const clean = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).filter(([, v]) => v));
    for (const k of keys) {
      const s = spec[k.card_key];
      const holders = clean(Object.fromEntries(k.holders.map((h) => [h, s.holders[h] ?? ""])));
      const sections = clean(Object.fromEntries(k.sections.map((h) => [h, s.sections[h] ?? ""])));
      next[k.card_key] = {
        default: s.default,
        ...(Object.keys(holders).length ? { holders } : {}),
        ...(Object.keys(sections).length ? { sections } : {}),
        ...(k.domiciliation && s.domiciliation ? { domiciliation: s.domiciliation } : {}),
      };
    }
    setBusy(true);
    const put = await apiFetch("/api/settings/statement-cards", "PUT", next);
    if (!put.ok) { setBusy(false); return setError(put.error); }
    // Este y los demás estados que esperaban el mapa se concilian de una vez.
    const list = await apiFetch<{ documents: { id: number; kind: string; status: string }[] }>("/api/documents", "GET");
    const ids = new Set<number>([doc.id, ...(list.ok ? list.data.documents.filter((d) => d.kind === "statement" && d.status === "needs_review").map((d) => d.id) : [])]);
    let failed = 0;
    for (const id of [...ids].slice(0, 10)) if (!(await apiFetch(`/api/documents/${id}/reconcile`, "POST", {})).ok) failed++;
    setBusy(false);
    if (failed) setError("Guardé las tarjetas, pero no pude conciliar uno de los estados. Intenta de nuevo.");
    else { onClose?.(); router.refresh(); }
  }

  if (!keys.length) return null;
  return (
    <Panel title="¿A qué tarjeta corresponde cada estado?">
      <form onSubmit={save} className="grid gap-4" data-testid="mapping-form">
        <p className="text-muted">Elige la tarjeta de la app para comparar sus movimientos con el estado. Solo se pregunta una vez; después se recuerda. No se crea ninguna tarjeta.</p>
        {keys.map((k) => (
          <fieldset key={k.card_key} className="grid gap-3 rounded-xl border border-line p-3.5">
            <legend className="px-1 font-medium">Estado «{k.card_key}»</legend>
            {k.documents.length > 0 && <p className="-mt-1 truncate text-[11px] text-muted">{k.documents.join(" · ")}</p>}
            <div>
              <label className="label" htmlFor={`m-${k.card_key}`}>{k.holders.length ? "Tarjeta principal" : "Tarjeta de la app"}</label>
              <CardSelect id={`m-${k.card_key}`} label={`Tarjeta para el estado ${k.card_key}`} value={spec[k.card_key]?.default ?? ""} onChange={(v) => patch(k.card_key, (s) => ({ ...s, default: v }))} cards={selectable} blank="Elige una tarjeta…" />
            </div>
            {k.holders.length > 1 && (
              <div className="grid gap-2.5">
                <p className="text-muted">Este estado trae movimientos de varios titulares. Asigna cada uno a su tarjeta (o déjalo en la principal).</p>
                {k.holders.map((h, i) => (
                  <div key={h}>
                    <label className="label" htmlFor={`h-${k.card_key}-${i}`}>Titular: {h}</label>
                    <CardSelect id={`h-${k.card_key}-${i}`} label={`Tarjeta de ${h}`} value={spec[k.card_key]?.holders[h] ?? ""} onChange={(v) => patch(k.card_key, (s) => ({ ...s, holders: { ...s.holders, [h]: v } }))} cards={selectable} blank="La tarjeta principal" />
                  </div>
                ))}
              </div>
            )}
            {k.sections.length > 0 && (
              <div className="grid gap-2.5">
                <p className="text-muted">Secciones del estado con tarjeta propia (por ejemplo, la virtual):</p>
                {k.sections.map((h, i) => (
                  <div key={h}>
                    <label className="label" htmlFor={`s-${k.card_key}-${i}`}>Sección: {h}</label>
                    <CardSelect id={`s-${k.card_key}-${i}`} label={`Tarjeta de la sección ${h}`} value={spec[k.card_key]?.sections[h] ?? ""} onChange={(v) => patch(k.card_key, (s) => ({ ...s, sections: { ...s.sections, [h]: v } }))} cards={selectable} blank="La tarjeta principal" />
                  </div>
                ))}
              </div>
            )}
            {k.domiciliation && (
              <div>
                <label className="label" htmlFor={`d-${k.card_key}`}>Domiciliaciones y pagos desde la cuenta</label>
                <CardSelect id={`d-${k.card_key}`} label="Tarjeta para domiciliaciones" value={spec[k.card_key]?.domiciliation ?? ""} onChange={(v) => patch(k.card_key, (s) => ({ ...s, domiciliation: v }))} cards={cards} blank="La tarjeta principal" />
              </div>
            )}
          </fieldset>
        ))}
        {error && <p role="alert" className="text-down" data-testid="mapping-error">{error}</p>}
        <div className="flex gap-2">
          {editing && <button type="button" className="btn !h-12 flex-1" onClick={onClose} disabled={busy}>Cancelar</button>}
          <button className="btn btn-primary !h-12 flex-1 text-[14px]" disabled={busy} data-testid="mapping-submit">{busy ? "Conciliando…" : "Guardar y conciliar"}</button>
        </div>
      </form>
    </Panel>
  );
}

/** Con el mapa ya completo: un botón discreto para cambiarlo si se eligió mal. */
export function MappingEditor({ doc, statement, cards }: { doc: Omit<DocRow, "sha256">; statement: Statement; cards: Card[] }) {
  const [open, setOpen] = useState(false);
  if (open) return <StatementMapping doc={doc} statement={statement} cards={cards} editing onClose={() => setOpen(false)} />;
  const rows = statement.keys.map((k) => {
    const m = statement.map?.[k.card_key];
    return `${k.card_key} → ${nameOf(m?.default) || "—"}`;
  });
  return (
    <div className="flex flex-wrap items-center gap-2 text-muted">
      <p className="min-w-0 flex-1 basis-[200px] truncate" data-testid="mapping-summary">Tarjetas: {rows.join(" · ")}</p>
      <button className="btn !h-9 text-[12px]" onClick={() => setOpen(true)}>Cambiar tarjetas</button>
    </div>
  );
}
