import Link from "next/link";
import { headers } from "next/headers";
import { IncomeEditor } from "@/components/IncomeEditor";
import { PayeesManager } from "@/components/PayeesManager";
import { listPayees } from "@/lib/repo/payees";
import { PageTitle, Panel } from "@/components/ui/Panel";
import { formatMXN } from "@/lib/money";
import { getMonthlyIncome } from "@/lib/repo/settings";
import { requirePageUser } from "@/lib/auth/page";
import { getEnv } from "@/lib/env";

export default async function Page() {
  const user = await requirePageUser();
  const env = getEnv();
  const [payees, income] = await Promise.all([listPayees(), getMonthlyIncome()]);
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const rows: [string, string][] = [
    ["Sesión", user.email],
    ["Modo de autenticación", env.AUTH_MODE === "dev" ? "dev (solo local)" : "App Service Authentication (Entra ID)"],
    ["Categorizador", env.CATEGORIZER === "jev" && env.OPENROUTER_API_KEY ? "Jev (reglas → historial → Jev)" : "Solo reglas"],
    ["Base de datos", env.DB_AUTH === "msi" ? "Azure SQL · Managed Identity" : "SQL Server local (docker)"],
  ];
  return (
    <>
      <PageTitle title="Configuración" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Mi ingreso mensual">
          <p className="num text-3xl font-semibold" data-testid="income-value">{income > 0 ? formatMXN(income) : "Sin configurar"}</p>
          <p className="mb-3 mt-1 text-muted">Con esto se calcula qué porcentaje de tu ingreso gastas, cuánto ahorras y la proyección de cada mes.</p>
          <IncomeEditor cents={income} variant="button" />
        </Panel>
        <Panel title="Instalar en tu celular">
          <ol className="list-decimal space-y-1.5 pl-5 text-muted">
            <li><b className="text-fg">iPhone:</b> abre esta página en Safari → Compartir → <b className="text-fg">Añadir a pantalla de inicio</b>.</li>
            <li><b className="text-fg">Android:</b> Chrome → menú ⋮ → <b className="text-fg">Instalar app</b>.</li>
          </ol>
          <p className="mt-3 text-[11px] text-faint">Se abre a pantalla completa con su propio ícono. Los datos siempre se leen en vivo; no se guardan en el dispositivo.</p>
        </Panel>
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
        <Panel title="Alertas y documentos">
          <p className="mb-3 text-muted">Ajusta cuándo te avisa la app (montos, reglas, comercios silenciados, horas de silencio) y a qué tarjeta corresponde cada estado de cuenta que subes.</p>
          <div className="flex flex-wrap gap-2">
            <Link href="/alertas" className="btn !h-10" data-testid="link-alert-settings">Configurar alertas</Link>
            <Link href="/documentos" className="btn !h-10">Documentos PDF</Link>
          </div>
        </Panel>
        <PayeesManager payees={payees} />
      </div>
    </>
  );
}
