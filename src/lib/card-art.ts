import type { CardArtId, Issuer } from "./types";

export const CARD_ART_IDS = ["amex-platinum", "banamex-explora", "banamex-clasica", "banamex-debito", "nu", "generic"] as const;

export const CARD_ART_LABEL: Record<CardArtId, string> = {
  "amex-platinum": "American Express Platinum",
  "banamex-explora": "Banamex Explora",
  "banamex-clasica": "Banamex Clásica",
  "banamex-debito": "Banamex Débito",
  nu: "Nu",
  generic: "Genérica (usa el color)",
};

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Diseño que se muestra: el elegido, o uno deducido del emisor y del nombre. */
export function resolveArt(card: { art: CardArtId | null; issuer: Issuer; name: string }): CardArtId {
  if (card.art) return card.art;
  const n = plain(card.name);
  if (card.issuer === "amex") return "amex-platinum";
  if (card.issuer === "nu") return "nu";
  if (card.issuer === "banamex") {
    if (n.includes("explora")) return "banamex-explora";
    if (n.includes("debito")) return "banamex-debito";
    if (n.includes("clasica")) return "banamex-clasica";
  }
  return "generic";
}
