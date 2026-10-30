"use client";
import { CornerDownLeft, Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { apiFetch, emit, EVENTS } from "@/lib/client";
import { formatMXN } from "@/lib/money";
import { ALL_ITEMS } from "./nav";
import { Dialog } from "./ui/Dialog";

type Item = { id: string; group: string; label: string; hint?: string; run: () => void };
type TxHit = { id: number; merchant_raw: string; amount_cents: number; occurred_date: string; card_name: string };

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<TxHit[]>([]);
  const [idx, setIdx] = useState(0);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const close = useCallback(() => { setOpen(false); setQ(""); setHits([]); setIdx(0); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // Búsqueda de transacciones con debounce.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      const r = await apiFetch<{ rows: TxHit[] }>(`/api/transactions?limit=6&q=${encodeURIComponent(term)}`, "GET");
      if (!cancelled && r.ok) setHits(r.data.rows);
    }, 200);
    return () => { cancelled = true; clearTimeout(h); };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const go = (href: string) => () => { close(); router.push(href); };
    const nav: Item[] = ALL_ITEMS.map((i) => ({ id: `nav-${i.href}`, group: "Ir a", label: i.label, run: go(i.href) }));
    const actions: Item[] = [
      { id: "a-chat", group: "Acciones", label: "Preguntar a UzChat", hint: "Tu asesor financiero con IA", run: () => { close(); emit(EVENTS.openChat); } },
      { id: "a-add", group: "Acciones", label: "Agregar gasto", run: () => { close(); emit(EVENTS.addExpense); } },
      { id: "a-csv", group: "Acciones", label: "Importar CSV", run: () => { close(); emit(EVENTS.importCsv); } },
      { id: "a-cat", group: "Acciones", label: "Categorizar pendientes", run: async () => { close(); await apiFetch("/api/transactions/categorize", "POST", {}); router.refresh(); } },
    ];
    const txs: Item[] = hits.map((h) => ({ id: `tx-${h.id}`, group: "Transacciones", label: h.merchant_raw, hint: `${formatMXN(h.amount_cents)} · ${h.card_name} · ${h.occurred_date}`, run: go(`/transacciones?q=${encodeURIComponent(q.trim())}`) }));
    const base = [...actions, ...nav].filter((i) => !term || i.label.toLowerCase().includes(term));
    return [...base, ...txs];
  }, [q, hits, router, close]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); items[idx]?.run(); }
  };

  const groups = [...new Set(items.map((i) => i.group))];
  const icon = (g: string) => (g === "Acciones" ? <Plus size={14} /> : <Search size={14} />);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="glass flex h-10 w-full items-center gap-2 !rounded-full px-3.5 text-left text-muted hover:text-fg"
        aria-label="Abrir buscador de comandos"
        aria-keyshortcuts="Meta+K Control+K"
      >
        <Search size={15} aria-hidden />
        <span className="flex-1 truncate">Buscar o escribir un comando</span>
        <kbd className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[10px]">⌘K</kbd>
      </button>

      <Dialog open={open} onClose={close} title="Buscador de comandos">
        <div role="combobox" aria-expanded="true" aria-controls={listId} aria-haspopup="listbox">
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setIdx(0); if (e.target.value.trim().length < 2) setHits([]); }}
            onKeyDown={onKeyDown}
            placeholder="Buscar comercio, página o acción…"
            className="field"
            aria-autocomplete="list"
            aria-activedescendant={items[idx] ? `${listId}-${items[idx].id}` : undefined}
          />
        </div>
        <ul id={listId} role="listbox" className="mt-3 max-h-[50dvh] overflow-y-auto">
          {items.length === 0 && <li className="py-6 text-center text-muted">Sin resultados</li>}
          {groups.map((g) => (
            <li key={g} role="presentation">
              <p className="px-2 pb-1 pt-2 text-[10px] tracking-wider text-faint">{g.toUpperCase()}</p>
              <ul role="group" aria-label={g}>
                {items.map((it, i) => it.group !== g ? null : (
                  <li
                    key={it.id}
                    id={`${listId}-${it.id}`}
                    role="option"
                    aria-selected={i === idx}
                    onMouseMove={() => setIdx(i)}
                    onClick={it.run}
                    className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ${i === idx ? "bg-surface-2" : ""}`}
                  >
                    <span className="text-muted">{icon(g)}</span>
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint && <span className="truncate text-[11px] text-muted">{it.hint}</span>}
                    {i === idx && <CornerDownLeft size={12} className="text-faint" aria-hidden />}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
