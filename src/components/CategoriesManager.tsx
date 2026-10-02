"use client";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { Category, Rule } from "@/lib/types";
import { Panel } from "./ui/Panel";

const MATCH = { contains: "contiene", startswith: "empieza con", exact: "es exactamente" } as const;

export function CategoriesManager({ categories, rules }: { categories: Category[]; rules: Rule[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const byId = new Map(categories.map((c) => [c.id, c]));

  async function call(path: string, method: string, body?: unknown) {
    setError(null);
    const r = await apiFetch(path, method, body);
    if (!r.ok) setError(r.error);
    else router.refresh();
    return r.ok;
  }

  async function addCategory(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (await call("/api/categories", "POST", { name: String(f.get("name")), color: String(f.get("color")) })) form.reset();
  }
  async function addRule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (await call("/api/rules", "POST", { pattern: String(f.get("pattern")), match_type: String(f.get("match_type")), category_id: Number(f.get("category_id")), priority: Number(f.get("priority") || 0) })) form.reset();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {error && <p role="alert" className="text-down lg:col-span-2">{error}</p>}
      <Panel title="Categorías">
        <ul className="mb-4 divide-y divide-line">
          {categories.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
              <input type="color" aria-label={`Color de ${c.name}`} defaultValue={c.color} className="h-7 w-7 cursor-pointer rounded-md border border-line bg-transparent" onBlur={(e) => e.target.value !== c.color && call(`/api/categories/${c.id}`, "PUT", { name: c.name, color: e.target.value })} />
              <input aria-label={`Nombre de ${c.name}`} defaultValue={c.name} maxLength={60} className="field !h-8 flex-1" onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && call(`/api/categories/${c.id}`, "PUT", { name: e.target.value, color: c.color })} />
              <button className="btn btn-danger !h-8 !w-8 !p-0" aria-label={`Eliminar ${c.name}`} onClick={() => window.confirm(`¿Eliminar "${c.name}"? Sus movimientos quedarán sin categoría.`) && call(`/api/categories/${c.id}`, "DELETE")}><Trash2 size={13} /></button>
              <textarea
                aria-label={`Descripción de ${c.name}`}
                defaultValue={c.description ?? ""}
                rows={2}
                maxLength={400}
                placeholder="Ejemplos de comercios de esta categoría (la IA los usa para clasificar)"
                className="field !h-auto w-full resize-none py-1.5 text-[11px] text-muted"
                onBlur={(e) => e.target.value.trim() !== (c.description ?? "") && call(`/api/categories/${c.id}`, "PUT", { name: c.name, color: c.color, description: e.target.value })}
              />
            </li>
          ))}
        </ul>
        <form onSubmit={addCategory} className="flex gap-2" aria-label="Nueva categoría">
          <input name="color" type="color" defaultValue="#ff4d1c" aria-label="Color" className="h-[38px] w-11 rounded-lg border border-line bg-transparent p-1" />
          <input name="name" required maxLength={60} placeholder="Nueva categoría" className="field flex-1" aria-label="Nombre" />
          <button className="btn btn-primary !h-[38px]">Agregar</button>
        </form>
      </Panel>

      <Panel title="Reglas de categorización (comercio → categoría)">
        <ul className="mb-4 max-h-[420px] divide-y divide-line overflow-y-auto">
          {rules.length === 0 && <li className="py-4 text-center text-muted">Sin reglas.</li>}
          {rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 truncate"><span className="text-muted">{MATCH[r.match_type]}</span> <b>{r.pattern}</b></span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-[11px]"><span className="h-1.5 w-1.5 rounded-full" style={{ background: byId.get(r.category_id)?.color }} />{byId.get(r.category_id)?.name}</span>
              <button className="btn btn-danger !h-8 !w-8 !p-0" aria-label={`Eliminar regla ${r.pattern}`} onClick={() => call(`/api/rules/${r.id}`, "DELETE")}><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
        <form onSubmit={addRule} className="grid gap-2 sm:grid-cols-2" aria-label="Nueva regla">
          <input name="pattern" required minLength={2} maxLength={120} placeholder="Texto del comercio (ej. STARBUCKS)" className="field sm:col-span-2" aria-label="Patrón" />
          <select name="match_type" className="field" aria-label="Tipo de coincidencia"><option value="contains">contiene</option><option value="startswith">empieza con</option><option value="exact">es exactamente</option></select>
          <select name="category_id" required className="field" aria-label="Categoría">{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <input name="priority" type="number" min={-1000} max={1000} defaultValue={0} className="field" aria-label="Prioridad" />
          <button className="btn btn-primary !h-[38px]">Agregar regla</button>
        </form>
        <p className="mt-3 text-[11px] text-muted">Orden: tus reglas → comercios que ya categorizaste tú → la IA (Jev, usando la descripción de cada categoría). Las reglas aplican a movimientos nuevos; para los existentes sin categoría usa “Categorizar” en Inicio.</p>
      </Panel>
    </div>
  );
}
