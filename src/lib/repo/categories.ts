import { isUniqueViolation, query, t } from "@/lib/db/pool";
import type { Category } from "@/lib/types";
import { ConflictError } from "./cards";

export const listCategories = () => query<Category>("SELECT id, name, color, description FROM dbo.categories ORDER BY name");

export type CategoryInput = Pick<Category, "name" | "color"> & { description?: string | null };

export async function createCategory(c: CategoryInput): Promise<Category> {
  try {
    const r = await query<Category>(
      "INSERT dbo.categories (name, color, description) OUTPUT INSERTED.id, INSERTED.name, INSERTED.color, INSERTED.description VALUES (@name, @color, @desc)",
      { name: t.str(c.name), color: t.varchar(c.color), desc: t.str(c.description ?? null) },
    );
    return r[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe una categoría con ese nombre");
    throw e;
  }
}

export async function updateCategory(id: number, c: CategoryInput): Promise<Category | null> {
  try {
    const r = await query<Category>(
      "UPDATE dbo.categories SET name=@name, color=@color, description = CASE WHEN @hasdesc = 1 THEN @desc ELSE description END OUTPUT INSERTED.id, INSERTED.name, INSERTED.color, INSERTED.description WHERE id=@id",
      { id: t.int(id), name: t.str(c.name), color: t.varchar(c.color), desc: t.str(c.description ?? null), hasdesc: t.bit(c.description !== undefined) },
    );
    return r[0] ?? null;
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe una categoría con ese nombre");
    throw e;
  }
}

/** Las transacciones quedan sin categoría (FK ON DELETE SET NULL); las reglas se eliminan en cascada. */
export async function deleteCategory(id: number): Promise<boolean> {
  const r = await query("DELETE dbo.categories OUTPUT DELETED.id WHERE id=@id", { id: t.int(id) });
  return r.length > 0;
}
