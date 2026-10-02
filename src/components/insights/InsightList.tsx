import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { InsightMessage } from "@/lib/insights";

const STYLE = {
  good: { Icon: CheckCircle2, cls: "text-up bg-up/10" },
  warn: { Icon: AlertTriangle, cls: "text-[#f59e0b] bg-[#f59e0b]/10" },
  info: { Icon: Info, cls: "text-[#60a5fa] bg-[#60a5fa]/10" },
} as const;

export function InsightList({ messages }: { messages: InsightMessage[] }) {
  if (messages.length === 0) return <p className="py-4 text-center text-muted">Aún no hay suficientes datos para generar insights.</p>;
  return (
    <ul className="flex flex-col gap-2" data-testid="insight-list">
      {messages.map((m, idx) => {
        const { Icon, cls } = STYLE[m.tone];
        return (
          <li key={idx} className="flex items-start gap-2.5 rounded-xl border border-line bg-black/20 p-3">
            <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${cls}`}><Icon size={13} aria-hidden /></span>
            <p className="leading-snug">{m.text}</p>
          </li>
        );
      })}
    </ul>
  );
}
