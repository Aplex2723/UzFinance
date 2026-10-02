import { headers } from "next/headers";
import { PayeesManager } from "@/components/PayeesManager";
import { listPayees } from "@/lib/repo/payees";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { requirePageUser } from "@/lib/auth/page";
import { getEnv } from "@/lib/env";

export default async function Page() {
  const user = await requirePageUser();
  const env = getEnv();
  const payees = await listPayees();
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const rows: [string, string][] = [
    ["Sesión", user.email],
    ["Modo de autenticación", env.AUTH_MODE === "dev" ? "dev (solo local)" : "App Service Authentication (Entra ID)"],
    ["Categorizador", env.CATEGORIZER === "llm" ? "LLM (stub → reglas)" : "Reglas"],
    ["Base de datos", env.DB_AUTH === "msi" ? "Azure SQL · Managed Identity" : "SQL Server local (docker)"],
  ];
  return (
    <>
      <PageTitle title="Configuración" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Estado">
          <dl className="divide-y divide-line">
            {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4 py-2.5"><dt className="text-muted">{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
          </dl>
        </Panel>
        <Panel title="Ingesta desde el Atajo de iPhone">
          <p className="mb-2 text-muted">Endpoint (POST, JSON):</p>
          <code className="block break-all rounded-lg bg-black/40 p-2.5">{proto}://{host}/api/ingest</code>
          <p className="mt-3 text-muted">Header: <code className="text-fg">Authorization: Bearer &lt;INGEST_TOKEN&gt;</code></p>
          <p className="mt-3 text-[11px] text-muted">El token nunca se muestra aquí. Se guarda como app setting y se rota con el procedimiento del README (sección “Rotación del token”).</p>
        </Panel>
        <PayeesManager payees={payees} />
      </div>
    </>
  );
}
