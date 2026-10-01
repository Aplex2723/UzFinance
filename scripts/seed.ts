import "./load-env";
import { closePool, query } from "../src/lib/db/pool";
import { getEnv } from "../src/lib/env";
import { getCategorizer } from "../src/lib/categorizer";
import { createCard } from "../src/lib/repo/cards";
import { createCategory } from "../src/lib/repo/categories";
import { createRule } from "../src/lib/repo/rules";
import { ingestTransaction } from "../src/lib/repo/transactions";
import { parseAmountToCents } from "../src/lib/money";

// Datos de ejemplo: SOLO contra la base local de docker.
const env = getEnv();
if (env.DB_AUTH !== "password" || !["127.0.0.1", "localhost"].includes(env.DB_SERVER)) {
  console.error("seed se niega a correr: solo contra la base local (127.0.0.1, DB_AUTH=password).");
  process.exit(1);
}

// PRNG determinista para que el seed sea reproducible.
let s = 20260101;
const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];

const CATEGORIES: [string, string, string[]][] = [
  ["Restaurantes", "#ff4d1c", ["STARBUCKS", "SUSHI ITTO", "TOKS", "VIPS", "DOMINOS", "MCDONALDS", "CAFE", "TACOS"]],
  ["Súper", "#f59e0b", ["WALMART", "SORIANA", "CHEDRAUI", "COSTCO", "LA COMER", "OXXO"]],
  ["Transporte", "#60a5fa", ["UBER", "DIDI", "METRO", "CABIFY"]],
  ["Gasolina", "#a78bfa", ["PEMEX", "SHELL", "BP ", "G500"]],
  ["Suscripciones", "#f43f5e", ["NETFLIX", "SPOTIFY", "ICLOUD", "DISNEY", "YOUTUBE", "CHATGPT"]],
  ["Entretenimiento", "#34d399", ["CINEPOLIS", "CINEMEX", "TICKETMASTER", "STEAM"]],
  ["Salud", "#2dd4bf", ["FARMACIA", "BENAVIDES", "SAN PABLO", "GUADALAJARA"]],
  ["Servicios", "#94a3b8", ["TELMEX", "CFE", "TOTALPLAY", "TELCEL", "IZZI"]],
  ["Compras", "#e879f9", ["AMAZON", "MERCADO LIBRE", "LIVERPOOL", "ZARA", "H&M", "APPLE STORE"]],
  ["Viajes", "#fb7185", ["VOLARIS", "AEROMEXICO", "AIRBNB", "BOOKING", "VIVAAEROBUS"]],
];

async function main() {
  const existing = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions");
  if (existing[0].n > 0) {
    console.log("La base ya tiene transacciones; seed omitido (usa `npm run db:reset` para empezar de cero).");
    return;
  }
  const catIds = new Map<string, number>();
  for (const [name, color, patterns] of CATEGORIES) {
    const c = await createCategory({ name, color }).catch(async () => (await query<{ id: number }>("SELECT id FROM dbo.categories WHERE name=@n", { n: { type: (await import("mssql")).default.NVarChar, value: name } }))[0]);
    catIds.set(name, c.id as number);
    for (const p of patterns) await createRule({ pattern: p, match_type: "contains", category_id: c.id as number, priority: 0 }).catch(() => {});
  }
  await createCard({ name: "American Express Platinum", issuer: "amex", last4: "1005", aliases: "Amex,American Express", color: "#9ca3af" });
  await createCard({ name: "Banamex Oro", issuer: "banamex", last4: "4412", aliases: "Banamex Oro Visa", color: "#ef4444" });
  await createCard({ name: "Banamex Costco", issuer: "banamex", last4: "7788", aliases: "Costco Citibanamex", color: "#f59e0b" });

  const categorizer = await getCategorizer();
  const cards = ["American Express Platinum", "Banamex Oro", "Banamex Costco"];
  const merchants = CATEGORIES.flatMap(([, , ps]) => ps.map((p) => p));
  const now = Date.now();
  let n = 0;
  for (let back = 100; back >= 0; back--) {
    const base = new Date(now - back * 86400000);
    const perDay = Math.floor(rnd() * 4) + (back % 7 >= 4 ? 1 : 0);
    for (let i = 0; i < perDay; i++) {
      const m = pick(merchants);
      const at = new Date(base.getTime() - Math.floor(rnd() * 12 * 3600000));
      const pesos = (Math.round((20 + rnd() * rnd() * 1800) * 100) / 100).toFixed(2);
      await ingestTransaction({ merchant: `${m} ${Math.floor(rnd() * 900 + 100)}`, amountCents: parseAmountToCents(pesos), cardRef: pick(cards), occurredAt: at }, "shortcut", { categorizer });
      n++;
    }
    // Suscripciones mensuales fijas (alimentan "Recurrentes").
    const day = base.getUTCDate();
    if (day === 5) await ingestTransaction({ merchant: "NETFLIX.COM", amountCents: 29900, cardRef: "Banamex Oro", occurredAt: base }, "shortcut", { categorizer });
    if (day === 8) await ingestTransaction({ merchant: "SPOTIFY", amountCents: 12900, cardRef: "American Express Platinum", occurredAt: base }, "shortcut", { categorizer });
    if (day === 12) await ingestTransaction({ merchant: "APPLE.COM/BILL ICLOUD", amountCents: 3900, cardRef: "American Express Platinum", occurredAt: base }, "shortcut", { categorizer });
    if (day === 20) await ingestTransaction({ merchant: "TELMEX", amountCents: 48900, cardRef: "Banamex Costco", occurredAt: base }, "shortcut", { categorizer });
  }
  await ingestTransaction({ merchant: "AMAZON REEMBOLSO", amountCents: -45900, cardRef: "Banamex Oro", occurredAt: new Date(now - 3 * 86400000) }, "shortcut", { categorizer });
  const total = await query<{ n: number }>("SELECT COUNT(*) AS n FROM dbo.transactions");
  console.log(`Seed listo: ${catIds.size} categorías, 3 tarjetas, ${total[0].n} transacciones (generadas: ~${n}).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
