import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import type { Rule } from "@/lib/types";
import { ConflictError } from "./cards";

export const listRules = () =>
  query<Rule>("SELECT id, pattern, match_type, category_id, priority FROM dbo.category_rules ORDER BY priority DESC, LEN(pattern) DESC");

export async function createRule(r: Omit<Rule, "id">): Promise<Rule> {
  try {
    const rows = await query<Rule>(
      `INSERT dbo.category_rules (pattern, match_type, category_id, priority)
       OUTPUT INSERTED.id, INSERTED.pattern, INSERTED.match_type, INSERTED.category_id, INSERTED.priority
       VALUES (@pattern, @match, @cat, @prio)`,
      { pattern: t.str(normalizeMerchant(r.pattern)), match: t.varchar(r.match_type), cat: t.int(r.category_id), prio: t.int(r.priority) },
    );
    return rows[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Esa regla ya existe");
    if ((e as { number?: number }).number === 547) throw new ConflictError("La categoría no existe");
    throw e;
  }
}

export async function updateRule(id: number, r: Omit<Rule, "id">): Promise<Rule | null> {
  try {
    const rows = await query<Rule>(
      `UPDATE dbo.category_rules SET pattern=@pattern, match_type=@match, category_id=@cat, priority=@prio
       OUTPUT INSERTED.id, INSERTED.pattern, INSERTED.match_type, INSERTED.category_id, INSERTED.priority WHERE id=@id`,
      { id: t.int(id), pattern: t.str(normalizeMerchant(r.pattern)), match: t.varchar(r.match_type), cat: t.int(r.category_id), prio: t.int(r.priority) },
    );
    return rows[0] ?? null;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Esa regla ya existe");
    if ((e as { number?: number }).number === 547) throw new ConflictError("La categoría no existe");
    throw e;
  }
}

export async function deleteRule(id: number): Promise<boolean> {
  return (await query("DELETE dbo.category_rules OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) })).length > 0;
}
