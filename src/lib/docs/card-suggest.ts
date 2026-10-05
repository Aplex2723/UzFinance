import type { CardMap } from "@/lib/import/statements";
import type { Card } from "@/lib/types";

/**
 * Propone a qué tarjeta de la app corresponde cada estado, SOLO cuando es inequívoco (una única candidata):
 *  - amex → la única tarjeta Amex que no es "Adicional"; nu → la única Nu; débito → el único Banamex "Débito";
 *  - crédito Banamex (explora, costco…) → la única tarjeta Banamex cuyo nombre contiene el producto y no es "Virtual";
 *    su sección digital/virtual → la que dice "Virtual";
 *  - titulares adicionales → la tarjeta cuyo nombre trae el nombre de pila del titular.
 * Ante cualquier duda no propone nada y el usuario elige (nada se adivina). Es una función pura.
 */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

type DocLite = { card_key: string; transactions: { holder?: string | null; section?: string | null }[]; plans?: { holder?: string | null }[] };

const only = (cs: Card[]): string | null => (cs.length === 1 ? cs[0].name : null);

export function suggestCardMap(docs: DocLite[], cards: Card[], existing: CardMap | null): CardMap {
  const active = cards.filter((c) => c.active && c.name !== "Domiciliación" && c.name !== "Sin asignar");
  const out: CardMap = {};
  for (const key of new Set(docs.map((d) => d.card_key))) {
    if (existing?.[key]) continue;
    const mine = docs.filter((d) => d.card_key === key);
    let def: string | null = null;
    if (key === "amex") def = only(active.filter((c) => c.issuer === "amex" && !/adicional/i.test(c.name)));
    else if (key === "nu") def = only(active.filter((c) => c.issuer === "nu"));
    else if (key === "debito") def = only(active.filter((c) => c.issuer === "banamex" && /d[eé]bito/i.test(c.name)));
    else {
      const needle = fold(key).replace(/_/g, " ");
      def = only(active.filter((c) => c.issuer === "banamex" && fold(c.name).includes(needle) && !/virtual/i.test(c.name)));
    }
    if (!def) continue;
    const entry: CardMap[string] = { default: def };

    const sections = new Set(mine.flatMap((d) => d.transactions.map((t) => t.section)).filter((s): s is string => !!s));
    for (const s of ["digital", "virtual"]) {
      if (!sections.has(s)) continue;
      const v = only(active.filter((c) => c.issuer === "banamex" && /virtual/i.test(c.name) && fold(c.name).includes(fold(key).replace(/_/g, " "))));
      if (v) (entry.sections ??= {})[s] = v;
    }

    const holders = new Set([...mine.flatMap((d) => d.transactions.map((t) => t.holder)), ...mine.flatMap((d) => (d.plans ?? []).map((p) => p.holder))].filter((h): h is string => !!h && !["titular", "digital", "virtual"].includes(fold(h))));
    for (const h of holders) {
      const first = words(h)[0];
      if (!first) continue;
      const c = only(active.filter((x) => (key !== "amex" || x.issuer === "amex") && /adicional/i.test(x.name) && words(x.name).includes(first)));
      if (c) (entry.holders ??= {})[h] = c;
    }
    if (key === "debito" && cards.some((c) => c.name === "Domiciliación")) entry.domiciliation = "Domiciliación";
    out[key] = entry;
  }
  return out;
}
