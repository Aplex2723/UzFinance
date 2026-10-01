import { formatMXN } from "@/lib/money";
import { formatTime, relativeDay } from "@/lib/format";
import { localDate } from "@/lib/time";
import type { Transaction } from "@/lib/types";

export function TxAvatar({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-[13px] font-semibold text-muted">
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function RecentActivity({ rows, showSource = false }: { rows: Transaction[]; showSource?: boolean }) {
  const today = localDate(new Date());
  if (!rows.length) return <p className="py-8 text-center text-muted">Aún no hay movimientos.</p>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-3 py-2.5">
          <TxAvatar name={r.merchant_raw} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{r.merchant_raw}</p>
            <p className="truncate text-[11px] text-muted">
              {r.card_name} · {r.category_name ?? "Sin categoría"} · {relativeDay(r.occurred_date, today)} {formatTime(r.occurred_at)}
              {showSource && ` · ${r.source}`}
            </p>
          </div>
          <p className={`num shrink-0 font-medium ${r.amount_cents < 0 ? "text-up" : ""}`}>
            {r.amount_cents < 0 ? "+" : "−"}{formatMXN(Math.abs(r.amount_cents))}
          </p>
        </li>
      ))}
    </ul>
  );
}
