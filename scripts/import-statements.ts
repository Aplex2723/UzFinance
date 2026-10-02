import "./load-env";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getCategorizer } from "../src/lib/categorizer";
import { closePool } from "../src/lib/db/pool";
import { cardMapSchema, docSchema, importStatements, overrideSchema, type ImportReport } from "../src/lib/import/statements";

/**
 * Importa estados de cuenta / movimientos ya extraídos (ver scripts/statements/README.md) a la base.
 *   npx tsx scripts/import-statements.ts --dir <carpeta con los .json> --cards <mapa-de-tarjetas.json> [--overrides <correcciones.json>] [--dry-run]
 *   Azure (con `az login`): agrega --azure (necesita DB_SERVER, DB_NAME y AZ_SUBSCRIPTION) y --yes para escribir de verdad;
 *   sin --yes solo simula. Antes abre una regla de firewall temporal para tu IP y bórrala al terminar.
 * Es idempotente: volver a correrlo no duplica nada.
 */
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const dir = opt("dir");
  const cardsFile = opt("cards");
  if (!dir || !cardsFile) throw new Error("uso: import-statements.ts --dir <carpeta> --cards <mapa.json> [--dry-run] [--azure --yes]");
  const azure = flag("azure");
  let dry = flag("dry-run");

  // El resto de la configuración la exige getEnv(); este script no atiende peticiones, así que basta con valores neutros.
  process.env.ALLOWED_EMAIL ??= "import@example.invalid";
  process.env.INGEST_TOKEN ??= "x".repeat(48);
  if (azure) {
    const sub = process.env.AZ_SUBSCRIPTION;
    if (!sub || !process.env.DB_SERVER?.endsWith(".database.windows.net") || !process.env.DB_NAME) throw new Error("--azure necesita AZ_SUBSCRIPTION, DB_SERVER=<srv>.database.windows.net y DB_NAME");
    process.env.DB_AUTH = "token";
    process.env.DB_TRUST_SERVER_CERT = "false";
    process.env.AZURE_SQL_TOKEN = execFileSync("az", ["account", "get-access-token", "--subscription", sub, "--resource", "https://database.windows.net/", "--query", "accessToken", "-o", "tsv"], { encoding: "utf8" }).trim();
    if (!flag("yes")) { dry = true; console.log("(--azure sin --yes: solo simulación, no se escribe nada)"); }
  }
  process.env.CATEGORIZER = process.env.OPENROUTER_API_KEY ? "jev" : "rules";
  console.log(`Destino: ${process.env.DB_SERVER}/${process.env.DB_NAME} · ${dry ? "SIMULACIÓN" : "ESCRITURA"} · categorizador: ${process.env.CATEGORIZER}`);

  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json");
  const docs = files.map((f) => {
    const parsed = docSchema.safeParse(JSON.parse(readFileSync(path.join(dir, f), "utf8")));
    if (!parsed.success) throw new Error(`${f}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return parsed.data;
  });
  const failed = docs.flatMap((d) => d.checks.filter((c) => !c.ok).map((c) => `${d.document}: ${c.name}`));
  if (failed.length) throw new Error(`Hay verificaciones del extractor que no cuadran, no se importa:\n  ${failed.join("\n  ")}`);
  const cardMap = cardMapSchema.parse(JSON.parse(readFileSync(cardsFile, "utf8")));

  const overrides = opt("overrides") ? overrideSchema.parse(JSON.parse(readFileSync(opt("overrides")!, "utf8"))) : undefined;
  const categorizer = await getCategorizer({ timeoutMs: 20_000 });
  const report = await importStatements(docs, cardMap, { categorizer, overrides, dryRun: dry, log: (s) => console.log(`  · ${s}`) });
  print(report);
}

function print(r: ImportReport) {
  const mxn = (c: number) => (c / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
  console.log("\nDocumento".padEnd(26) + "nuevos".padStart(8) + "ya existían".padStart(13) + "planes(+/~/=)".padStart(16) + "desde plan".padStart(12) + "sin categ.".padStart(11) + "gasto nuevo".padStart(16));
  for (const d of r.docs) {
    console.log(d.document.padEnd(25) + String(d.inserted).padStart(8) + String(d.existing).padStart(13) + `${d.plansCreated}/${d.plansUpdated}/${d.plansStale}`.padStart(16) + String(d.purchasesFromPlans).padStart(12) + String(d.uncategorized).padStart(11) + mxn(d.insertedCents).padStart(16));
    for (const [why, n] of Object.entries(d.skipped)) console.log(`    omitidos: ${n} × ${why}`);
  }
  if (r.cardsCreated.length) console.log(`\nTarjetas creadas: ${r.cardsCreated.join(", ")}`);
  if (Object.keys(r.byCategory).length) {
    console.log("\nMovimientos importados por categoría:");
    for (const [k, n] of Object.entries(r.byCategory).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  }
  for (const w of r.warnings) console.log(`\n⚠ ${w}`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => closePool());
