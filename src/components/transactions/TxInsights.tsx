import type { ReactNode } from "react";
import { Delta } from "@/components/ui/Delta";
import { formatMXN } from "@/lib/money";
import { periodLabel, type TxView } from "@/lib/tx-filters";
import { isTodayPeriod, type TxSummary } from "@/lib/tx-summary";

const pct = (n: number) => `${n >= 10 || n === 0 ? Math.round(n) : n.toFixed(1)}%`;
const plural = (n: number, one: string, many: string) => `${n.toLocaleString("es-MX")} ${n === 1 ? one : many}`;

function Tile({ label, children, className = "", testId }: { label: string; children: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={`glass flex min-h-[104px] min-w-[216px] flex-1 snap-start flex-col gap-1 p-3 sm:min-w-0 ${className}`} data-testid={testId}>
      <p className="truncate text-[11px] text-muted">{label}</p>
      {children}
    </div>
  );
}

const Big = ({ children, testId }: { children: ReactNode; testId?: string }) => <p className="num truncate text-[22px] font-semibold leading-none" data-testid={testId}>{children}</p>;
const Sub = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`truncate text-[11px] leading-tight text-muted ${className}`}>{children}</div>;

function Trend({ s, payments }: { s: TxSummary; payments: boolean }) {
  const p = s.previous;
  if (!p) return null;
  const when = p.label.replace(/^vs /, "");
  if (p.comparison?.trend === "same") return <Sub>Igual {p.label}</Sub>;
  if (p.comparison?.pct !== null && p.comparison?.pct !== undefined) {
    return <Sub className="flex items-center gap-1.5"><Delta pct={p.comparison.pct} /> <span>{p.label}</span></Sub>;
  }
  return <Sub className="text-faint">{payments ? "Sin pagos" : "Sin gasto"} {when}</Sub>;
}

/**
 * Tarjetitas de resumen del conjunto FILTRADO (mismos filtros que la lista). Compactas: una fila de 3-4 tarjetitas (en celular se
 * desplazan en horizontal). Para "Pagos de tarjeta" hablan de pagos, no de gasto. Servidor: no lleva JS.
 */
export function TxInsights({ summary: s, view, today }: { summary: TxSummary; view: TxView; today: string }) {
  const payments = view.kind === "card_payment";
  const period = periodLabel(view, today);
  if (s.count === 0) {
    return <p className="glass mb-3 px-4 py-3 text-muted" data-testid="tx-insights-empty">{period ? "Sin movimientos en este periodo" : "Sin movimientos con estos filtros"}</p>;
  }
  const isToday = isTodayPeriod(view, today);
  const noun = payments ? "pagos" : "gasto";
  const top = s.topPurchase;
  const cat = s.categories;
  const showTopMerchant = !!s.topMerchant && s.topMerchant.count > 1 && s.topMerchant.merchant !== top?.merchant;
  const tiles = payments ? 3 : 4;

  return (
    <section aria-label="Resumen" data-testid="tx-insights" className={`mb-3 -mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:overflow-visible sm:px-0 sm:pb-0 ${tiles === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}>
      <Tile label={isToday && !payments ? "Hoy llevas" : `${payments ? "Pagado" : "Gastado"} ${period ?? "en total"}`} testId="insight-total">
        <Big testId="insight-total-value">{formatMXN(s.totalCents)}</Big>
        <Sub>
          {isToday && !payments ? `en ${plural(s.count, "movimiento", "movimientos")}` : <>{plural(s.count, "movimiento", "movimientos")}{!payments && s.avgTicketCents !== null && <> · ticket {formatMXN(s.avgTicketCents, { compact: true })}</>}</>}
        </Sub>
        <Trend s={s} payments={payments} />
        {isToday && !payments && s.avg30 && s.avg30.diffCents !== 0 && (
          <Sub className={`!whitespace-normal ${s.avg30.diffCents > 0 ? "text-down" : "text-up"}`}>
            <span data-testid="insight-avg30">{formatMXN(Math.abs(s.avg30.diffCents), { compact: true })} {s.avg30.diffCents > 0 ? "más" : "menos"} que tu promedio diario ({formatMXN(s.avg30.avgCents, { compact: true })})</span>
          </Sub>
        )}
      </Tile>

      <Tile label={payments ? "Tarjetas con más pagos" : "Tarjetas que más gastaron"} testId="insight-cards">
        {s.cards.length === 0 ? <Sub>Sin cargos</Sub> : (
          <div className="flex flex-col gap-1.5">
            {s.cards.map((c) => (
              <div key={c.id} data-testid="insight-card-row" title={`${c.name}: ${formatMXN(c.cents)} (${pct(c.pct)})`}>
                <div className="flex items-baseline gap-1.5 text-[11px] leading-tight">
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full" style={{ background: c.color }} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="num shrink-0">{formatMXN(c.cents, { compact: true })}</span>
                  <span className="num w-9 shrink-0 text-right text-muted">{pct(c.pct)}</span>
                </div>
                <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-white/10" aria-hidden><div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, c.pct))}%`, background: c.color }} /></div>
              </div>
            ))}
          </div>
        )}
      </Tile>

      {!payments && (
        <Tile label="Categoría con más gasto" testId="insight-category">
          {cat[0] ? (
            <>
              <p className="flex items-center gap-1.5 truncate text-[15px] font-semibold leading-tight"><span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: cat[0].color }} /><span className="truncate">{cat[0].name}</span></p>
              <Sub><span className="num text-fg">{formatMXN(cat[0].cents, { compact: true })}</span> · {pct(cat[0].pct)} del {noun}</Sub>
              {cat[1] && <Sub>2.º {cat[1].name} · {formatMXN(cat[1].cents, { compact: true })}</Sub>}
            </>
          ) : <Sub>Sin cargos</Sub>}
        </Tile>
      )}

      <Tile label={payments ? "Pago más alto" : "Compra más alta"} testId="insight-top">
        {top ? (
          <>
            <Big>{formatMXN(top.cents)}</Big>
            <Sub><span title={top.merchant}>{top.merchant}</span></Sub>
            {showTopMerchant && s.topMerchant && <Sub>Comercio top: {s.topMerchant.merchant} · {formatMXN(s.topMerchant.cents, { compact: true })} ({s.topMerchant.count})</Sub>}
          </>
        ) : <Sub>Sin cargos</Sub>}
      </Tile>
    </section>
  );
}
