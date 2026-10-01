import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { monthLabel, shiftMonth } from "@/lib/format";
import { currentMonth } from "@/lib/time";

export function MonthNav({ month, base = "/" }: { month: string; base?: string }) {
  const isCurrent = month === currentMonth();
  const href = (m: string) => (m === currentMonth() ? base : `${base}?month=${m}`);
  return (
    <nav aria-label="Mes" className="flex items-center gap-1">
      <Link href={href(shiftMonth(month, -1))} className="btn !h-8 !w-8 !p-0" aria-label="Mes anterior"><ChevronLeft size={14} /></Link>
      <span className="min-w-[110px] text-center text-muted">{monthLabel(month)}</span>
      {isCurrent
        ? <span className="btn !h-8 !w-8 !p-0 opacity-30" aria-hidden><ChevronRight size={14} /></span>
        : <Link href={href(shiftMonth(month, 1))} className="btn !h-8 !w-8 !p-0" aria-label="Mes siguiente"><ChevronRight size={14} /></Link>}
    </nav>
  );
}
