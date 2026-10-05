import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { readPdfText } from "../src/lib/pdf/text";
import { detectStatement, extractStatement } from "../src/lib/pdf/statements";

/**
 * Compara los extractores TypeScript (src/lib/pdf/statements) con los JSON de referencia de los extractores Python.
 *   python3 scripts/statements/run_all.py --downloads ~/Downloads --out /tmp/uzfinance-stmts/golden
 *   npx tsx scripts/compare-statement-extractors.ts --downloads ~/Downloads --golden /tmp/uzfinance-stmts/golden [--max 15]
 * Lee los PDF reales SOLO en local (no escribe nada). Reporta las diferencias campo por campo (transacciones, planes,
 * mensualidades de Amex, checks, periodo, as_of, summary). Sale con código 1 si hay alguna.
 * Los nombres `document` y `card_key` de Python salen del NOMBRE DEL ARCHIVO (run_all.py); aquí salen del contenido del PDF
 * y se comparan contra el golden cuyo `document`/`card_key` coincida.
 */
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const downloads = opt("downloads", `${process.env.HOME}/Downloads`)!;
const goldenDir = opt("golden")!;
const max = Number(opt("max", "15"));
if (!goldenDir) throw new Error("uso: compare-statement-extractors.ts --golden <carpeta> [--downloads <carpeta>] [--max N]");

type J = unknown;
const isObj = (x: J): x is Record<string, J> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Diferencias profundas entre esperado (Python) y obtenido (TS). null y ausente son lo mismo. */
function diff(exp: J, act: J, at: string, out: string[]) {
  if (exp == null && act == null) return;
  if (Array.isArray(exp) && Array.isArray(act)) {
    if (exp.length !== act.length) out.push(`${at}: longitud ${exp.length} (py) vs ${act.length} (ts)`);
    for (let i = 0; i < Math.min(exp.length, act.length); i++) diff(exp[i], act[i], `${at}[${i}]`, out);
    return;
  }
  if (isObj(exp) && isObj(act)) {
    for (const k of new Set([...Object.keys(exp), ...Object.keys(act)])) diff(exp[k], act[k], `${at}.${k}`, out);
    return;
  }
  // `raw` es texto informativo: pdf.js y pdfplumber parten distinto los espacios ("DE03" vs "DE 03"), se compara sin ellos.
  if (at.endsWith(".raw") && typeof exp === "string" && typeof act === "string" && exp.replace(/\s+/g, "") === act.replace(/\s+/g, "")) return;
  if (JSON.stringify(exp) !== JSON.stringify(act)) out.push(`${at}: py=${JSON.stringify(exp)} ts=${JSON.stringify(act)}`);
}

async function main() {
  const golden = new Map<string, Record<string, J>>();
  for (const f of readdirSync(goldenDir).filter((f) => f.endsWith(".json") && f !== "index.json")) {
    const d = JSON.parse(readFileSync(path.join(goldenDir, f), "utf8"));
    golden.set(`${d.document}|${d.card_key}`, d);
  }
  const pdfs = readdirSync(downloads).filter((f) => /\.pdf$/i.test(f) && !/^(Envio_movimientos|comprobante)/i.test(f));
  let bad = 0;
  const rows: string[] = [];
  for (const f of pdfs) {
    const t0 = performance.now();
    const pdf = await readPdfText(new Uint8Array(readFileSync(path.join(downloads, f))));
    const det = detectStatement(pdf);
    if (det.kind === null) { rows.push(`${f}: no es un estado soportado (${det.reason})`); continue; }
    const docs = extractStatement(pdf, det.kind);
    const ms = Math.round(performance.now() - t0);
    for (const d of docs) {
      const g = golden.get(`${d.document}|${d.card_key}`);
      if (!g) { rows.push(`${f} -> ${d.document}/${d.card_key}: SIN golden de Python con ese document/card_key`); bad++; continue; }
      const out: string[] = [];
      const a = d as unknown as Record<string, J>;
      for (const k of ["period", "as_of", "transactions", "plans", "installment_postings", "checks", "summary", "warnings", "card_last4", "card_last5", "card_bin8"]) diff(g[k], a[k], k, out);
      const nTx = (g.transactions as J[]).length;
      rows.push(`${f} -> ${d.document}/${d.card_key} [${det.kind}] ${ms} ms: tx py=${nTx} ts=${d.transactions.length}, planes py=${(g.plans as J[]).length} ts=${d.plans.length}, checks fallidos ts=${d.checks.filter((c) => !c.ok).length}, diferencias=${out.length}`);
      for (const line of out.slice(0, max)) rows.push(`    ${line}`);
      if (out.length > max) rows.push(`    ... y ${out.length - max} más`);
      bad += out.length;
      golden.delete(`${d.document}|${d.card_key}`);
    }
  }
  for (const k of golden.keys()) if (!/^(movements_|csv_)/.test(k) && !k.startsWith("movements") ) rows.push(`golden sin PDF correspondiente: ${k}`);
  console.log(rows.join("\n"));
  console.log(bad ? `\n${bad} diferencias` : "\nSin diferencias");
  process.exitCode = bad ? 1 : 0;
}
main();
