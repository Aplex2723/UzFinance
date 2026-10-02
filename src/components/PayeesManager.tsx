"use client";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import type { Payee } from "@/lib/repo/payees";
import { Panel } from "./ui/Panel";

/** Comercios de domiciliación que son tarjetas tuyas: sus cargos son pago de tarjeta, no gasto. */
export function PayeesManager({ payees }: { payees: Payee[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, method: string, body?: unknown) {
    setError(null);
    const r = await apiFetch(path, method, body);
    if (!r.ok) setError(r.error);
    else router.refresh();
    return r.ok;
  }
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    if (await call("/api/payees", "POST", { pattern: String(new FormData(form).get("pattern")) })) form.reset();
  }

  return (
    <Panel title="Domiciliaciones que son pago de tarjeta">
      <p className="mb-3 text-muted">Si el comercio de una domiciliación contiene alguno de estos nombres, se registra como <b>pago de tarjeta</b> (fuera de tus gastos). Se ligan a la tarjeta por los dígitos de la referencia del correo.</p>
      {error && <p role="alert" className="mb-2 text-down">{error}</p>}
      <ul className="divide-y divide-line" aria-label="Pagadores propios">
        {payees.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-2" data-testid="payee-row">
            <span className="num">{p.pattern}</span>
            <button className="btn btn-danger !h-8 !w-8 !p-0" aria-label={`Quitar ${p.pattern}`} onClick={() => call(`/api/payees/${p.id}`, "DELETE")}><Trash2 size={13} /></button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="mt-3 flex gap-2">
        <input name="pattern" required minLength={2} maxLength={80} className="field" aria-label="Comercio" placeholder="Ej. BANAMEX TARJETA, NU MEXICO" />
        <button className="btn btn-primary">Agregar</button>
      </form>
    </Panel>
  );
}
