import "./load-env";
import { readFileSync } from "node:fs";
import { closePool } from "../src/lib/db/pool";
import { listCategories } from "../src/lib/repo/categories";
import { JEV_MIN_CONFIDENCE, jevClassify } from "../src/lib/categorizer/jev";

/**
 * Mide la precisión de Jev contra comercios que etiquetaste a mano (necesita OPENROUTER_API_KEY y la base con las categorías de la migración 007).
 *   npx tsx scripts/jev-eval.ts <etiquetas.json> [--verbose]
 * etiquetas.json: [{ "merchant": "OXXO POETAS MID", "ok": ["Tiendas de conveniencia"] }, ...]   (ok = categorías aceptables)
 * Usa solo las categorías con descripción. Imprime la precisión global y por umbral de probabilidad; cada comercio cuesta ~$0.00002.
 */
type Label = { merchant: string; ok: string[] };

async function main() {
  const file = process.argv[2];
  const verbose = process.argv.includes("--verbose");
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!file || !apiKey) throw new Error("uso: jev-eval.ts <etiquetas.json> (con OPENROUTER_API_KEY en el entorno)");
  const labels: Label[] = JSON.parse(readFileSync(file, "utf8"));
  const cats = (await listCategories()).filter((c) => c.description);
  const byId = new Map(cats.map((c) => [c.id, c.name]));
  const unknown = labels.flatMap((l) => l.ok).filter((n) => !cats.some((c) => c.name === n));
  if (unknown.length) throw new Error(`Categorías inexistentes en las etiquetas: ${[...new Set(unknown)].join(", ")}`);

  const rows: { merchant: string; got: string; p: number; ok: boolean; top: string }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < labels.length) {
        const l = labels[next++];
        const r = await jevClassify(l.merchant, cats, { apiKey, timeoutMs: 20_000, retries: 3 });
        const got = r ? byId.get(r.categoryId)! : "(sin respuesta)";
        rows.push({
          merchant: l.merchant, got, p: r?.probability ?? 0, ok: l.ok.includes(got),
          top: l.ok[0],
        });
      }
    }),
  );
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const correct = rows.filter((r) => r.ok).length;
  console.log(`Comercios: ${rows.length} · aciertos: ${correct} (${pct(correct, rows.length)}) · umbral actual ${JEV_MIN_CONFIDENCE}`);
  for (const th of [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const sel = rows.filter((r) => r.p >= th);
    console.log(`  p ≥ ${th.toFixed(1)}: cubre ${pct(sel.length, rows.length)} · precisión ${pct(sel.filter((r) => r.ok).length, sel.length)}`);
  }
  const misses = rows.filter((r) => !r.ok).sort((a, b) => b.p - a.p);
  console.log(`\nFallos (${misses.length}):`);
  for (const m of misses) console.log(`  [${m.p.toFixed(2)}] ${m.merchant} → ${m.got}   (esperado: ${m.top})`);
  if (verbose) for (const r of rows.filter((x) => x.ok)) console.log(`  ok [${r.p.toFixed(2)}] ${r.merchant} → ${r.got}`);
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => closePool());
