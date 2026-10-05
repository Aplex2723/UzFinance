"use client";
import { ChevronDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { CardArt } from "@/components/CardArt";
import { ISSUER_LABEL, monthLabel, shiftMonth } from "@/lib/format";
import {
  activeTags, addDays, advancedCount, centsToPesos, detectPreset, isRealDate, parsePesosLoose, PERIOD_PRESETS, presetPeriod, rangeError, shortCardName,
  SORT_IDS, SORT_LABEL, SOURCE_FILTER_HINT, SOURCE_FILTER_LABEL, SOURCE_IDS, todayLocal, type PeriodPreset, type SourceId, type TxSort,
} from "@/lib/tx-filters";
import type { CardArtId, Issuer } from "@/lib/types";
import { Chip, ChipRow } from "./Chip";
import { useTxFilters } from "./TxFiltersProvider";

export type FilterCard = { id: number; name: string; issuer: Issuer; last4: string | null; color: string; art: CardArtId | null; /** Inactiva o de sistema (Domiciliación…): va al final. */ muted: "inactive" | "system" | null; /** Movimientos con los demás filtros aplicados. */ count: number };
export type FilterCategory = { id: number; name: string; color: string };

const ISSUER_ORDER: Issuer[] = ["amex", "banamex", "nu", "other"];

/**
 * Campo de texto que escribe en la URL con retraso (sin parpadeos al teclear). La URL manda: si cambia desde afuera (atrás,
 * "Limpiar filtros") el texto se actualiza; si cambió porque lo enviamos nosotros, no se pisa lo que se sigue tecleando.
 */
function useDebouncedField(external: string, commit: (v: string) => void, delay = 300) {
  const [text, setText] = useState(external);
  const [seen, setSeen] = useState(external);
  const [pushed, setPushed] = useState(external);
  if (external !== seen) {
    setSeen(external);
    if (external !== pushed) { setText(external); setPushed(external); }
  }
  const send = useEffectEvent(commit);
  useEffect(() => {
    if (text === external) return;
    const id = setTimeout(() => { setPushed(text); send(text); }, delay);
    return () => clearTimeout(id);
  }, [text, external, delay]);
  const now = (v: string) => { setText(v); setPushed(v); commit(v); };
  return { text, setText, now };
}

function SearchBox() {
  const { view, update } = useTxFilters();
  const f = useDebouncedField(view.q, (v) => update({ q: v.trim() }));
  return (
    <div className="relative">
      <Search size={15} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
      <input
        type="search"
        enterKeyHint="search"
        value={f.text}
        onChange={(e) => f.setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); f.now(f.text); } }}
        placeholder="Buscar comercio o nota"
        aria-label="Buscar"
        maxLength={100}
        className="field !h-11 !pl-10 !pr-10 [&::-webkit-search-cancel-button]:hidden"
      />
      {f.text && (
        <button type="button" onClick={() => f.now("")} aria-label="Borrar búsqueda" className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:text-fg">
          <X size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}

function AmountField({ label, cents, onCommit }: { label: string; cents: number | null; onCommit: (c: number | null) => void }) {
  const external = cents === null ? "" : centsToPesos(cents);
  const [invalid, setInvalid] = useState(false);
  const f = useDebouncedField(external, (v) => {
    const trimmed = v.trim();
    if (!trimmed) { setInvalid(false); onCommit(null); return; }
    const c = parsePesosLoose(trimmed);
    setInvalid(c === null);
    if (c !== null) onCommit(c);
  }, 450);
  const id = `tx-amount-${label}`;
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
        <input id={id} inputMode="decimal" autoComplete="off" value={f.text} onChange={(e) => f.setText(e.target.value)} placeholder="0" aria-invalid={invalid} aria-describedby={invalid ? `${id}-err` : undefined} className={`field !h-10 !pl-7 ${invalid ? "!border-down" : ""}`} />
      </div>
      {invalid && <p id={`${id}-err`} role="alert" className="mt-1 text-[11px] text-down">Escribe un monto válido, p. ej. 150 o 99.50</p>}
    </div>
  );
}

function CardChips({ cards }: { cards: FilterCard[] }) {
  const { view, update } = useTxFilters();
  const sel = new Set(view.cardIds);
  const groups: { key: string; label: string; cards: FilterCard[] }[] = [
    ...ISSUER_ORDER.map((i) => ({ key: i, label: ISSUER_LABEL[i], cards: cards.filter((c) => !c.muted && c.issuer === i) })),
    { key: "muted", label: "Otras", cards: cards.filter((c) => c.muted) },
  ].filter((g) => g.cards.length > 0);
  const toggle = (id: number) => update({ cardIds: sel.has(id) ? view.cardIds.filter((x) => x !== id) : [...view.cardIds, id] });
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted" id="tx-cards-label">
        <span>Tarjetas ·</span>
        <span data-testid="card-count" aria-live="polite" className="text-fg">{view.cardIds.length === 0 ? "Todas" : `${view.cardIds.length} ${view.cardIds.length === 1 ? "seleccionada" : "seleccionadas"}`}</span>
      </p>
      <ChipRow label="Tarjetas" testId="card-chips">
        <Chip active={view.cardIds.length === 0} onClick={() => update({ cardIds: [] })} testId="card-all">Todas</Chip>
        {groups.map((g) => (
          <div key={g.key} role="group" aria-label={g.label} className="flex shrink-0 items-center gap-2 border-l border-line pl-2">
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">{g.label}</span>
            {g.cards.map((c) => (
              <Chip key={c.id} active={sel.has(c.id)} onClick={() => toggle(c.id)} testId={`card-chip-${c.id}`} title={c.name + (c.muted === "inactive" ? " (inactiva)" : c.muted === "system" ? " (de sistema)" : "")}>
                <span className="w-[26px] shrink-0" aria-hidden><CardArt card={{ name: c.name, issuer: c.issuer, last4: c.last4, color: c.color, art: c.art }} bare className="!rounded-[4px] !shadow-none" /></span>
                <span>{shortCardName(c.name)}</span>
                {c.last4 && <span className="num text-[10px] text-faint">···{c.last4}</span>}
                {c.muted === "inactive" && <span className="text-[10px] text-faint">inactiva</span>}
                <span className="num text-[10px] text-faint" aria-label={`${c.count} movimientos`}>{c.count}</span>
              </Chip>
            ))}
          </div>
        ))}
      </ChipRow>
    </div>
  );
}

function PeriodChips() {
  const { view, update, today } = useTxFilters();
  const [customOpen, setCustomOpen] = useState(false);
  const [rangeErr, setRangeErr] = useState<string | null>(null);
  const preset = detectPreset(view, today);
  const customActive = !preset && !view.month && !!(view.from || view.to);
  const showCustom = customActive || customOpen;

  const pick = (id: PeriodPreset) => {
    setCustomOpen(false); setRangeErr(null);
    if (preset === id) return update({ month: null, from: null, to: null }); // tocar el activo lo quita
    const per = presetPeriod(id, todayLocal());
    update("month" in per ? { month: per.month, from: null, to: null } : { month: null, from: per.from, to: per.to });
  };
  const openCustom = () => {
    if (customActive) { setCustomOpen(false); setRangeErr(null); update({ month: null, from: null, to: null }); return; }
    setCustomOpen(true);
    const t = todayLocal();
    update({ month: null, from: addDays(t, -6), to: t });
  };
  const setDate = (key: "from" | "to", value: string) => {
    if (value && !isRealDate(value)) return;
    let from = key === "from" ? value || null : view.from;
    let to = key === "to" ? value || null : view.to;
    // Si las fechas quedan al revés, la otra se alinea con la que se acaba de elegir.
    if (from && to && from > to) { if (key === "from") to = from; else from = to; }
    const err = rangeError(from, to);
    setRangeErr(err);
    if (err) return;
    update({ month: null, from, to });
  };

  return (
    <div className="flex flex-col gap-2">
      <ChipRow label="Periodo" testId="period-chips">
        {PERIOD_PRESETS.map((p) => (
          <Chip key={p.id} active={preset === p.id} onClick={() => pick(p.id)} testId={`period-${p.id}`}>{p.label}</Chip>
        ))}
        <Chip active={customActive} onClick={openCustom} testId="period-custom">Personalizado</Chip>
      </ChipRow>
      {view.month && (
        <div className="flex items-center gap-1" role="group" aria-label="Mes" data-testid="month-nav">
          <button type="button" className="btn !h-10 !w-10 !p-0" aria-label="Mes anterior" onClick={() => update({ month: shiftMonth(view.month!, -1) })}><ChevronLeft size={15} aria-hidden /></button>
          <span className="min-w-[120px] text-center text-muted">{monthLabel(view.month)}</span>
          <button type="button" className="btn !h-10 !w-10 !p-0" aria-label="Mes siguiente" disabled={view.month >= today.slice(0, 7)} onClick={() => update({ month: shiftMonth(view.month!, 1) })}><ChevronRight size={15} aria-hidden /></button>
        </div>
      )}
      {showCustom && (
        <div className="grid grid-cols-2 gap-2 sm:max-w-[360px]" role="group" aria-label="Rango de fechas" data-testid="custom-range">
          <div>
            <label className="label" htmlFor="tx-from">Desde</label>
            <input id="tx-from" type="date" className="field !h-10" value={view.from ?? ""} max={view.to ?? undefined} onChange={(e) => setDate("from", e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="tx-to">Hasta</label>
            <input id="tx-to" type="date" className="field !h-10" value={view.to ?? ""} min={view.from ?? undefined} onChange={(e) => setDate("to", e.target.value)} />
          </div>
          {rangeErr && <p role="alert" className="col-span-2 text-[11px] text-down">{rangeErr}</p>}
        </div>
      )}
    </div>
  );
}

function Advanced({ categories }: { categories: FilterCategory[] }) {
  const { view, update } = useTxFilters();
  const toggleSource = (s: SourceId) => update({ sources: view.sources.includes(s) ? view.sources.filter((x) => x !== s) : [...view.sources, s] });
  return (
    <div id="tx-advanced" className="flex flex-col gap-3 rounded-2xl border border-line bg-black/20 p-3" data-testid="advanced-filters">
      <div className="sm:max-w-[360px]">
        <label htmlFor="tx-category" className="label">Categoría</label>
        <select id="tx-category" className="field !h-10" value={view.categoryId === null ? "" : String(view.categoryId)} onChange={(e) => update({ categoryId: e.target.value === "" ? null : e.target.value === "none" ? "none" : Number(e.target.value) })} data-testid="category-select">
          <option value="">Todas las categorías</option>
          <option value="none">Sin categoría</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <p className="mb-1.5 text-[11px] text-muted">Fuente <span className="text-faint">· un movimiento fusionado (p. ej. Atajo + correo) cuenta en ambas</span></p>
        <ChipRow label="Fuente" testId="source-chips">
          {SOURCE_IDS.map((s) => <Chip key={s} active={view.sources.includes(s)} onClick={() => toggleSource(s)} title={SOURCE_FILTER_HINT[s]} testId={`source-${s}`}>{SOURCE_FILTER_LABEL[s]}</Chip>)}
        </ChipRow>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:max-w-[360px]">
        <AmountField label="Monto mínimo" cents={view.minCents} onCommit={(c) => update({ minCents: c })} />
        <AmountField label="Monto máximo" cents={view.maxCents} onCommit={(c) => update({ maxCents: c })} />
      </div>
      <ChipRow label="Características" testId="flag-chips">
        <Chip active={view.unconfirmed} onClick={() => update({ unconfirmed: !view.unconfirmed })} testId="flag-unconfirmed" title="Tarjeta Banamex, solo Atajo y más de 24 h sin correo del banco">Sin confirmar</Chip>
        <Chip active={view.msi} onClick={() => update({ msi: !view.msi })} testId="flag-msi">Solo MSI</Chip>
        <Chip active={view.recurring} onClick={() => update({ recurring: !view.recurring })} testId="flag-recurring">Solo recurrentes</Chip>
      </ChipRow>
    </div>
  );
}

/** Barra de filtros dinámicos: todo se aplica al instante (sin botón "Filtrar") y queda en la URL (enlaces compartibles, botón atrás). */
export function TxFilterBar({ cards, categories }: { cards: FilterCard[]; categories: FilterCategory[] }) {
  const { view, update, clear, today } = useTxFilters();
  const [open, setOpen] = useState(() => advancedCount(view) > 0);
  const tags = activeTags(
    view,
    { cards: Object.fromEntries(cards.map((c) => [c.id, c.name])), categories: Object.fromEntries(categories.map((c) => [c.id, c.name])) },
    today,
  );
  const adv = advancedCount(view);
  return (
    <div className="mb-4 flex flex-col gap-3" role="search" aria-label="Filtrar transacciones" data-testid="tx-filters">
      <SearchBox />
      <PeriodChips />
      <CardChips cards={cards} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn !h-10" aria-expanded={open} aria-controls="tx-advanced" onClick={() => setOpen(!open)} data-testid="more-filters">
          <SlidersHorizontal size={14} aria-hidden /> Más filtros
          {adv > 0 && <span className="num rounded-full bg-accent px-1.5 text-[10px] leading-4 text-white" aria-label={`${adv} activos`}>{adv}</span>}
          <ChevronDown size={14} aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <div className="ml-auto">
          <label htmlFor="tx-sort" className="sr-only">Ordenar por</label>
          <select id="tx-sort" className="field !h-10 !w-auto" value={view.sort} onChange={(e) => update({ sort: e.target.value as TxSort })}>
            {SORT_IDS.map((s) => <option key={s} value={s}>{SORT_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      {open && <Advanced categories={categories} />}
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros activos" data-testid="active-tags">
          {tags.map((tag) => (
            <button key={tag.key} type="button" onClick={() => update(tag.remove)} aria-label={`Quitar filtro: ${tag.label}`} data-testid="active-tag" className="inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 pl-3 pr-2.5 text-[11px] hover:bg-accent/20 sm:min-h-8">
              <span className="truncate">{tag.label}</span><X size={12} aria-hidden className="shrink-0" />
            </button>
          ))}
          <button type="button" onClick={clear} className="inline-flex min-h-10 items-center rounded-full px-3 text-[11px] font-medium text-accent-2 hover:underline sm:min-h-8" data-testid="clear-filters">Limpiar filtros</button>
        </div>
      )}
    </div>
  );
}
