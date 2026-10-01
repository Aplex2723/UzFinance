import { CategoriesManager } from "@/components/CategoriesManager";
import { PageTitle } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { listCategories } from "@/lib/repo/categories";
import { listRules } from "@/lib/repo/rules";

export default async function Page() {
  await requirePageUser();
  const [categories, rules] = await Promise.all([listCategories(), listRules()]);
  return (
    <>
      <PageTitle title="Categorías" subtitle="Las reglas se evalúan por prioridad y, a igual prioridad, gana el patrón más específico." />
      <CategoriesManager categories={categories} rules={rules} />
    </>
  );
}
