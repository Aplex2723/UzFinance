import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import type { Card } from "@/lib/types";

const COLS = "id, name, issuer, last4, aliases, color, active";
type Row = Omit<Card, "active"> & { active: boolean | number };
const map = (r: Row): Card => ({ ...r, active: !!r.active });

export async function listCards(includeInactive = false): Promise<Card[]> {
  const rows = await query<Row>(`SELECT ${COLS} FROM dbo.cards ${includeInactive ? "" : "WHERE active = 1"} ORDER BY issuer, name`);
  return rows.map(map);
}

export type CardInput = Pick<Card, "name" | "issuer" | "last4" | "aliases" | "color"> & { active?: boolean };

export async function createCard(c: CardInput): Promise<Card> {
  try {
    const rows = await query<Row>(
      `INSERT dbo.cards (name, issuer, last4, aliases, color, active)
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.issuer, INSERTED.last4, INSERTED.aliases, INSERTED.color, INSERTED.active
       VALUES (@name, @issuer, @last4, @aliases, @color, @active)`,
      { name: t.str(c.name), issuer: t.varchar(c.issuer), last4: t.char(c.last4), aliases: t.str(c.aliases), color: t.varchar(c.color), active: t.bit(c.active ?? true) },
    );
    return map(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe una tarjeta con ese nombre");
    throw e;
  }
}

export async function updateCard(id: number, c: CardInput): Promise<Card | null> {
  try {
    const rows = await query<Row>(
      `UPDATE dbo.cards SET name=@name, issuer=@issuer, last4=@last4, aliases=@aliases, color=@color, active=@active
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.issuer, INSERTED.last4, INSERTED.aliases, INSERTED.color, INSERTED.active
       WHERE id=@id`,
      { id: t.int(id), name: t.str(c.name), issuer: t.varchar(c.issuer), last4: t.char(c.last4), aliases: t.str(c.aliases), color: t.varchar(c.color), active: t.bit(c.active ?? true) },
    );
    return rows[0] ? map(rows[0]) : null;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe una tarjeta con ese nombre");
    throw e;
  }
}

/** Una tarjeta con transacciones se desactiva en vez de borrarse (FK + historial). */
export async function deleteCard(id: number): Promise<"deleted" | "deactivated" | "missing"> {
  const used = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions WHERE card_id=@id", { id: t.int(id) });
  if (used[0].n > 0) {
    const r = await query("UPDATE dbo.cards SET active=0 OUTPUT INSERTED.id WHERE id=@id", { id: t.int(id) });
    return r.length ? "deactivated" : "missing";
  }
  const r = await query("DELETE dbo.cards OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) });
  return r.length ? "deleted" : "missing";
}

export class ConflictError extends Error {}

const UNASSIGNED = "Sin asignar";

/** Resuelve el texto que manda Wallet/CSV a una tarjeta: nombre, alias o últimos 4. */
export function matchCard(cards: Card[], ref: string): Card | null {
  const n = normalizeMerchant(ref);
  const digits = /(\d{4})\D*$/.exec(ref)?.[1];
  for (const c of cards) {
    if (normalizeMerchant(c.name) === n) return c;
    const aliases = (c.aliases ?? "").split(",").map((a) => normalizeMerchant(a)).filter(Boolean);
    if (aliases.includes(n)) return c;
  }
  if (digits) {
    const byLast4 = cards.filter((c) => c.last4 === digits);
    if (byLast4.length === 1) return byLast4[0];
  }
  return null;
}

export async function resolveCard(ref: string): Promise<{ card: Card; matched: boolean }> {
  const cards = await listCards(true);
  const found = matchCard(cards, ref);
  if (found) return { card: found, matched: true };
  const existing = cards.find((c) => c.name === UNASSIGNED);
  if (existing) return { card: existing, matched: false };
  try {
    return { card: await createCard({ name: UNASSIGNED, issuer: "other", last4: null, aliases: null, color: "#6b7280" }), matched: false };
  } catch (e) {
    if (e instanceof ConflictError) {
      const again = (await listCards(true)).find((c) => c.name === UNASSIGNED)!;
      return { card: again, matched: false };
    }
    throw e;
  }
}
