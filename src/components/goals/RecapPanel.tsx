"use client";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import { Panel } from "../ui/Panel";
import { MiniMarkdown } from "./MiniMarkdown";

export type RecapView = { text: string; at: string; model: string };

/** Resumen con IA de las metas: se genera a pedido (cuesta una llamada al modelo) y se guarda hasta que lo actualices. */
export function RecapPanel({ recap, stale, configured, blockedReason }: { recap: RecapView | null; stale: boolean; configured: boolean; blockedReason: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setError(null);
    const r = await apiFetch("/api/goals/recap", "POST", {});
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  const disabled = busy || !configured || !!blockedReason;
  return (
    <Panel
      title={<span className="inline-flex items-center gap-1.5"><Sparkles size={13} aria-hidden /> Resumen con IA</span>}
      action={<button type="button" className="btn btn-primary !h-8" onClick={generate} disabled={disabled} data-testid="recap-generate">{busy ? "Analizando…" : recap ? "Actualizar resumen" : "Generar resumen"}</button>}
    >
      {recap ? (
        <div data-testid="recap-text">
          <MiniMarkdown text={recap.text} />
          <p className="mt-3 text-[11px] text-faint">
            Generado {formatDay(recap.at)} {formatTime(recap.at)} con {recap.model} a partir de cifras agregadas (sin comercios). Verifica los montos en cada meta.
            {stale && <b className="ml-1 font-medium text-[#f59e0b]">Hay cambios desde entonces: actualízalo.</b>}
          </p>
        </div>
      ) : (
        <p className="text-muted">
          {!configured ? "El resumen con IA no está configurado (falta la API key del modelo)." : blockedReason ?? "Genera un resumen de cómo van tus metas y qué hacer para alcanzarlas, con base en tus ingresos y gastos."}
        </p>
      )}
      {recap && blockedReason && <p className="mt-2 text-[11px] text-muted">{blockedReason}</p>}
      {busy && <p className="mt-2 text-[11px] text-muted" role="status">Leyendo tus cifras y redactando… puede tardar unos segundos.</p>}
      {error && <p role="alert" className="mt-2 text-down">{error}</p>}
    </Panel>
  );
}
