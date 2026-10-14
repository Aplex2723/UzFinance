/**
 * Regenera las capturas de docs/screenshots con datos 100 % inventados (seed) y una cuenta de ejemplo.
 *
 *   npm run build && npm run docs:screenshots
 *
 * Usa una base propia (`uzfinance_shots`) en el SQL Server local de docker (db:up), arranca el build de producción en
 * el puerto 3300 con `AUTH_MODE=easyauth` y el encabezado de Easy Auth simulado, y nunca toca una base remota.
 */
import "./load-env";
import { execSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";
import { principal } from "../e2e/env";

const PORT = 3300;
const BASE = `http://localhost:${PORT}`;
const EMAIL = "demo@example.com";
const OUT = "docs/screenshots";

const env = {
  ...process.env,
  NODE_ENV: "production",
  AUTH_MODE: "easyauth",
  ALLOWED_EMAIL: EMAIL,
  INGEST_TOKEN: "shots-token-0123456789-abcdefghijklmnopqrstuvwxyz",
  DB_NAME: "uzfinance_shots",
  DB_AUTH: "password",
  DB_SERVER: "localhost",
  DB_TRUST_SERVER_CERT: "true",
  CATEGORIZER: "rules", // nada sale a servicios externos
  OPENROUTER_API_KEY: "",
  PORT: String(PORT),
} as unknown as NodeJS.ProcessEnv & Record<string, string>;

if (process.env.DB_SERVER && !["localhost", "127.0.0.1"].includes(process.env.DB_SERVER)) {
  console.error("screenshots se niega a correr: solo contra la base local de docker.");
  process.exit(1);
}

const run = (cmd: string) => execSync(cmd, { env, stdio: "inherit" });

async function waitFor(url: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url, { headers: { "x-ms-client-principal": principal(EMAIL) } })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`El servidor no respondió en ${url}`);
}

const monthPlus = (m: number) => {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d.toISOString().slice(0, 10);
};

async function settle(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(900); // animaciones y medidas de las gráficas
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  run("npx tsx scripts/reset.ts && npx tsx scripts/migrate.ts && npx tsx scripts/seed.ts");

  const server = spawn("npm", ["run", "start"], { env, stdio: "ignore" });
  const stop = () => server.kill("SIGTERM");
  process.on("exit", stop);
  try {
    await waitFor(`${BASE}/`);
    const headers = { "x-ms-client-principal": principal(EMAIL) };
    const api = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });

    // Metas de ejemplo (el seed no las crea para no alterar los e2e).
    for (const g of [
      { name: "Enganche del depa", kind: "casa", priority: 1, target: 300000, target_date: monthPlus(14), saved: 85000 },
      { name: "Viaje a Japón", kind: "viaje", priority: 2, target: 60000, target_date: monthPlus(8), saved: 12000 },
      { name: "Fondo de emergencia", kind: "emergencia", priority: 3, target: 120000, target_date: monthPlus(11), saved: 40000 },
    ]) {
      const r = await api("/api/goals", g);
      if (!r.ok) throw new Error(`No se pudo crear la meta ${g.name}: ${r.status} ${await r.text()}`);
    }
    const inc = await fetch(`${BASE}/api/settings/income`, { method: "PUT", headers: { ...headers, "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify({ amount: "45000" }) });
    if (!inc.ok) throw new Error(`No se pudo fijar el ingreso: ${inc.status}`);

    const browser = await chromium.launch();
    const shoot = async (name: string, path: string, opts: { mobile?: boolean; scroll?: number; height?: number; clip?: boolean } = {}) => {
      const ctx = await browser.newContext(
        opts.mobile
          ? { viewport: { width: 390, height: opts.height ?? 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, extraHTTPHeaders: headers }
          : { viewport: { width: 1440, height: opts.height ?? 900 }, deviceScaleFactor: 1.5, extraHTTPHeaders: headers },
      );
      const page = await ctx.newPage();
      await page.goto(`${BASE}${path}`);
      await settle(page);
      if (opts.scroll) {
        await page.evaluate((y) => window.scrollTo(0, y), opts.scroll);
        await page.waitForTimeout(500);
      }
      await page.screenshot({ path: `${OUT}/${name}.png` });
      console.log(`✓ ${OUT}/${name}.png`);
      await ctx.close();
    };

    await shoot("dashboard", "/", { height: 1000 });
    await shoot("transactions", "/transacciones");
    await shoot("analytics", "/analitica");
    await shoot("cards", "/tarjetas");
    await shoot("mobile-dashboard", "/", { mobile: true });
    await shoot("mobile-transactions", "/transacciones", { mobile: true });
    await browser.close();
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
