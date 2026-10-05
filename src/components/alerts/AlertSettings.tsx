"use client";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { MoneyParseError, parseAmountToCents } from "@/lib/money";
import type { AlertConfig } from "@/lib/repo/alerts";
import type { Category } from "@/lib/types";
import { Panel } from "../ui/Panel";
import { RULE_HELP, RULE_LABEL } from "./labels";

/** Umbrales en pesos (la API guarda centavos). min/max en pesos. */
const MONEY = [
  { key: "largePurchaseCents", label: "Compra fuerte: monto límite", help: "Cualquier compra desde este monto genera una alerta.", min: 100, max: 1_000_000 },
  { key: "largeRelativeMinCents", label: "Compra fuerte vs. lo habitual: monto mínimo", help: "Una compra mucho más cara que lo normal solo cuenta si pasa de este monto.", min: 1, max: 1_000_000 },
  { key: "newMerchantCents", label: "Comercio nuevo: monto desde el que avisa", help: "Un comercio que nunca habías usado avisa desde este monto.", min: 100, max: 1_000_000 },
  { key: "paceMinDiffCents", label: "Ritmo de gasto: diferencia mínima", help: "Diferencia mínima contra el mes pasado para avisar.", min: 1, max: 1_000_000 },
  { key: "dailySpikeMinCents", label: "Pico del día: gasto mínimo", help: "Un día solo cuenta como pico si gastas al menos esto.", min: 1, max: 1_000_000 },
] as const;
const NUM = [
  { key: "largeVsTypicalFactor", label: "Compra fuerte: veces lo habitual", help: "Entre 1.5 y 50 veces la mediana de ese comercio o categoría.", min: 1.5, max: 50, step: "0.5" },
  { key: "dailySpikeFactor", label: "Pico del día: veces tu promedio diario", help: "Entre 1.5 y 50 veces.", min: 1.5, max: 50, step: "0.5" },
  { key: "paceTolerancePct", label: "Ritmo de gasto: tolerancia (%)", help: "Entre 5 y 300 por ciento por encima del mes anterior.", min: 5, max: 300, step: "1" },
  { key: "goalTolerancePct", label: "Meta de ahorro: holgura (%)", help: "Entre 0 y 100 por ciento antes de avisar que te alejas.", min: 0, max: 100, step: "1" },
] as const;
type MoneyKey = (typeof MONEY)[number]["key"];
type NumKey = (typeof NUM)[number]["key"];

const pesos = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");

export function AlertSettings({ config, categories }: { config: AlertConfig; categories: Category[] }) {
  const router = useRouter();
  const [money, setMoney] = useState<Record<MoneyKey, string>>(() => Object.fromEntries(MONEY.map((m) => [m.key, pesos(config[m.key])])) as Record<MoneyKey, string>);
  const [nums, setNums] = useState<Record<NumKey, string>>(() => Object.fromEntries(NUM.map((m) => [m.key, String(config[m.key])])) as Record<NumKey, string>);
  const [enabled, setEnabled] = useState(config.enabled);
  const [merchants, setMerchants] = useState(config.mutedMerchants);
  const [newMerchant, setNewMerchant] = useState("");
  const [cats, setCats] = useState(config.mutedCategoryIds);
  const [wa, setWa] = useState(config.whatsapp);
  const [tg, setTg] = useState(config.telegram);
  const [quiet, setQuiet] = useState(config.quietHours);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  function addMerchant() {
    const v = newMerchant.trim();
    if (!v) return;
    if (!merchants.some((m) => m.toLowerCase() === v.toLowerCase())) setMerchants([...merchants, v]);
    setNewMerchant("");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const errs: Record<string, string> = {};
    const body: Record<string, unknown> = {};
    for (const m of MONEY) {
      try {
        const c = parseAmountToCents(money[m.key]);
        if (c < m.min * 100 || c > m.max * 100) throw new MoneyParseError("rango");
        body[m.key] = c;
      } catch {
        errs[m.key] = `Escribe un monto entre $${m.min.toLocaleString("es-MX")} y $${m.max.toLocaleString("es-MX")}`;
      }
    }
    for (const n of NUM) {
      const v = Number(nums[n.key]);
      if (!nums[n.key].trim() || !Number.isFinite(v) || v < n.min || v > n.max) errs[n.key] = `Escribe un número entre ${n.min} y ${n.max}`;
      else body[n.key] = v;
    }
    if (quiet.enabled && (!quiet.start || !quiet.end)) errs.quiet = "Indica la hora de inicio y de fin";
    setErrors(errs);
    if (Object.keys(errs).length) return setMsg({ ok: false, text: "Revisa los campos marcados." });
    Object.assign(body, { enabled, mutedMerchants: merchants, mutedCategoryIds: cats, whatsapp: wa, telegram: tg, quietHours: quiet });
    setBusy(true);
    const r = await apiFetch("/api/settings/alerts", "PUT", body);
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.error });
    setMsg({ ok: true, text: "Configuración guardada." });
    router.refresh();
  }

  const err = (k: string) => (errors[k] ? <p id={`e-${k}`} role="alert" className="mt-1 text-[11px] text-down">{errors[k]}</p> : null);

  return (
    <Panel title="Configuración de alertas">
      <form onSubmit={save} className="grid gap-5" data-testid="alert-settings">
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-[12px] font-medium">Umbrales</legend>
          {MONEY.map((m) => (
            <div key={m.key}>
              <label className="label" htmlFor={`a-${m.key}`}>{m.label} (MXN)</label>
              <input id={`a-${m.key}`} inputMode="decimal" className="field !h-11" value={money[m.key]} onChange={(e) => setMoney({ ...money, [m.key]: e.target.value })} aria-invalid={!!errors[m.key]} aria-describedby={errors[m.key] ? `e-${m.key}` : undefined} />
              <p className="mt-1 text-[11px] text-faint">{m.help}</p>
              {err(m.key)}
            </div>
          ))}
          {NUM.map((m) => (
            <div key={m.key}>
              <label className="label" htmlFor={`a-${m.key}`}>{m.label}</label>
              <input id={`a-${m.key}`} inputMode="decimal" step={m.step} className="field !h-11" value={nums[m.key]} onChange={(e) => setNums({ ...nums, [m.key]: e.target.value })} aria-invalid={!!errors[m.key]} aria-describedby={errors[m.key] ? `e-${m.key}` : undefined} />
              <p className="mt-1 text-[11px] text-faint">{m.help}</p>
              {err(m.key)}
            </div>
          ))}
        </fieldset>

        <fieldset className="grid gap-1">
          <legend className="mb-1 text-[12px] font-medium">Qué avisos quieres</legend>
          {Object.keys(enabled).map((rule) => (
            <label key={rule} className="flex items-start gap-3 rounded-xl p-2 hover:bg-surface">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[#ff4d1c]" checked={enabled[rule as keyof typeof enabled]} onChange={(e) => setEnabled({ ...enabled, [rule]: e.target.checked })} />
              <span><span className="block font-medium">{RULE_LABEL[rule] ?? rule}</span><span className="block text-[11px] text-muted">{RULE_HELP[rule] ?? ""}</span></span>
            </label>
          ))}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-[12px] font-medium">Comercios silenciados</legend>
          <p className="text-[11px] text-muted">Nunca generan alertas de compras.</p>
          {merchants.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label="Comercios silenciados">
              {merchants.map((m) => (
                <li key={m} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-0.5 pl-2.5 pr-1 text-[12px]">
                  {m}
                  <button type="button" className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10" aria-label={`Quitar ${m}`} onClick={() => setMerchants(merchants.filter((x) => x !== m))}><X size={12} aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="a-merchant">Comercio a silenciar</label>
            <input id="a-merchant" className="field !h-11" value={newMerchant} maxLength={80} placeholder="Ej. UBER EATS" onChange={(e) => setNewMerchant(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addMerchant(); } }} />
            <button type="button" className="btn !h-11" onClick={addMerchant}>Agregar</button>
          </div>
        </fieldset>

        {categories.length > 0 && (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-[12px] font-medium">Categorías silenciadas</legend>
            <p className="text-[11px] text-muted">Las compras de estas categorías no generan alertas.</p>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2.5 rounded-xl p-2 hover:bg-surface">
                  <input type="checkbox" className="h-5 w-5 accent-[#ff4d1c]" checked={cats.includes(c.id)} onChange={(e) => setCats(e.target.checked ? [...cats, c.id] : cats.filter((x) => x !== c.id))} />
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} aria-hidden />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="grid gap-3 rounded-xl border border-line p-3.5">
          <legend className="px-1 text-[12px] font-medium">Telegram</legend>
          <p className="rounded-lg bg-[#60a5fa]/10 p-2.5 text-[#93c5fd]" data-testid="telegram-note">Los avisos llegan al chat privado de cada persona autorizada con el bot de Telegram (gratis). Cada persona debe haberle escrito al bot al menos una vez.</p>
          <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[#ff4d1c]" checked={tg.enabled} onChange={(e) => setTg({ ...tg, enabled: e.target.checked })} data-testid="telegram-enabled" /> Avisarme por Telegram</label>
          <div>
            <label className="label" htmlFor="a-tg-sev">Gravedad mínima</label>
            <select id="a-tg-sev" className="field !h-11" value={tg.minSeverity} onChange={(e) => setTg({ ...tg, minSeverity: e.target.value as typeof tg.minSeverity })}>
              <option value="info">Todos (informativos en adelante)</option>
              <option value="warn">Atención y graves</option>
              <option value="high">Solo graves</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="grid gap-3 rounded-xl border border-line p-3.5">
          <legend className="px-1 text-[12px] font-medium">WhatsApp</legend>
          <p className="rounded-lg bg-[#60a5fa]/10 p-2.5 text-[#93c5fd]" data-testid="whatsapp-note">Apagado: requiere plantillas aprobadas por Meta. Aún no se envían mensajes; esto solo deja listos los avisos.</p>
          <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[#ff4d1c]" checked={wa.enabled} onChange={(e) => setWa({ ...wa, enabled: e.target.checked })} /> Dejar listos los avisos para WhatsApp</label>
          <div>
            <label className="label" htmlFor="a-wa-sev">Gravedad mínima</label>
            <select id="a-wa-sev" className="field !h-11" value={wa.minSeverity} onChange={(e) => setWa({ ...wa, minSeverity: e.target.value as typeof wa.minSeverity })}>
              <option value="info">Todos (informativos en adelante)</option>
              <option value="warn">Atención y graves</option>
              <option value="high">Solo graves</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="grid gap-3 rounded-xl border border-line p-3.5">
          <legend className="px-1 text-[12px] font-medium">Horas de silencio</legend>
          <p className="text-[11px] text-muted">Los avisos por Telegram esperan a que terminen (salvo los graves, que salen siempre).</p>
          <label className="flex items-center gap-3"><input type="checkbox" className="h-5 w-5 accent-[#ff4d1c]" checked={quiet.enabled} onChange={(e) => setQuiet({ ...quiet, enabled: e.target.checked })} /> No avisarme en estas horas (hora de Ciudad de México)</label>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label" htmlFor="a-qs">De</label><input id="a-qs" type="time" className="field !h-11" value={quiet.start} onChange={(e) => setQuiet({ ...quiet, start: e.target.value })} disabled={!quiet.enabled} /></div>
            <div><label className="label" htmlFor="a-qe">A</label><input id="a-qe" type="time" className="field !h-11" value={quiet.end} onChange={(e) => setQuiet({ ...quiet, end: e.target.value })} disabled={!quiet.enabled} /></div>
          </div>
          {err("quiet")}
        </fieldset>

        {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-up" : "text-down"} data-testid="settings-msg">{msg.text}</p>}
        <button className="btn btn-primary !h-12 text-[14px]" disabled={busy} data-testid="settings-save">{busy ? "Guardando…" : "Guardar configuración"}</button>
      </form>
    </Panel>
  );
}
