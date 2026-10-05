import { getCategorizer } from "@/lib/categorizer";
import { CHANNEL_NAME, chatSourceTag, type ChatChannel } from "@/lib/chat-sources";
import { normalizeMerchant } from "@/lib/merchant";
import { scheduleTransactionAlerts } from "@/lib/alerts/schedule";
import { listCategories } from "@/lib/repo/categories";
import { dedupeHash, ingestTransaction } from "@/lib/repo/transactions";
import { dedupeHashExists, findSimilarExpenses, linkMessageTx, savePending, takePending, type PendingStep } from "@/lib/repo/whatsapp";
import { localDate } from "@/lib/time";
import type { Card } from "@/lib/types";
import { endsWithLast4, fold, matchCards } from "./cards";
import {
  CONFIRM_CENTS, parseAmountAnswer, parseChoice, parseEndingAnswer, parseExpense, parseMerchantAnswer, parseYesNo, sanitizeInput, type AmountNote, type Parsed,
} from "./parse-expense";
import * as R from "./replies";
import type { HandleDeps, InboundMessage, Sender } from "./types";
import { cdmxAt, whenLabel } from "./when";

/**
 * Conversación de un gasto escrito (WhatsApp o Telegram, la lógica es la misma): lo que se entendió se completa con preguntas cortas
 * (tarjeta, comercio, monto), se confirma si es alto o parece repetido, y se guarda. Lo pendiente vive en `whatsapp_pending` (uno por
 * remitente —en Telegram, por persona aunque el chat sea un grupo—, caduca a los 10 min).
 */
export const PENDING_MINUTES = 10;

export type Ctx = {
  msg: InboundMessage;
  sender: Sender;
  /** Canal del mensaje: decide la marca de las notas, la etiqueta de `sources` y el texto de ayuda. */
  channel: ChatChannel;
  /** Hora REAL de proceso (la guarda de 48 h se evalúa contra esta). */
  now: Date;
  /** Cuándo se ENVIÓ el mensaje (recortada a `now` si venía adelantada): de aquí salen "hoy", "ayer", la hora del gasto y la caducidad de lo pendiente. */
  sentAt: Date;
  deps: HandleDeps;
  /** Tarjetas elegibles (activas, sin las de sistema). */
  cards: Card[];
};

export type Outcome = { reply: string; status: "done" | "ignored" | "failed"; txId?: number | null; documentId?: number | null };

type Need = "amount" | "merchant" | "card" | "confirm" | "duplicate";
type Draft = {
  amountCents: number | null;
  /** Por qué falta el monto (para preguntar con las palabras correctas). */
  note?: AmountNote | null;
  /** Solo en pendientes viejos: equivale a note = varios números. */
  ambiguous?: boolean;
  merchant: string | null;
  cardId: number | null;
  occurredAt: string;
  /** El mensaje traía una fecha explícita distinta de hoy: la hora (12:00) es artificial y la fila lleva la etiqueta `…-d`. */
  dated?: boolean;
  confirmed?: boolean;
  dupOk?: boolean;
};
type Pending = {
  need: Need;
  draft: Draft;
  /** Tarjetas candidatas que dejó el texto (vacío = todas). */
  choices: number[];
  /** Solo en need="card": los ids de la lista TAL COMO SE MOSTRÓ (en ese orden). El número que responda el usuario se resuelve contra esto. */
  shown?: number[];
  /** Solo en need="card": la lista es un subconjunto ("hay varias tarjetas posibles"). */
  subset?: boolean;
  tries: number;
  hint?: string | null;
};

/** La tabla solo admite 4 pasos; "¿cuánto fue?" es, como el comercio, un dato de texto libre. */
const STEP: Record<Need, PendingStep> = { amount: "merchant", merchant: "merchant", card: "card", confirm: "confirm", duplicate: "duplicate" };

const NEEDS = new Set<Need>(["amount", "merchant", "card", "confirm", "duplicate"]);

function revive(step: PendingStep, payload: string): Pending | null {
  try {
    const p = JSON.parse(payload) as Pending;
    if (!p || typeof p !== "object" || !NEEDS.has(p.need) || STEP[p.need] !== step || !p.draft || typeof p.draft.occurredAt !== "string" || Number.isNaN(Date.parse(p.draft.occurredAt))) return null;
    const ids = (a: unknown) => (Array.isArray(a) ? a.filter((n) => Number.isInteger(n)) : []);
    return { need: p.need, draft: p.draft, choices: ids(p.choices), shown: p.shown ? ids(p.shown) : undefined, subset: !!p.subset, tries: Number(p.tries) || 0, hint: p.hint ?? null };
  } catch {
    return null;
  }
}

const summaryOf = (d: Draft): R.Summary => ({ merchant: d.merchant, cents: d.amountCents });
const cardById = (c: Ctx, id: number | null) => c.cards.find((x) => x.id === id) ?? null;

function questionFor(c: Ctx, p: Pending): string {
  const d = p.draft;
  switch (p.need) {
    case "amount":
      return R.askAmount(summaryOf(d), d.note ?? (d.ambiguous ? { kind: "many" } : null));
    case "merchant":
      return R.askMerchant(summaryOf(d));
    case "card": {
      const shown = shownIds(c, p).map((id) => cardById(c, id)).filter((x): x is Card => !!x);
      return R.askCard(summaryOf(d), shown.length ? shown : c.cards.slice(0, 9), { hint: p.hint, subset: p.subset ?? p.choices.length > 1 });
    }
    case "confirm":
      return R.askConfirm(summaryOf(d), cardById(c, d.cardId)?.name ?? "", whenLabel(new Date(d.occurredAt), c.sentAt));
    case "duplicate":
      return p.hint ? p.hint : "";
  }
}

/** La lista de tarjetas que se mostró (o, en pendientes viejos sin `shown`, la que se habría mostrado). Máximo 9: se responde con el número. */
function shownIds(c: Ctx, p: Pending): number[] {
  if (p.shown?.length) return p.shown;
  const pool = p.choices.length ? p.choices.map((id) => cardById(c, id)).filter((x): x is Card => !!x) : c.cards;
  return pool.slice(0, 9).map((x) => x.id);
}

async function ask(c: Ctx, p: Pending, text?: string): Promise<Outcome> {
  const q = text ?? questionFor(c, p);
  await savePending(c.msg.from, STEP[p.need], JSON.stringify(p), new Date(c.sentAt.getTime() + PENDING_MINUTES * 60_000));
  return { reply: q, status: "done" };
}

/** Siguiente paso de un gasto: pide lo que falta, confirma si hace falta y, si ya está todo, lo guarda. */
async function advance(c: Ctx, draft: Draft, choices: number[], hint?: string | null): Promise<Outcome> {
  if (!c.cards.length) return { reply: R.NO_CARDS, status: "ignored" };
  const d = { ...draft };
  if (d.amountCents === null) return ask(c, { need: "amount", draft: d, choices, tries: 0, hint });
  if (!d.merchant) return ask(c, { need: "merchant", draft: d, choices, tries: 0, hint });
  if (d.cardId !== null && !cardById(c, d.cardId)) d.cardId = null; // se desactivó mientras tanto
  if (d.cardId === null) {
    // Se guardan los ids de la lista TAL COMO SE MUESTRA (también cuando son todas): el número que conteste el usuario se resuelve contra esto.
    const cands = choices.map((id) => cardById(c, id)).filter((x): x is Card => !!x);
    const list = (cands.length ? cands : c.cards).slice(0, 9);
    return ask(c, { need: "card", draft: d, choices, shown: list.map((x) => x.id), subset: cands.length > 1, tries: 0, hint });
  }
  const card = cardById(c, d.cardId)!;
  const at = new Date(d.occurredAt);
  if (d.amountCents >= CONFIRM_CENTS && !d.confirmed) return ask(c, { need: "confirm", draft: d, choices: [], tries: 0 });

  if (!d.dupOk) {
    const q = await duplicateQuestion(c, d, card, at);
    if (q) return ask(c, { need: "duplicate", draft: d, choices: [], tries: 0, hint: q }, q);
  }
  return save(c, d, card, d.dupOk ? await freeSeq(card, d, at) : undefined);
}

const hashOf = (card: Card, d: Draft, at: Date, seq?: number) =>
  dedupeHash({ cardId: card.id, occurredAt: at, cents: d.amountCents!, merchantNormalized: normalizeMerchant(d.merchant!), source: "manual", seq });

/**
 * ¿Hay ya un gasto igual (misma tarjeta y monto en ±1 día, de cualquier fuente)? Si lo hay —incluido uno con la MISMA huella (mismo
 * comercio y minuto, p. ej. dos gastos con fecha explícita que caen a las 12:00)— se pregunta "¿es otro?": solo el reintento literal del
 * mismo mensaje se ignora, y eso ya lo cubre la idempotencia por id de mensaje, no esta pregunta.
 */
async function duplicateQuestion(c: Ctx, d: Draft, card: Card, at: Date): Promise<string | null> {
  const same = await findSimilarExpenses(card.id, d.amountCents!, localDate(at), at);
  const hash = hashOf(card, d, at);
  const x = same.find((y) => y.dedupeHash === hash) ?? same[0];
  if (!x) return null;
  return R.askDuplicate({ merchant: x.merchant, cents: x.amountCents, when: whenLabel(x.occurredAt, c.sentAt), sources: x.sources });
}

/** El `seq` que hace distinta la huella de un gasto que el usuario confirmó como "otro" aunque coincida con uno existente (sin `seq` si no choca). */
async function freeSeq(card: Card, d: Draft, at: Date): Promise<number | undefined> {
  if (!(await dedupeHashExists(hashOf(card, d, at)))) return undefined;
  for (let n = 1; n <= 20; n++) if (!(await dedupeHashExists(hashOf(card, d, at, n)))) return n;
  return 20;
}

async function save(c: Ctx, d: Draft, card: Card, seq?: number): Promise<Outcome> {
  const at = new Date(d.occurredAt);
  const categorizer = c.deps.categorizer ?? (await getCategorizer());
  const r = await ingestTransaction(
    {
      merchant: d.merchant!, amountCents: d.amountCents!, cardRef: card.name, cardId: card.id, occurredAt: at, seq,
      notes: `${CHANNEL_NAME[c.channel]} · ${R.plain(c.sender.name, 60)}`.slice(0, 500),
      // Con fecha explícita la hora es artificial (12:00): etiqueta aparte que no se funde sola con un Atajo o correo (ver chat-sources.ts).
      sourcesTag: chatSourceTag(c.channel, !!d.dated),
    },
    "manual",
    { categorizer },
  );
  if (r.status !== "inserted") {
    // Misma huella (carrera con otro mensaje idéntico): sin confirmación previa se pregunta; ya confirmado, no se duplica.
    const q = d.dupOk ? null : await duplicateQuestion(c, d, card, at);
    return q ? ask(c, { need: "duplicate", draft: d, choices: [], tries: 0, hint: q }, q) : { reply: R.SAME_TWICE, status: "done" };
  }
  // Lo PRIMERO tras el INSERT: ligar el gasto a este mensaje, para que "deshacer" y un reproceso lo encuentren aunque el proceso muera.
  try {
    await linkMessageTx(c.msg.id, r.id);
  } catch (e) {
    console.error("[chat] no se pudo ligar el gasto al mensaje:", (e as Error)?.message);
  }
  try {
    scheduleTransactionAlerts(r.id);
  } catch (e) {
    console.error("[chat] no se pudo programar las alertas:", (e as Error)?.message);
  }
  let category: string | null = null;
  if (r.categoryId !== null) {
    try {
      category = (await listCategories()).find((k) => k.id === r.categoryId)?.name ?? null;
    } catch {
      /* el nombre de la categoría es decoración: el gasto ya está guardado */
    }
  }
  return { reply: R.registered({ cents: d.amountCents!, merchant: d.merchant!, card: card.name, when: whenLabel(at, c.sentAt), category }), status: "done", txId: r.id };
}

/** Respuesta inválida: la primera vez se repite la pregunta; la segunda se cancela. */
async function invalid(c: Ctx, p: Pending, why?: string): Promise<Outcome> {
  if (p.tries >= 1) return { reply: R.GAVE_UP, status: "done" };
  return ask(c, { ...p, tries: p.tries + 1 }, R.retry(questionFor(c, p), why));
}

/**
 * Elegir tarjeta. El número se resuelve contra la lista que SE MOSTRÓ (`p.shown`), no contra la lista vigente de tarjetas; una cifra de 3-4
 * dígitos ("296", "1005") es una terminación si coincide con una tarjeta de la lista, y solo si no, se intenta como número de opción.
 */
function answerCard(c: Ctx, p: Pending, text: string): { cardId: number } | { error: string } {
  const ids = shownIds(c, p);
  const shown = ids.map((id) => cardById(c, id));
  const bare = /^#?\s*(\d{1,4})\s*[.)]?$/.exec(sanitizeInput(text));
  if (bare) {
    const digits = bare[1];
    if (digits.length >= 3) {
      for (const pool of [shown.filter((x): x is Card => !!x), c.cards]) {
        const m = pool.filter((x) => endsWithLast4(x.last4, digits));
        if (m.length === 1) return { cardId: m[0].id };
        if (m.length > 1) return { error: `Hay varias tarjetas que terminan en ${digits}: responde con el número de la lista.` };
      }
    }
  }
  const n = parseChoice(text);
  if (!Number.isNaN(n)) {
    if (n < 1 || n > ids.length) return { error: `Ese número no está en la lista (es del 1 al ${ids.length}).` };
    const card = shown[n - 1];
    return card ? { cardId: card.id } : { error: "Esa tarjeta ya no está disponible." };
  }
  const clean = sanitizeInput(text);
  if (!clean || clean.length > 80) return { error: "No te entendí." };
  const f = fold(clean);
  const mask = new Array(clean.length).fill(false);
  const hints = [...f.matchAll(/(?<![\p{L}\p{N}])(\d{3,4})(?![\p{L}\p{N}])/gu)].map((m) => m[1]);
  for (const pool of [shown.filter((x): x is Card => !!x), c.cards]) {
    const m = matchCards(f, mask, pool, hints);
    if (m.ids.length === 1) return { cardId: m.ids[0] };
  }
  return { error: "No supe cuál tarjeta es." };
}

async function answerPending(c: Ctx, p: Pending, text: string): Promise<Outcome> {
  const yn = parseYesNo(text);
  switch (p.need) {
    case "confirm":
      if (yn === "yes") return advance(c, { ...p.draft, confirmed: true }, []);
      if (yn === "no") return { reply: R.CANCELLED, status: "done" };
      return invalid(c, p, "Responde *sí* o *no*.");
    case "duplicate":
      if (yn === "yes") return advance(c, { ...p.draft, dupOk: true }, []);
      if (yn === "no") return { reply: R.NOT_ANOTHER, status: "done" };
      return invalid(c, p, "Responde *sí* o *no*.");
    case "amount": {
      // "oxxo 1234": si el usuario aclara que 1234 es la terminación, la tarjeta queda elegida y falta el monto.
      // "7 eleven 296": si aclara que 296 es la terminación, la tarjeta queda elegida y el monto es la otra cifra ($7).
      const note = p.draft.note;
      if (note?.kind === "last4" || note?.kind === "either") {
        const digits = parseEndingAnswer(text);
        if (digits && (note.kind === "last4" || endsWithLast4(note.ending, digits))) {
          const m = c.cards.filter((x) => endsWithLast4(x.last4, digits));
          if (m.length !== 1) return invalid(c, p, `No encontré una sola tarjeta que termine en ${digits}.`);
          return advance(c, { ...p.draft, cardId: m[0].id, amountCents: note.kind === "either" ? note.cents : null, note: null, ambiguous: false }, [], null);
        }
      }
      const a = parseAmountAnswer(text);
      if ("error" in a) return invalid(c, p, a.error);
      return advance(c, { ...p.draft, amountCents: a.cents, note: null, ambiguous: false }, p.choices, p.hint);
    }
    case "merchant": {
      if (yn === "no") return { reply: R.CANCELLED, status: "done" };
      const m = yn === "yes" ? null : parseMerchantAnswer(text);
      if (!m) return invalid(c, p);
      return advance(c, { ...p.draft, merchant: m }, p.choices, p.hint);
    }
    case "card": {
      // Si alguna tarjeta de la lista mostrada se desactivó mientras tanto, los números ya no coinciden con lo que ve el usuario: se vuelve a preguntar.
      if (shownIds(c, p).some((id) => !cardById(c, id))) return advance(c, { ...p.draft, cardId: null }, [], null);
      const a = answerCard(c, p, text);
      if ("error" in a) return invalid(c, p, a.error);
      return advance(c, { ...p.draft, cardId: a.cardId }, [], null);
    }
  }
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Un mensaje de texto que no es un comando: respuesta a lo pendiente, o un gasto nuevo.
 *
 * Con algo pendiente, el mensaje es LA RESPUESTA salvo que sea claramente otro gasto:
 *  - esperando comercio: "7 eleven", "Oxxo 24 horas", "Sears 2", "Mixup 3 Rios" son el comercio. Solo es un gasto nuevo si trae un monto
 *    marcado ($, pesos, mxn…) y además un comercio claro ("Starbucks $120");
 *  - esperando monto: un gasto completo (monto + comercio) reemplaza lo pendiente; "180", "$180 pesos" o "fueron 180" responden;
 *  - tarjeta / confirmación / duplicado: un gasto completo reemplaza lo pendiente.
 */
export async function handleText(c: Ctx, rawText: string): Promise<Outcome> {
  const text = sanitizeInput(rawText);
  const parsed: Parsed = parseExpense(text, { todayYmd: localDate(c.sentAt), cards: c.cards });
  const complete = parsed.kind === "expense" && parsed.amountCents !== null && parsed.merchant !== null;

  // takePending lee y borra a la vez: dos respuestas simultáneas no consumen el mismo pendiente.
  const row = await takePending(c.msg.from);
  const pending = row && row.expiresAt.getTime() >= c.sentAt.getTime() ? revive(row.step, row.payload) : null;

  if (pending) {
    const newExpense = complete && (pending.need === "merchant" ? parsed.kind === "expense" && parsed.amountMarked : true);
    if (!newExpense && !(parsed.kind === "reject" && words(text) > 2)) return answerPending(c, pending, text);
  }

  if (parsed.kind === "expense") {
    const draft: Draft = {
      amountCents: parsed.amountCents, note: parsed.amountNote, merchant: parsed.merchant,
      cardId: parsed.cardIds.length === 1 ? parsed.cardIds[0] : null,
      occurredAt: (parsed.date.kind === "today" ? c.sentAt : cdmxAt(parsed.date.ymd)).toISOString(),
      dated: parsed.date.kind === "date",
    };
    return advance(c, draft, parsed.cardIds.length > 1 ? parsed.cardIds : [], parsed.unmatchedHint);
  }
  if (parsed.kind === "reject") return { reply: parsed.reason, status: "ignored" };
  return { reply: parseYesNo(text) ? R.OUT_OF_CONTEXT : R.NOT_UNDERSTOOD, status: "ignored" };
}
