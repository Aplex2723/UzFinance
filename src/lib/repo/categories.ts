import { isUniqueViolation, query, t } from "@/lib/db/pool";
import type { Category } from "@/lib/types";
import { ConflictError } from "./cards";

export const listCategories = () => query<Category>("SELECT id, name, color FROM dbo.categories ORDER BY name");

export async function createCategory(c: Omit<Category, "id">): Promise<Category> {
  try {
    const r = await query<Category>(
      "INSERT dbo.categories (name, color) OUTPUT INSERTED.id, INSERTED.name, INSERTED.color VALUES (@name, @color)",
      { name: t.str(c.name), color: t.varchar(c.color) },
    );
    return r[0];
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("Ya existe una categoría con ese nombre");
    throw e;
  }
}

export async function updateCategory(id: number, c: Omit<Category, "id">): Promise<Category | null> {
  try {
    const r = await query<Category>(
      "UPDATE dbo.categories SET name=@name, color=@color OUTPUT INSERTED.id, INSERTED.name, INSERTED.color WHERE id=@id",
      { id: t.int(id), name: t.str(c.name), color: t.varchar(c.color) },
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
