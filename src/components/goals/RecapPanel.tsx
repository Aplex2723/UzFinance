"use client";
import { Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { formatDay, formatTime } from "@/lib/format";
import { Panel } from "../ui/Panel";
import { MiniMarkdown } from "./MiniMarkdown";

export type RecapView = { text: string; at: string; model: string };

export type RecapPanelProps = {
  recap: RecapView | null;
  stale: boolean;
  configured: boolean;
  blockedReason: string | null;
  title: string;
  /** Ruta que genera el texto (POST) y lo que se le manda. */
  endpoint: string;
  payload?: unknown;
  /** Texto cuando aún no hay resumen. */
  idleText: string;
  testId?: string;
};

/** Resumen con IA: se genera a pedido (cuesta una llamada al modelo) y se guarda hasta que lo actualices. */
export function RecapPanel({ recap, stale, configured, blockedReason, title, endpoint, payload = {}, idleText, testId = "recap" }: RecapPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setError(null);
    const r = await apiFetch(endpoint, "POST", payload);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    router.refresh();
  }

  const disabled = busy || !configured || !!blockedReason;
  return (
    <Panel
      title={<span className="inline-flex items-center gap-1.5"><Sparkles size={13} aria-hidden /> {title}</span>}
      action={<button type="button" className="btn btn-primary !h-8" onClick={generate} disabled={disabled} data-testid={`${testId}-generate`}>{busy ? "Analizando…" : recap ? "Actualizar resumen" : "Generar resumen"}</button>}
    >
      {recap ? (
        <div data-testid={`${testId}-text`}>
          <MiniMarkdown text={recap.text} />
          <p className="mt-3 text-[11px] text-faint">
            Generado {formatDay(recap.at)} {formatTime(recap.at)} con {recap.model} a partir de cifras agregadas (sin comercios). Verifica los montos en cada meta.
            {stale && <b className="ml-1 font-medium text-[#f59e0b]">Hay cambios desde entonces: actualízalo.</b>}
          </p>
        </div>
      ) : (
        <p className="text-muted">
          {!configured ? "La IA no está configurada (falta la API key del modelo)." : blockedReason ?? idleText}
        </p>
      )}
      {recap && blockedReason && <p className="mt-2 text-[11px] text-muted">{blockedReason}</p>}
      {busy && <p className="mt-2 text-[11px] text-muted" role="status">Leyendo tus cifras y redactando… puede tardar unos segundos.</p>}
      {error && <p role="alert" className="mt-2 text-down">{error}</p>}
    </Panel>
  );
}
