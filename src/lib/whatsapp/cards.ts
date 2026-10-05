import { DOMICILIACION, listCards } from "@/lib/repo/cards";
import type { Card } from "@/lib/types";

/**
 * Tarjetas contra las que se puede registrar un gasto por WhatsApp: las ACTIVAS de la app, sin las de sistema.
 * Todo el emparejamiento es determinista (sin LLM): nombre, alias, terminación y sinónimos del emisor/producto.
 */
export type CardLite = Pick<Card, "id" | "name" | "issuer" | "last4" | "aliases" | "art">;

const SYSTEM_CARDS = new Set([DOMICILIACION, "Sin asignar"]);

export async function eligibleCards(): Promise<Card[]> {
  return (await listCards()).filter((c) => !SYSTEM_CARDS.has(c.name));
}

/** Minúsculas y sin acentos, conservando la longitud (posición a posición) para poder recortar el texto original con los mismos índices. */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch.length !== 1) {
      out += ch;
      continue;
    }
    const d = ch.normalize("NFD");
    const base = d.length > 1 && /^\p{M}+$/u.test(d.slice(1)) ? d[0] : ch;
    const lc = base.toLowerCase();
    out += lc.length === 1 ? lc : base;
  }
  return out;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Palabras de emisor (en minúsculas, sin acentos) → clave del emisor. */
const ISSUER_WORDS: Record<string, string[]> = {
  amex: ["amex", "american express", "americanexpress"],
  banamex: ["banamex", "citibanamex"],
  nu: ["nu", "nubank"],
};
const issuerOfWord = (w: string) => Object.entries(ISSUER_WORDS).find(([, ws]) => ws.includes(w))?.[0] ?? null;

/** Sinónimos de productos (palabra del nombre → otras formas de decirla). */
const SYNONYMS: Record<string, string[]> = { debito: ["tdd", "debit"], clasica: ["classic"], platinum: ["plat"] };
const STOP = new Set(["tarjeta", "credito", "de", "del", "la", "el", "y", "card", "banco", "mi", "cuenta", "con"]);
/** Palabras que también son comercios: solo cuentan como tarjeta si vienen después de "con", "tarjeta", "tdc"… */
const NEEDS_CONTEXT = new Set(["costco"]);
const CONTEXT_BEFORE = /(?:^|[\s,;])(?:con|tarjeta|tdc|tdd|usando|uso|pague con|pagado con)\s+(?:(?:la|el|mi|su|tu|esa|esta)\s+)?$/;

const ART_WORD: Record<string, string> = { "banamex-debito": "debito", "banamex-explora": "explora", "banamex-clasica": "clasica", "banamex-costco": "costco", "amex-platinum": "platinum" };

type Keys = { strong: string[]; groups: Map<string, string[]> };

/** Sin la terminación del nombre ("Débito ···296" → "debito"). */
const cleanName = (name: string) => fold(name).replace(/[·•*.]+\s*\d+/g, " ").replace(/(?<![\p{L}\p{N}])\d{3,4}(?![\p{L}\p{N}])/gu, " ").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function keysOf(c: CardLite): Keys {
  const strong: string[] = [];
  const groups = new Map<string, string[]>();
  const addGroup = (id: string, phrases: string[]) => groups.set(id, [...new Set([...(groups.get(id) ?? []), ...phrases])]);
  const nameClean = cleanName(c.name);
  if (nameClean) strong.push(nameClean);
  for (const a of (c.aliases ?? "").split(",")) {
    const al = fold(a).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (al.length >= 2) strong.push(al);
  }
  if (c.issuer in ISSUER_WORDS) addGroup(`i:${c.issuer}`, ISSUER_WORDS[c.issuer]);
  for (const w of nameClean.split(" ")) {
    if (!w || STOP.has(w) || /^\d+$/.test(w)) continue;
    const iss = issuerOfWord(w);
    if (iss) addGroup(`i:${iss}`, ISSUER_WORDS[iss]);
    else if (w.length >= 3) addGroup(`w:${w}`, [w, ...(SYNONYMS[w] ?? [])]);
  }
  const artWord = c.art ? ART_WORD[c.art] : undefined;
  if (artWord) addGroup(`w:${artWord}`, [artWord, ...(SYNONYMS[artWord] ?? [])]);
  return { strong: [...new Set(strong)], groups };
}

/** ¿Los dígitos escritos son la terminación de esa tarjeta? (3 o 4 dígitos; compara por sufijo para tolerar "296" vs "0296"). */
export const endsWithLast4 = (last4: string | null, hint: string) => {
  const a = (last4 ?? "").trim();
  return a.length >= 3 && hint.length >= 3 && (a === hint || a.endsWith(hint) || hint.endsWith(a));
};

/**
 * ¿Justo antes de la posición `at` de `f` (texto ya en `fold`) se nombra una tarjeta cuya terminación son esos dígitos?
 * ("amex 1005", "banamex 046", "con la explora 046"). Es la marca que permite leer una cifra de 3-4 dígitos como terminación aunque
 * no diga "tarjeta"/"terminación". Palabras que también son comercios ("costco") no cuentan por sí solas.
 */
export function namesCardBefore(f: string, at: number, digits: string, cards: CardLite[]): boolean {
  const before = f.slice(Math.max(0, at - 60), at).replace(/[\s*·•.#:-]+$/u, "");
  for (const c of cards) {
    if (!endsWithLast4(c.last4, digits)) continue;
    const k = keysOf(c);
    const phrases = [...k.strong, ...[...k.groups.values()].flat()].filter((p) => p && !NEEDS_CONTEXT.has(p));
    if (phrases.some((p) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(p).replace(/\s+/g, "\\s+")}$`, "u").test(before))) return true;
  }
  return false;
}

type Span = [number, number];
const free =(mask: boolean[], a: number, b: number) => {
  for (let i = a; i < b; i++) if (mask[i]) return false;
  return true;
};

/** Apariciones de una frase (con límites de palabra) en zonas no reclamadas. */
function find(f: string, mask: boolean[], phrase: string): Span[] {
  if (!phrase) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(phrase).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "gu");
  const out: Span[] = [];
  for (const m of f.matchAll(re)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (!free(mask, a, b)) continue;
    if (NEEDS_CONTEXT.has(phrase) && !CONTEXT_BEFORE.test(f.slice(Math.max(0, a - 30), a))) continue;
    out.push([a, b]);
  }
  return out;
}

export type CardMatch = {
  /** Tarjetas candidatas, en el orden de `cards`. 1 = inequívoca; varias = preguntar; 0 = ninguna. */
  ids: number[];
  /** Zonas del texto que nombraban la tarjeta (para quitarlas del comercio). */
  spans: Span[];
  /** Se escribió una terminación y ninguna tarjeta activa la tiene. */
  unmatchedHint: string | null;
};

/**
 * Empareja el texto (ya en `fold`) con las tarjetas. Puntaje: coincidencia fuerte (terminación, nombre completo o alias) = 10, cada
 * grupo suave (emisor o palabra distintiva del nombre/producto) = 1; gana el mayor. Si la terminación y el nombre apuntan a
 * tarjetas distintas, se pregunta entre ambas en vez de adivinar.
 */
export function matchCards(f: string, mask: boolean[], cards: CardLite[], hints: string[]): CardMatch {
  const score = new Map<number, number>();
  const spans = new Map<number, Span[]>();
  for (const c of cards) {
    const k = keysOf(c);
    let s = 0;
    const sp: Span[] = [];
    for (const phrase of k.strong) {
      const hit = find(f, mask, phrase);
      if (hit.length) {
        s += 10;
        sp.push(...hit);
      }
    }
    for (const phrases of k.groups.values()) {
      const hits = phrases.flatMap((p) => find(f, mask, p));
      if (hits.length) {
        s += 1;
        sp.push(...hits);
      }
    }
    if (s > 0) {
      score.set(c.id, s);
      spans.set(c.id, sp);
    }
  }
  const best = (ids: number[]) => {
    const max = Math.max(...ids.map((i) => score.get(i) ?? 0));
    return ids.filter((i) => (score.get(i) ?? 0) === max);
  };
  const named = cards.filter((c) => score.has(c.id)).map((c) => c.id);
  const hinted = hints.length ? cards.filter((c) => hints.some((h) => endsWithLast4(c.last4, h))).map((c) => c.id) : [];

  let ids: number[];
  let unmatchedHint: string | null = null;
  if (hints.length && !hinted.length) {
    ids = [];
    unmatchedHint = hints[0];
  } else if (hinted.length) {
    const inter = hinted.filter((i) => named.includes(i));
    if (inter.length) ids = best(inter);
    else if (named.length) ids = [...new Set([...hinted, ...best(named)])];
    else ids = hinted;
  } else {
    ids = named.length ? best(named) : [];
  }
  // Dos tarjetas nombradas ("amex nu"): si tras elegir la ganadora queda sin reclamar la palabra (emisor/nombre) de otra, el texto
  // nombraba más de una tarjeta y NO se adivina: todas las nombradas (y las de terminación) pasan a ser candidatas y se pregunta.
  if (ids.length && named.length >= 2) {
    const winSpans = ids.flatMap((i) => spans.get(i) ?? []);
    const overlaps = (a: Span) => winSpans.some((w) => a[0] < w[1] && w[0] < a[1]);
    const unclaimed = named.some((i) => !ids.includes(i) && (spans.get(i) ?? []).some((sp) => !overlaps(sp)));
    if (unclaimed) ids = [...new Set([...ids, ...named, ...hinted])];
  }
  const ordered = cards.filter((c) => ids.includes(c.id)).map((c) => c.id);
  return { ids: ordered, spans: ordered.flatMap((i) => spans.get(i) ?? []), unmatchedHint };
}

/** Nombre para mostrar en listas: "Débito ···296" ya trae la terminación; si no, se agrega. */
export function cardLabel(c: CardLite): string {
  const base = c.name.replace(/\s+/g, " ").trim();
  return c.last4 && !base.includes(c.last4) ? `${base} (···${c.last4})` : base;
}
