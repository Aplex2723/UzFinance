import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import type { BankCardRef } from "@/lib/sources/banamex-email";
import { cardKey } from "@/lib/sources/banamex-email";
import type { Card } from "@/lib/types";

const COLS = "id, name, issuer, last4, aliases, color, art, active, needs_name";
type Row = Omit<Card, "active" | "needs_name"> & { active: boolean | number; needs_name: boolean | number };
const map = (r: Row): Card => ({ ...r, active: !!r.active, needs_name: !!r.needs_name });

export async function listCards(includeInactive = false): Promise<Card[]> {
  const rows = await query<Row>(`SELECT ${COLS} FROM dbo.cards ${includeInactive ? "" : "WHERE active = 1"} ORDER BY issuer, name`);
  return rows.map(map);
}

export async function getCard(id: number): Promise<Card | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM dbo.cards WHERE id=@id`, { id: t.int(id) });
  return rows[0] ? map(rows[0]) : null;
}

export type CardInput = Pick<Card, "name" | "issuer" | "last4" | "aliases" | "color"> & { art?: Card["art"]; active?: boolean };

export async function createCard(c: CardInput): Promise<Card> {
  try {
    const rows = await query<Row>(
      `INSERT dbo.cards (name, issuer, last4, aliases, color, art, active)
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.issuer, INSERTED.last4, INSERTED.aliases, INSERTED.color, INSERTED.art, INSERTED.active, INSERTED.needs_name
       VALUES (@name, @issuer, @last4, @aliases, @color, @art, @active)`,
      { name: t.str(c.name), issuer: t.varchar(c.issuer), last4: t.char(c.last4), aliases: t.str(c.aliases), color: t.varchar(c.color), art: t.varchar(c.art ?? null), active: t.bit(c.active ?? true) },
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
      `UPDATE dbo.cards SET name=@name, issuer=@issuer, last4=@last4, aliases=@aliases, color=@color, art=@art, active=@active, needs_name=0
       OUTPUT INSERTED.id, INSERTED.name, INSERTED.issuer, INSERTED.last4, INSERTED.aliases, INSERTED.color, INSERTED.art, INSERTED.active, INSERTED.needs_name
       WHERE id=@id`,
      { id: t.int(id), name: t.str(c.name), issuer: t.varchar(c.issuer), last4: t.char(c.last4), aliases: t.str(c.aliases), color: t.varchar(c.color), art: t.varchar(c.art ?? null), active: t.bit(c.active ?? true) },
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

/**
 * Tarjeta de un correo del banco. Clave = producto + adicional + dígitos (ver cardKey). Orden:
 *  1) ya existe por bank_key; 2) una tarjeta Banamex tuya con esos últimos dígitos (se adopta);
 *  3) se crea "sin nombrar" para que la nombres en el dashboard.
 */
export async function resolveBankCard(ref: BankCardRef): Promise<{ card: Card; created: boolean }> {
  if (ref.productUnknown) {
    // El correo no dice qué producto es: si solo una tarjeta Banamex activa termina en esos dígitos, es esa.
    const same = await query<Row>(
      `SELECT ${COLS} FROM dbo.cards WHERE issuer='banamex' AND last4=@d AND active=1 AND name <> @sys`,
      { d: t.varchar(ref.digits), sys: t.str(DOMICILIACION) },
    );
    if (same.length === 1) return { card: map(same[0]), created: false };
  }
  const key = cardKey(ref);
  const find = async () => (await query<Row>(`SELECT ${COLS} FROM dbo.cards WHERE bank_key=@k`, { k: t.varchar(key) }))[0];
  const hit = await find();
  if (hit) return { card: map(hit), created: false };

  const mine = await query<Row>(
    `SELECT ${COLS} FROM dbo.cards WHERE issuer='banamex' AND last4=@d AND bank_key IS NULL AND name <> @sys AND needs_name=0`,
    { d: t.varchar(ref.digits), sys: t.str(DOMICILIACION) },
  );
  if (mine.length === 1) {
    await query("UPDATE dbo.cards SET bank_key=@k WHERE id=@id AND bank_key IS NULL", { k: t.varchar(key), id: t.int(mine[0].id) });
    const again = await find();
    if (again) return { card: map(again), created: false };
  }

  const base = ref.variant === "additional" ? `${ref.product} Adicional` : ref.product;
  const color = ref.variant === "debit" ? "#38bdf8" : "#2b6fff";
  for (let n = 1; n <= 5; n++) {
    const name = `${base} ···${ref.digits}${n > 1 ? ` (${n})` : ""}`.slice(0, 60);
    try {
      const rows = await query<Row>(
        `INSERT dbo.cards (name, issuer, last4, aliases, color, active, needs_name, bank_key)
         OUTPUT ${COLS.split(", ").map((c) => `INSERTED.${c}`).join(", ")}
         VALUES (@name, 'banamex', @d, NULL, @color, 1, 1, @k)`,
        { name: t.str(name), d: t.varchar(ref.digits), color: t.varchar(color), k: t.varchar(key) },
      );
      return { card: map(rows[0]), created: true };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const raced = await find();
      if (raced) return { card: map(raced), created: false };
      // si fue el nombre, se reintenta con sufijo
    }
  }
  throw new Error("No se pudo crear la tarjeta");
}

/** Tarjeta de sistema para domiciliaciones: así los cargos de cuenta no crean una tarjeta por cada cuenta. */
export const DOMICILIACION = "Domiciliación";

export async function resolveDomiciliacionCard(): Promise<Card> {
  const find = async () => (await query<Row>(`SELECT ${COLS} FROM dbo.cards WHERE name=@n`, { n: t.str(DOMICILIACION) }))[0];
  const hit = await find();
  if (hit) return map(hit);
  try {
    return await createCard({ name: DOMICILIACION, issuer: "banamex", last4: null, aliases: null, color: "#38bdf8" });
  } catch (e) {
    if (e instanceof ConflictError) return map((await find())!);
    throw e;
  }
}

/** Tarjeta propia por últimos dígitos (pago de domiciliación → la tarjeta pagada). Solo si es inequívoca. */
export async function findCardByLast4(digits: string): Promise<Card | null> {
  const rows = await query<Row>(`SELECT ${COLS} FROM dbo.cards WHERE last4=@d AND active=1 AND name <> @sys`, { d: t.varchar(digits), sys: t.str(DOMICILIACION) });
  return rows.length === 1 ? map(rows[0]) : null;
}
