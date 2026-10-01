"use client";
import { sankey, sankeyJustify, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { useMemo, useState } from "react";
import { formatMXN } from "@/lib/money";

type In = { card: string; category: string; color: string; cents: number };
type N = { id: string; name: string; color: string; side: "card" | "cat" };
type L = { source: string; target: string; value: number; color: string };

const W = 520, H = 300;

export function SankeyChart({ data }: { data: In[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const graph = useMemo(() => {
    if (!data.length) return null;
    const nodes = new Map<string, N>();
    const links: L[] = data.map((d) => {
      nodes.set(`c:${d.card}`, { id: `c:${d.card}`, name: d.card, color: "#d4d4d8", side: "card" });
      nodes.set(`k:${d.category}`, { id: `k:${d.category}`, name: d.category, color: d.color, side: "cat" });
      return { source: `c:${d.card}`, target: `k:${d.category}`, value: d.cents / 100, color: d.color };
    });
    const layout = sankey<N, L>()
      .nodeId((n) => n.id)
      .nodeAlign(sankeyJustify)
      .nodeWidth(10)
      .nodePadding(12)
      .extent([[112, 6], [W - 112, H - 6]]);
    return layout({ nodes: [...nodes.values()].map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) });
  }, [data]);

  if (!graph) return <p className="py-10 text-center text-muted">Sin gasto en este mes.</p>;
  const path = sankeyLinkHorizontal<N, L>();
  const total = graph.links.reduce((a, l) => a + l.value, 0);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[460px]" role="img" aria-label="Flujo del gasto de tarjeta a categoría">
        <defs>
          {graph.links.map((l, i) => {
            const s = l.source as SankeyNode<N, L>, t = l.target as SankeyNode<N, L>;
            return (
              <linearGradient key={i} id={`sk-${i}`} gradientUnits="userSpaceOnUse" x1={s.x1} x2={t.x0}>
                <stop offset="0" stopColor="#8b8b92" stopOpacity="0.55" />
                <stop offset="1" stopColor={l.color} stopOpacity="0.85" />
              </linearGradient>
            );
          })}
        </defs>
        <g fill="none">
          {graph.links.map((l: SankeyLink<N, L>, i) => {
            const s = l.source as SankeyNode<N, L>, t = l.target as SankeyNode<N, L>;
            return (
              <path
                key={i}
                d={path(l) ?? ""}
                stroke={`url(#sk-${i})`}
                strokeWidth={Math.max(1, l.width ?? 1)}
                opacity={hover === null || hover === i ? 0.9 : 0.25}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <title>{`${s.name} → ${t.name}: ${formatMXN(l.value * 100)} (${((l.value / total) * 100).toFixed(0)}%)`}</title>
              </path>
            );
          })}
        </g>
        {graph.nodes.map((n) => (
          <g key={n.id}>
            <rect x={n.x0} y={n.y0} width={(n.x1 ?? 0) - (n.x0 ?? 0)} height={Math.max(2, (n.y1 ?? 0) - (n.y0 ?? 0))} rx="3" fill={n.color} opacity="0.95" />
            <text
              x={n.side === "card" ? (n.x0 ?? 0) - 8 : (n.x1 ?? 0) + 8}
              y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2}
              textAnchor={n.side === "card" ? "end" : "start"}
              dominantBaseline="middle"
              fontSize="10"
              fill="#d4d4d8"
            >
              {n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}
              <tspan x={n.side === "card" ? (n.x0 ?? 0) - 8 : (n.x1 ?? 0) + 8} dy="12" fill="#8b8b92" fontSize="9">{formatMXN((n.value ?? 0) * 100, { compact: true })}</tspan>
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
