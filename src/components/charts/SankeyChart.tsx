"use client";
import { sankey, sankeyJustify, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatMXN } from "@/lib/money";

type In = { card: string; category: string; color: string; cents: number };
type N = { id: string; name: string; color: string; side: "card" | "cat" };
type L = { source: string; target: string; value: number; color: string };

const MIN_W = 520, MARGIN_L = 185, MARGIN_R = 165, MAX_CATS = 8, ROW = 30, OTHERS = "Otras categorías";

/** Deja las categorías más pesadas y junta el resto en una sola: con 25+ nodos el diagrama es ilegible. */
function groupSmall(data: In[]): In[] {
  const byCat = new Map<string, number>();
  for (const d of data) byCat.set(d.category, (byCat.get(d.category) ?? 0) + d.cents);
  const keep = new Set([...byCat].sort((a, b) => b[1] - a[1]).slice(0, byCat.size > MAX_CATS ? MAX_CATS - 1 : MAX_CATS).map(([k]) => k));
  const out = new Map<string, In>();
  for (const d of data) {
    const category = keep.has(d.category) ? d.category : OTHERS;
    const key = `${d.card}|${category}`;
    const cur = out.get(key);
    if (cur) cur.cents += d.cents;
    else out.set(key, { ...d, category, color: category === OTHERS ? "#6b7280" : d.color });
  }
  return [...out.values()];
}

export function SankeyChart({ data }: { data: In[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const grouped = useMemo(() => groupSmall(data), [data]);
  const minHeight = Math.max(260, Math.max(new Set(grouped.map((d) => d.card)).size, new Set(grouped.map((d) => d.category)).size) * ROW);
  const hasData = data.length > 0;

  // El diagrama se dibuja al tamaño real de su contenedor: así ocupa la misma altura que el panel de al lado.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);

  const graph = useMemo(() => {
    if (!grouped.length || !box) return null;
    const nodes = new Map<string, N>();
    const width = Math.max(MIN_W, box.w), height = Math.max(minHeight, box.h);
    const links: L[] = grouped.map((d) => {
      nodes.set(`c:${d.card}`, { id: `c:${d.card}`, name: d.card, color: "#d4d4d8", side: "card" });
      nodes.set(`k:${d.category}`, { id: `k:${d.category}`, name: d.category, color: d.color, side: "cat" });
      return { source: `c:${d.card}`, target: `k:${d.category}`, value: d.cents / 100, color: d.color };
    });
    const layout = sankey<N, L>()
      .nodeId((n) => n.id)
      .nodeAlign(sankeyJustify)
      .nodeWidth(10)
      .nodePadding(14)
      .extent([[MARGIN_L, 6], [width - MARGIN_R, height - 6]]);
    return { width, height, ...layout({ nodes: [...nodes.values()].map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) }) };
  }, [grouped, box, minHeight]);

  if (!hasData) return <p className="py-10 text-center text-muted">Sin gasto en este mes.</p>;
  const path = sankeyLinkHorizontal<N, L>();
  const total = graph ? graph.links.reduce((a, l) => a + l.value, 0) : 0;

  return (
    <div ref={ref} className="relative flex-1 overflow-x-auto" style={{ minHeight }}>
      {graph && <svg width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} className="absolute left-0 top-0" role="img" aria-label="Flujo del gasto de tarjeta a categoría">
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
            <rect x={n.x0} y={n.y0} width={(n.x1 ?? 0) - (n.x0 ?? 0)} height={Math.max(3, (n.y1 ?? 0) - (n.y0 ?? 0))} rx="2" fill={n.color} opacity="0.95" />
            <text
              x={n.side === "card" ? (n.x0 ?? 0) - 8 : (n.x1 ?? 0) + 8}
              y={((n.y0 ?? 0) + (n.y1 ?? 0)) / 2}
              textAnchor={n.side === "card" ? "end" : "start"}
              dominantBaseline="middle"
              fontSize="11"
              fill="#d4d4d8"
            >
              {n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
              <tspan fill="#8b8b92" fontSize="9">{` · ${formatMXN((n.value ?? 0) * 100, { compact: true })}`}</tspan>
            </text>
          </g>
        ))}
      </svg>}
    </div>
  );
}
