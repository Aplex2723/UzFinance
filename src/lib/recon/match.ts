/**
 * Emparejamiento uno a uno entre líneas del estado y filas de la app, determinista.
 * Dentro de cada grupo de mismo monto se busca la asignación que (1) empareja el MAYOR número de pares dentro de la
 * ventana de días, (2) entre esas minimiza la suma de diferencias de fecha, (3) solo para desempatar prefiere comercios
 * parecidos y (4) el orden original. Es una asignación óptima (algoritmo húngaro), no un voraz: un voraz por fecha deja
 * sin pareja a una línea cuando otra le "roba" la fila.
 */

const BIG = 1e12;
const DAY_W = 1e8;
const SIM_W = 1e5;
/** Más de esto en un mismo monto (patológico) → voraz por capas, igual de determinista. */
const MAX_HUNGARIAN = 200;

/** Húngaro (n ≤ m): para cada fila i, la columna asignada. */
function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = cost[0].length;
  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(m + 1).fill(0);
  const p = new Array<number>(m + 1).fill(0);
  const way = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const ans = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}

/** Asignación dentro de un grupo. `weight(i, j)` = null si el par no es válido; menor es mejor. Devuelve pares [i, j]. */
function assignGroup(n: number, m: number, weight: (i: number, j: number) => number | null): [number, number][] {
  if (!n || !m) return [];
  const w: (number | null)[][] = Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => weight(i, j)));
  if (Math.max(n, m) > MAX_HUNGARIAN) {
    const edges: [number, number, number][] = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) if (w[i][j] !== null) edges.push([w[i][j]!, i, j]);
    edges.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const ui = new Set<number>();
    const uj = new Set<number>();
    const out: [number, number][] = [];
    for (const [, i, j] of edges) if (!ui.has(i) && !uj.has(j)) { ui.add(i); uj.add(j); out.push([i, j]); }
    return out;
  }
  const c = w.map((row) => row.map((x) => (x === null ? 0 : x - BIG)));
  const out: [number, number][] = [];
  if (n <= m) {
    hungarian(c).forEach((j, i) => { if (j >= 0 && w[i][j] !== null) out.push([i, j]); });
  } else {
    const t = Array.from({ length: m }, (_, j) => Array.from({ length: n }, (_, i) => c[i][j]));
    hungarian(t).forEach((i, j) => { if (i >= 0 && w[i][j] !== null) out.push([i, j]); });
  }
  return out;
}

export type MatchArgs = {
  /** Clave de monto de cada línea y de cada fila: solo se emparejan claves iguales. */
  lineKeys: number[];
  rowKeys: number[];
  /** Diferencia de días entre la línea i y la fila j. */
  days: (i: number, j: number) => number;
  /** Similitud de comercio 0..1 (solo desempata). */
  sim: (i: number, j: number) => number;
  maxDays: number;
};

/** Pares [índice de línea, índice de fila]. Cada línea y cada fila aparece a lo más una vez. */
export function matchByKey(a: MatchArgs): [number, number][] {
  const rowsByKey = new Map<number, number[]>();
  a.rowKeys.forEach((k, j) => { const l = rowsByKey.get(k); if (l) l.push(j); else rowsByKey.set(k, [j]); });
  const linesByKey = new Map<number, number[]>();
  a.lineKeys.forEach((k, i) => { const l = linesByKey.get(k); if (l) l.push(i); else linesByKey.set(k, [i]); });
  const out: [number, number][] = [];
  for (const [key, L] of linesByKey) {
    const R = rowsByKey.get(key);
    if (!R) continue;
    const pairs = assignGroup(L.length, R.length, (x, y) => {
      const d = a.days(L[x], R[y]);
      if (d > a.maxDays) return null;
      return d * DAY_W + Math.round((1 - a.sim(L[x], R[y])) * 100) * SIM_W + (x * MAX_HUNGARIAN + y);
    });
    for (const [x, y] of pairs) out.push([L[x], R[y]]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}
