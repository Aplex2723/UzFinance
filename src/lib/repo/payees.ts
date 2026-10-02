import { isUniqueViolation, query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import { ConflictError } from "./cards";

export type Payee = { id: number; pattern: string };

export async function listPayees(): Promise<Payee[]> {
  return query<Payee>("SELECT id, pattern FROM dbo.own_payees ORDER BY pattern");
}

/** Comercios de domiciliación que son tarjetas mías (se guardan normalizados: MAYÚSCULAS, sin acentos). */
export async function createPayee(pattern: string): Promise<Payee> {
  const n = normalizeMerchant(pattern);
  if (n.length < 2) throw new ConflictError("Escribe al menos 2 caracteres");
  try {
    return (await query<Payee>("INSERT dbo.own_payees (pattern) OUTPUT INSERTED.id, INSERTED.pattern VALUES (@p)", { p: t.str(n) }))[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe");
    throw e;
  }
}

export async function deletePayee(id: number): Promise<boolean> {
  return (await query("DELETE dbo.own_payees OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) })).length > 0;
}
