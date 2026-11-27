import { z } from "zod";
import { scheduleTransactionAlerts } from "@/lib/alerts/schedule";
import { getCategorizer, type Categorizer } from "@/lib/categorizer";
import { MCP_SOURCE, mcpSourceTag, SOURCE_LABELS } from "@/lib/chat-sources";
import { query, t } from "@/lib/db/pool";
import { normalizeMerchant } from "@/lib/merchant";
import { isDebitCard, MSI_MAX, MSI_MIN } from "@/lib/msi";
import { matchCard } from "@/lib/repo/cards";
import { listCategories } from "@/lib/repo/categories";
import { attachMsiPlan, MsiError, monthlyOf } from "@/lib/repo/manual-msi";
import { dedupeHash, ingestTransaction } from "@/lib/repo/transactions";
import { dedupeHashExists, findSimilarExpenses } from "@/lib/repo/whatsapp";
import { localDate } from "@/lib/time";
import { isRealDate } from "@/lib/tx-filters";
import type { Card } from "@/lib/types";
import { eligibleCards, fold, matchCards } from "@/lib/whatsapp/cards";
import { CONFIRM_CENTS } from "@/lib/whatsapp/parse-expense";
import { cdmxAt, localTime } from "@/lib/whatsapp/when";
import type { ToolOutcome } from "@/lib/chat/tools";

/**
 * Herramientas de ESCRITURA del servidor MCP: lo mismo que hace el bot de Telegram (registrar un gasto, a meses si aplica, y
 * deshacerlo), para asistentes como Muse. Solo las ven los clientes de `MCP_WRITE_CLIENTS`; el resto sigue siendo de solo lectura.
 *
 * Reglas (las mismas del bot): el gasto se guarda a precio completo con la etiqueta `mcp` (o `mcp-d` con fecha explícita), así que el
 * Atajo y el correo del banco lo confirman en vez de duplicarlo; si ya hay uno igual (misma tarjeta y monto en ±1 día) NO se registra
 * hasta que el asistente confirme con la persona (`allow_duplicate`); montos altos piden `confirmed`; débito no admite MSI.
 */

const MAX_CENTS = 1_000_000_00;
const MAX_AGE_DAYS = 400;
const DELETE_WINDOW_DAYS = 7;

const pesos = (cents: number) => Math.round(cents) / 100;
const cardOut = (c: Card) => ({ tarjeta: c.name, terminacion: c.last4 ?? null, debito: isDebitCard(c) });

class WriteError extends Error {
  constructor(message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type WriteDeps = { now: Date; client: string; categorizer?: Categorizer };

/**
 * Tarjeta por nombre, alias o terminación: primero exacta (`matchCard`), luego el mismo emparejador determinista del bot de Telegram
 * (por palabras completas y sinónimos del emisor: "amex" no cae en "Banamex"). Si queda ambigua o no hay ninguna, se devuelven las opciones.
 */
function resolveCard(ref: string, cards: Card[]): Card {
  const hit = matchCard(cards, ref);
  if (hit) return hit;
  const f = fold(ref);
  const hints = [...f.matchAll(/(?<![\p{L}\p{N}])(\d{3,4})(?![\p{L}\p{N}])/gu)].map((m) => m[1]);
  const m = matchCards(f, new Array(f.length).fill(false), cards, hints);
  if (m.ids.length === 1) return cards.find((c) => c.id === m.ids[0])!;
  const partial = cards.filter((c) => m.ids.includes(c.id));
  throw new WriteError(partial.length ? `"${ref.slice(0, 40)}" coincide con varias tarjetas; pregunta cuál` : `No encontré la tarjeta "${ref.slice(0, 40)}"`, { tarjetas: (partial.length ? partial : cards).map(cardOut) });
}

const addSchema = z.strictObject({
  amount: z.number().positive().describe("Monto TOTAL en pesos MXN (p. ej. 249.90). En una compra a meses, el total de la compra, no la mensualidad."),
  merchant: z.string().trim().min(1).max(120).describe("Comercio o concepto tal como lo dijo la persona (p. ej. 'Oxxo', 'Liverpool', 'Uber')."),
  card: z.string().trim().min(1).max(60).describe("Tarjeta: nombre, alias o terminación de 4 dígitos (usa list_cards si no sabes cuáles hay)."),
  date: z.string().optional().describe("Fecha de la compra 'YYYY-MM-DD' (hora de Ciudad de México). Omítela si fue hoy: se usa la hora actual."),
  installments: z.number().int().min(MSI_MIN).max(MSI_MAX).optional().describe(`Compra a meses sin intereses: número de mensualidades (${MSI_MIN}–${MSI_MAX}). Omítelo si fue de contado.`),
  confirmed: z.boolean().optional().describe(`true solo si la persona YA confirmó un monto de $${(CONFIRM_CENTS / 100).toLocaleString("en-US")} o más.`),
  allow_duplicate: z.boolean().optional().describe("true solo si la persona confirmó que NO es el gasto parecido que add_expense reportó como posible duplicado."),
});

const deleteSchema = z.strictObject({
  id: z.number().int().positive().describe("El id que devolvió add_expense."),
});

async function addExpense(a: z.output<typeof addSchema>, d: WriteDeps) {
  const cents = Math.round(a.amount * 100);
  if (cents < 1 || cents > MAX_CENTS) throw new WriteError("Monto fuera de rango (de $0.01 a $1,000,000)");
  if (Math.abs(a.amount * 100 - cents) > 1e-6) throw new WriteError("El monto tiene más de 2 decimales");
  const cards = await eligibleCards();
  if (!cards.length) throw new WriteError("No hay tarjetas activas en UzFinance");
  const card = resolveCard(a.card, cards);
  if (a.installments && isDebitCard(card)) throw new WriteError(`${card.name} es de débito: no tiene meses sin intereses`);

  const today = localDate(d.now);
  let at = d.now;
  let dated = false;
  if (a.date && a.date !== today) {
    if (!isRealDate(a.date)) throw new WriteError("Fecha inválida (usa YYYY-MM-DD)");
    if (a.date > today) throw new WriteError("Esa fecha aún no llega");
    if (Date.parse(today) - Date.parse(a.date) > MAX_AGE_DAYS * 86_400_000) throw new WriteError("Esa fecha es de hace más de un año; regístralo desde la app");
    at = cdmxAt(a.date);
    dated = true;
  }
  if (cents >= CONFIRM_CENTS && !a.confirmed) {
    throw new WriteError(`Es un monto alto ($${pesos(cents).toLocaleString("en-US")}): confirma con la persona y vuelve a llamar con confirmed=true`, { necesita: "confirmed" });
  }

  const hashOf = (seq?: number) => dedupeHash({ cardId: card.id, occurredAt: at, cents, merchantNormalized: normalizeMerchant(a.merchant), source: "manual", seq });
  let seq: number | undefined;
  if (!a.allow_duplicate) {
    const same = await findSimilarExpenses(card.id, cents, localDate(at), at);
    const x = same.find((y) => y.dedupeHash === hashOf()) ?? same[0];
    if (x) {
      throw new WriteError("Posible duplicado: ya hay un gasto igual en esa tarjeta. Pregunta si es otro y, si sí, vuelve a llamar con allow_duplicate=true", {
        necesita: "allow_duplicate",
        existente: {
          id: x.id, comercio: x.merchant, monto: pesos(x.amountCents), fecha: localDate(x.occurredAt), hora: localTime(x.occurredAt),
          via: x.sources.split(",").map((s) => SOURCE_LABELS[s.trim()] ?? s.trim()).join(" + "), a_meses: x.planId !== null,
        },
      });
    }
  } else if (await dedupeHashExists(hashOf())) {
    seq = 1;
    while (seq < 20 && (await dedupeHashExists(hashOf(seq)))) seq++;
  }

  const categorizer = d.categorizer ?? (await getCategorizer());
  const r = await ingestTransaction(
    { merchant: a.merchant, amountCents: cents, cardRef: card.name, cardId: card.id, occurredAt: at, seq, notes: `MCP · ${d.client}`.slice(0, 500), sourcesTag: mcpSourceTag(dated) },
    "manual",
    { categorizer },
  );
  if (r.status !== "inserted") throw new WriteError("Ese gasto ya estaba registrado (misma tarjeta, monto, comercio y minuto)");
  try {
    scheduleTransactionAlerts(r.id);
  } catch (e) {
    console.error("[mcp] no se pudo programar las alertas:", (e as Error)?.message);
  }
  let categoria: string | null = null;
  if (r.categoryId !== null) categoria = (await listCategories().catch(() => [])).find((k) => k.id === r.categoryId)?.name ?? null;

  let msi: Record<string, unknown> | null = null;
  if (a.installments) {
    try {
      const m = await attachMsiPlan({ txId: r.id, cardId: card.id, categoryId: r.categoryId, merchant: a.merchant, totalCents: cents, months: a.installments, purchaseYmd: localDate(at) });
      msi = { meses: m.n, mensualidad: pesos(m.monthlyCents), fechas_aproximadas: m.guessed };
    } catch (e) {
      console.error("[mcp] no se pudo crear el plan MSI:", ((e as Error)?.message ?? "").slice(0, 120));
      msi = { meses: a.installments, mensualidad: pesos(monthlyOf(cents, a.installments)), error: e instanceof MsiError ? e.message : "El gasto quedó guardado pero sin plan a meses; agrégalo desde la app" };
    }
  }
  return {
    registrado: true, id: r.id, comercio: a.merchant, monto: pesos(cents), tarjeta: card.name, fecha: localDate(at), hora: dated ? null : localTime(at),
    categoria, a_meses: msi,
  };
}

/** Borra un gasto que registró el MCP, solo si nadie más lo ha confirmado (sigue siendo `mcp`/`mcp-d`) y es reciente. Con su plan MSI manual. */
async function deleteExpense(a: z.output<typeof deleteSchema>) {
  const gone = await query<{ id: number; plan_id: number | null; merchant_raw: string; cents: number }>(
    `DELETE dbo.transactions OUTPUT DELETED.id, DELETED.plan_id, DELETED.merchant_raw, CAST(DELETED.amount_cents AS float) AS cents
     WHERE id=@id AND sources IN (@s, @sd) AND created_at >= DATEADD(day, -@days, SYSUTCDATETIME())`,
    { id: t.big(a.id), s: t.varchar(MCP_SOURCE), sd: t.varchar(mcpSourceTag(true)), days: t.int(DELETE_WINDOW_DAYS) },
  );
  if (!gone.length) {
    const still = await query<{ sources: string }>("SELECT sources FROM dbo.transactions WHERE id=@id", { id: t.big(a.id) });
    if (!still.length) throw new WriteError("No existe ese gasto (quizá ya se borró)");
    throw new WriteError(`No lo borro: no lo registró el MCP, ya lo confirmó otra fuente o tiene más de ${DELETE_WINDOW_DAYS} días. Bórralo desde la app si de verdad sobra.`);
  }
  const plan = gone[0].plan_id;
  if (plan !== null) await query("DELETE dbo.installment_plans WHERE id=@p AND source='manual' AND NOT EXISTS (SELECT 1 FROM dbo.transactions WHERE plan_id=@p)", { p: t.int(Number(plan)) });
  return { borrado: true, id: Number(gone[0].id), comercio: gone[0].merchant_raw, monto: pesos(Number(gone[0].cents)) };
}

async function listCardsTool() {
  return { tarjetas: (await eligibleCards()).map(cardOut), nota: "Las de débito no admiten meses sin intereses." };
}

type WriteTool = { name: string; title: string; description: string; schema: z.ZodType; destructive: boolean; readOnly: boolean; run: (args: never, d: WriteDeps) => Promise<unknown> };

const TOOLS: WriteTool[] = [
  {
    name: "list_cards", title: "Tarjetas", readOnly: true, destructive: false,
    description: "Tarjetas activas a las que se puede cargar un gasto (nombre, terminación y si es de débito).",
    schema: z.strictObject({}), run: () => listCardsTool(),
  },
  {
    name: "add_expense", title: "Registrar gasto", readOnly: false, destructive: false,
    description:
      "Registra un gasto en UzFinance (como el bot de Telegram): monto total, comercio, tarjeta y, opcionalmente, fecha y meses sin intereses. " +
      "Antes de llamarla ten claros los tres datos; si falta alguno, pregúntalo. Si responde con `necesita`, pregunta a la persona y vuelve a " +
      "llamar con ese campo en true; nunca lo pongas en true sin preguntar. Devuelve el `id` para poder deshacerlo con delete_expense.",
    schema: addSchema, run: (a: z.output<typeof addSchema>, d) => addExpense(a, d),
  },
  {
    name: "delete_expense", title: "Deshacer gasto", readOnly: false, destructive: true,
    description: `Deshace un gasto que registraste con add_expense (por su id), p. ej. si la persona dice "no, bórralo". Solo funciona con gastos del MCP de los últimos ${DELETE_WINDOW_DAYS} días que ninguna otra fuente haya confirmado.`,
    schema: deleteSchema, run: (a: z.output<typeof deleteSchema>) => deleteExpense(a),
  },
];

const BY_NAME = new Map(TOOLS.map((x) => [x.name, x]));
export const WRITE_TOOL_NAMES = new Set(BY_NAME.keys());

export const MCP_WRITE_TOOLS = TOOLS.map((x) => {
  const inputSchema = z.toJSONSchema(x.schema, { io: "input" }) as Record<string, unknown>;
  delete inputSchema.$schema;
  return {
    name: x.name, title: x.title, description: x.description, inputSchema,
    annotations: { title: x.title, readOnlyHint: x.readOnly, destructiveHint: x.destructive, idempotentHint: x.readOnly, openWorldHint: false },
  };
});

/** Ejecuta una herramienta de escritura. Nunca lanza: un error vuelve como texto para que el asistente lo explique o pregunte. */
export async function executeWriteTool(name: string, rawArgs: string, d: WriteDeps): Promise<ToolOutcome> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, content: JSON.stringify({ error: `Herramienta desconocida: ${name}` }) };
  let args: unknown;
  try { args = rawArgs.trim() ? JSON.parse(rawArgs) : {}; } catch { return { ok: false, content: JSON.stringify({ error: "Los argumentos no son JSON válido" }) }; }
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, content: JSON.stringify({ error: "Argumentos inválidos", detalle: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`) }) };
  try {
    return { ok: true, content: JSON.stringify(await tool.run(parsed.data as never, d)) };
  } catch (e) {
    if (e instanceof WriteError) return { ok: false, content: JSON.stringify({ error: e.message, ...e.extra }) };
    console.error(`[mcp] herramienta ${name} falló:`, ((e as Error)?.message ?? "").slice(0, 160));
    return { ok: false, content: JSON.stringify({ error: "No pude guardar en este momento; reintenta en unos segundos" }) };
  }
}
