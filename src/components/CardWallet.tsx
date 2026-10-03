"use client";

import { ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { resolveArt } from "@/lib/card-art";
import { ISSUER_LABEL } from "@/lib/format";
import { formatMXN } from "@/lib/money";
import type { CardArtId, Issuer } from "@/lib/types";
import { CardArt } from "./CardArt";
import { Sparkline } from "./charts/Sparkline";
import { Delta } from "./ui/Delta";

export type WalletCard = {
  id: number;
  name: string;
  issuer: Issuer;
  last4: string | null;
  color: string;
  art: CardArtId | null;
  cents: number;
  prevCents: number;
  deltaPct: number | null;
  spark: number[];
};

const ORDER: Issuer[] = ["amex", "banamex", "nu", "other"];
const PEEK = 16; // px que asoma cada tarjeta de atrás

/** Diseños que van al frente del montón: las tarjetas de crédito con foto antes que el débito o las genéricas. */
const FRONT: CardArtId[] = ["banamex-explora", "banamex-costco", "amex-platinum", "nu", "banamex-clasica", "banamex-debito", "generic"];

/** Hasta 3 diseños distintos (los de crédito primero, y entre iguales los de más gasto) para el montón del tarjetero. */
function stackOf(cards: WalletCard[]): WalletCard[] {
  const seen = new Set<string>();
  const out: WalletCard[] = [];
  const rank = (c: WalletCard) => FRONT.indexOf(resolveArt(c));
  for (const c of [...cards].sort((a, b) => rank(a) - rank(b) || b.cents - a.cents)) {
    const art = resolveArt(c);
    if (seen.has(art)) continue;
    seen.add(art);
    out.push(c);
    if (out.length === 3) break;
  }
  return out;
}

function sumSpark(cards: WalletCard[]): number[] {
  const len = Math.max(0, ...cards.map((c) => c.spark.length));
  return Array.from({ length: len }, (_, i) => cards.reduce((a, c) => a + (c.spark[i] ?? 0), 0));
}

function Stack({ cards }: { cards: WalletCard[] }) {
  const n = cards.length;
  // Misma altura en todos los bancos (frente alineado): siempre se reservan 2 franjas de "asomo".
  return (
    <div className="relative" style={{ paddingTop: 2 * PEEK }} aria-hidden>
      {cards.map((c, k) =>
        k === 0 ? (
          <div key={c.id} className="relative" style={{ zIndex: n }}><CardArt card={c} compact bare /></div>
        ) : (
          <div key={c.id} className="absolute brightness-[.8]" style={{ top: (2 - k) * PEEK, left: `${k * 3}%`, right: `${k * 3}%`, zIndex: n - k }}>
            <CardArt card={c} compact bare />
          </div>
        ),
      )}
    </div>
  );
}

/** Tarjetero: un montón por banco; al tocarlo se despliegan sus tarjetas con el detalle. */
export function CardWallet({ cards }: { cards: WalletCard[] }) {
  const [open, setOpen] = useState<Issuer | null>(null);
  const groups = ORDER.map((issuer) => {
    const list = cards.filter((c) => c.issuer === issuer);
    const cents = list.reduce((a, c) => a + c.cents, 0);
    const prevCents = list.reduce((a, c) => a + c.prevCents, 0);
    return { issuer, list, cents, prevCents, spark: sumSpark(list) };
  }).filter((g) => g.list.length > 0);
  const shown = groups.find((g) => g.issuer === open);

  return (
    <section aria-label="Tarjetas" className="flex flex-col gap-3">
      <div className={`grid gap-3 ${groups.length >= 4 ? "sm:grid-cols-2 xl:grid-cols-4" : "sm:grid-cols-3"}`}>
        {groups.map((g) => {
          const label = ISSUER_LABEL[g.issuer];
          const isOpen = g.issuer === open;
          return (
            <button
              key={g.issuer}
              type="button"
              aria-expanded={isOpen}
              aria-controls="wallet-detail"
              aria-label={`${label}: ${g.list.length} ${g.list.length === 1 ? "tarjeta" : "tarjetas"}, ${formatMXN(g.cents)} este mes`}
              onClick={() => setOpen(isOpen ? null : g.issuer)}
              data-testid={`wallet-${g.issuer}`}
              className={`glass flex flex-col gap-3 p-3 text-left transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 ${isOpen ? "ring-1 ring-white/30" : "hover:ring-1 hover:ring-white/15"}`}
            >
              <Stack cards={stackOf(g.list)} />
              <div className="flex items-end justify-between gap-2 px-1">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-[12px] text-muted">
                    <span className="font-medium text-fg">{label}</span> · {g.list.length} {g.list.length === 1 ? "tarjeta" : "tarjetas"}
                    <ChevronDown size={13} aria-hidden className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </p>
                  <p className="num mt-0.5 text-2xl font-semibold">{formatMXN(g.cents, { compact: true })}</p>
                  <div className="mt-1"><Delta pct={g.prevCents > 0 ? ((g.cents - g.prevCents) / g.prevCents) * 100 : null} label="sin base" /></div>
                </div>
                <div className="w-[88px] shrink-0"><Sparkline values={g.spark} label={label} color={g.prevCents > 0 && g.cents > g.prevCents ? "#ef4444" : "#22c55e"} /></div>
              </div>
            </button>
          );
        })}
      </div>

      {shown && (
        <div id="wallet-detail" role="region" aria-label={`Tarjetas ${ISSUER_LABEL[shown.issuer]}`} className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4">
          {shown.list.map((c) => (
            <article key={c.id} className="glass flex w-[236px] shrink-0 snap-start flex-col gap-3 p-3 sm:w-auto" aria-label={c.name}>
              <CardArt card={c} />
              <div className="flex items-end justify-between gap-2 px-1">
                <div>
                  <p className="num text-2xl font-semibold">{formatMXN(c.cents, { compact: true })}</p>
                  <div className="mt-1"><Delta pct={c.deltaPct} label="sin base" /></div>
                </div>
                <div className="w-[88px]"><Sparkline values={c.spark} label={c.name} color={c.deltaPct !== null && c.deltaPct > 0 ? "#ef4444" : "#22c55e"} /></div>
              </div>
            </article>
          ))}
        </div>
      )}

      <Link href="/tarjetas?new=1" className="inline-flex items-center gap-2 self-start rounded-full border border-dashed border-line px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-white/25 hover:text-fg">
        <Plus size={14} aria-hidden /> Agregar otra tarjeta a tu cuenta
      </Link>
    </section>
  );
}
