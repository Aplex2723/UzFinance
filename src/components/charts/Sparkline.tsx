/** Sparkline SVG puro (sin JS en cliente). Acumulado del mes para que la forma sea legible. */
export function Sparkline({ values, color = "#22c55e", cumulative = true, label }: { values: number[]; color?: string; cumulative?: boolean; label: string }) {
  const W = 120, H = 36, pad = 2;
  let acc = 0;
  const data = cumulative ? values.map((v) => (acc += Math.max(v, 0))) : values;
  if (data.length < 2 || Math.max(...data) <= 0) {
    return <svg viewBox={`0 0 ${W} ${H}`} className="h-9 w-full" role="img" aria-label={`${label}: sin datos`}><line x1="0" y1={H - pad} x2={W} y2={H - pad} stroke="rgb(255 255 255 / .15)" strokeDasharray="3 3" /></svg>;
  }
  const max = Math.max(...data);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * W, H - pad - (v / max) * (H - pad * 2)] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const id = `sp-${label.replace(/\W/g, "")}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-9 w-full" role="img" aria-label={`Tendencia de ${label}`}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.35" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient>
      </defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
