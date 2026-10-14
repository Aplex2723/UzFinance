import { describe, expect, it } from "vitest";
import { suggestCardMap } from "@/lib/docs/card-suggest";
import type { Card } from "@/lib/types";

let id = 0;
const card = (name: string, issuer: Card["issuer"], o: Partial<Card> = {}): Card => ({ id: ++id, name, issuer, last4: null, aliases: null, color: "#000", art: null, active: true, needs_name: false, ...o });
const CARDS = [
  card("American Express Platinum", "amex"), card("Amex Adicional · América", "amex"), card("Amex Adicional · Marisol", "amex"),
  card("Explora Banamex ···046", "banamex"), card("Explora Banamex Virtual ···723", "banamex"), card("Costco Banamex ···194", "banamex"), card("Costco Banamex Virtual ···915", "banamex"),
  card("Débito ···296", "banamex"), card("Domiciliación", "banamex"), card("Nu Mastercard Gold", "nu"),
];
const doc = (card_key: string, txs: { holder?: string | null; section?: string | null }[] = []) => ({ card_key, transactions: txs });

describe("sugerencia de mapa estado → tarjeta", () => {
  it("propone cada tarjeta cuando es la única candidata", () => {
    const m = suggestCardMap([doc("amex"), doc("nu"), doc("debito"), doc("explora"), doc("costco")], CARDS, null);
    expect(m.amex.default).toBe("American Express Platinum");
    expect(m.nu.default).toBe("Nu Mastercard Gold");
    expect(m.debito).toEqual({ default: "Débito ···296", domiciliation: "Domiciliación" });
    expect(m.explora.default).toBe("Explora Banamex ···046"); // no la Virtual
    expect(m.costco.default).toBe("Costco Banamex ···194");
  });

  it("secciones digital/virtual y titulares adicionales se ligan por nombre", () => {
    const m = suggestCardMap([doc("explora", [{ section: "regular" }, { section: "digital" }]), doc("amex", [{ holder: "AMÉRICA PÉREZ LÓPEZ" }, { holder: "MARISOL RUIZ" }, { holder: "TITULAR EJEMPLO" }])], CARDS, null);
    expect(m.explora.sections).toEqual({ digital: "Explora Banamex Virtual ···723" });
    expect(m.amex.holders).toEqual({ "AMÉRICA PÉREZ LÓPEZ": "Amex Adicional · América", "MARISOL RUIZ": "Amex Adicional · Marisol" });
  });

  it("ante ambigüedad no propone nada: dos candidatas, ninguna, inactivas", () => {
    expect(suggestCardMap([doc("amex")], [...CARDS, card("Amex Gold", "amex")], null).amex).toBeUndefined();
    expect(suggestCardMap([doc("nu")], CARDS.filter((c) => c.issuer !== "nu"), null).nu).toBeUndefined();
    expect(suggestCardMap([doc("explora")], CARDS.map((c) => (c.name.startsWith("Explora Banamex ···046") ? { ...c, active: false } : c)), null).explora).toBeUndefined();
    expect(suggestCardMap([doc("oro_ficticia")], CARDS, null)).toEqual({});
    // dos adicionales con el mismo nombre de pila: el titular no se asigna
    const dup = [...CARDS, card("Amex Adicional · América 2", "amex")];
    expect(suggestCardMap([doc("amex", [{ holder: "AMÉRICA X" }])], dup, null).amex.holders).toBeUndefined();
  });

  it("nunca pisa lo que ya está mapeado", () => {
    const existing = { amex: { default: "Amex Gold" } };
    expect(suggestCardMap([doc("amex"), doc("nu")], CARDS, existing)).toEqual({ nu: { default: "Nu Mastercard Gold" } });
  });

  it("una compra de crédito Banamex con otro producto se liga por nombre ('oro_ficticia' → 'Oro Ficticia')", () => {
    const m = suggestCardMap([doc("oro_ficticia")], [...CARDS, card("Oro Ficticia Banamex ···111", "banamex")], null);
    expect(m.oro_ficticia.default).toBe("Oro Ficticia Banamex ···111");
  });
});
