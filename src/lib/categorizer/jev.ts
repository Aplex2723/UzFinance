import { query, t } from "@/lib/db/pool";
import { listCategories } from "@/lib/repo/categories";
import type { Categorization, CategorizeInput, Categorizer } from "./index";

/**
 * Jev (TypeSafe) vía OpenRouter: un modelo de decisión, no un chat. Se le manda un "estado" (el comercio) y una
 * pregunta `choice` cuyos `criteria` son las categorías con su descripción; responde UNA de ellas con probabilidades.
 * Por eso un comercio malicioso no puede inyectar instrucciones: la salida solo puede ser una de las categorías.
 * Docs: https://openrouter.ai/docs/guides/community/jev-tutorial
 */
export const JEV_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

/** Por debajo de esta probabilidad la categoría no se asigna sola: queda "Sin categoría" para que la revises. */
export const JEV_MIN_CONFIDENCE = 0.6;

export type JevCategory = { id: number; name: string; description: string | null };

/** Etiqueta estable y legible para Jev ("Restaurantes y cafés" → "restaurantes_y_cafes"); única dentro de la lista. */
export function categoryKey(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "categoria";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  taken.add(key);
  return key;
}

/** El comercio es entrada no confiable: sin caracteres de control, espacios colapsados, tope de largo. */
export function cleanMerchantForJev(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export function buildDecisionRequest(merchant: string, cats: JevCategory[]) {
  const taken = new Set<string>();
  const keyToId = new Map<string, number>();
  const criteria: Record<string, string> = {};
  for (const c of cats) {
    const key = categoryKey(c.name, taken);
    keyToId.set(key, c.id);
    criteria[key] = c.description?.trim() ? `${c.name}. ${c.description.trim()}` : c.name;
  }
  const body = {
    model: JEV_MODEL,
    state: { comercio: cleanMerchantForJev(merchant) },
    questions: {
      categoria: {
        type: "choice",
        instructions:
          "Un cargo de una tarjeta de crédito o débito en México se hizo en el comercio indicado en `comercio`. " +
          "¿En qué categoría de gasto cae? Elige según el tipo de negocio o servicio (las categorías listan ejemplos de comercios y abreviaturas de estados de cuenta).",
        criteria,
      },
    },
  };
  return { body, keyToId };
}

export type JevResult = { categoryId: number; confidence: number; probability: number; ranked: { categoryId: number; p: number }[] };

type DecisionAnswer = { type?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown };

/** Interpreta la respuesta; devuelve null si no es una elección conocida (nunca confía en texto libre). */
export function parseDecision(json: unknown, keyToId: Map<string, number>): JevResult | null {
  const ans = (json as { answers?: { categoria?: DecisionAnswer } } | null)?.answers?.categoria;
  if (!ans || ans.type !== "choice" || typeof ans.choice !== "string") return null;
  const categoryId = keyToId.get(ans.choice);
  if (categoryId === undefined) return null;
  const probs = ans.probabilities && typeof ans.probabilities === "object" ? (ans.probabilities as Record<string, unknown>) : {};
  const ranked = [...keyToId.entries()]
    .map(([k, id]) => ({ categoryId: id, p: typeof probs[k] === "number" ? (probs[k] as number) : 0 }))
    .sort((a, b) => b.p - a.p);
  const probability = typeof probs[ans.choice] === "number" ? (probs[ans.choice] as number) : 0;
  const confidence = typeof ans.confidence === "number" ? ans.confidence : probability;
  return { categoryId, confidence, probability, ranked };
}

export type JevOptions = {
  apiKey: string;
  timeoutMs: number;
  /** Para pruebas. */
  fetchImpl?: typeof fetch;
  /** Reintentos ante 429/5xx dentro del mismo tope de tiempo. */
  retries?: number;
};

/**
 * Llama a Jev. Devuelve null ante cualquier fallo (red, tope de tiempo, 4xx/5xx, respuesta rara):
 * categorizar es "lo mejor posible" y nunca debe tumbar una ingesta. La API key nunca se loguea ni sale en errores.
 */
export async function jevClassify(merchant: string, cats: JevCategory[], opts: JevOptions): Promise<JevResult | null> {
  if (!cats.length || !cleanMerchantForJev(merchant)) return null;
  const { body, keyToId } = buildDecisionRequest(merchant, cats);
  const doFetch = opts.fetchImpl ?? fetch;
  const deadline = Date.now() + opts.timeoutMs;
  const retries = opts.retries ?? 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) return null;
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(left),
      });
      if (res.ok) return parseDecision(await res.json(), keyToId);
      if (res.status === 429 || res.status >= 500) {
        const wait = Math.min(Number(res.headers.get("Retry-After")) * 1000 || 400 * (attempt + 1), Math.max(deadline - Date.now() - 50, 0));
        if (attempt < retries && wait > 0) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      } else if (res.status === 401 || res.status === 402 || res.status === 403) {
        console.error(`Jev: ${res.status} (revisa la API key / el saldo de OpenRouter)`);
      }
      return null;
    } catch {
      return null; // red caída o tope de tiempo
    }
  }
  return null;
}

/**
 * Orden: reglas del usuario → historial (el mismo comercio ya categorizado por una persona) → Jev.
 * El historial solo cuenta categorías puestas a mano o por regla (nunca las de Jev: un error no se auto-refuerza).
 */
export class JevCategorizer implements Categorizer {
  private cats?: Promise<JevCategory[]>;
  private memo = new Map<string, Promise<Categorization | null | undefined>>();

  constructor(
    private rules: Categorizer,
    private opts: JevOptions,
  ) {}

  private categories() {
    this.cats ??= listCategories().then((rows) => rows.map((c) => ({ id: c.id, name: c.name, description: c.description })));
    return this.cats;
  }

  private async history(merchantNormalized: string): Promise<number | null> {
    const r = await query<{ category_id: number }>(
      `SELECT TOP 1 category_id FROM dbo.transactions
       WHERE merchant_normalized=@m AND category_id IS NOT NULL AND (category_source IS NULL OR category_source IN ('manual','rule'))
       GROUP BY category_id
       ORDER BY SUM(CASE category_source WHEN 'manual' THEN 100 WHEN 'rule' THEN 50 ELSE 10 END) DESC, COUNT(*) DESC`,
      { m: t.str(merchantNormalized) },
    );
    return r[0]?.category_id ?? null;
  }

  /** undefined = Jev no contestó (fallo transitorio, se puede reintentar); null = contestó pero con poca seguridad. */
  private async viaJev(input: CategorizeInput): Promise<Categorization | null | undefined> {
    const res = await jevClassify(input.merchantRaw || input.merchantNormalized, await this.categories(), this.opts);
    if (!res) return undefined;
    if (res.probability < JEV_MIN_CONFIDENCE) return null;
    return { categoryId: res.categoryId, source: "jev", confidence: Math.round(res.probability * 1000) / 1000 };
  }

  async categorizeDetailed(input: CategorizeInput): Promise<Categorization | null> {
    const byRule = await this.rules.categorizeDetailed(input);
    if (byRule) return byRule;
    const key = input.merchantNormalized;
    const known = this.memo.get(key);
    if (known) return (await known) ?? null;
    const p = (async (): Promise<Categorization | null | undefined> => {
      const h = await this.history(key);
      if (h !== null) return { categoryId: h, source: "history", confidence: null };
      return this.viaJev(input);
    })();
    // Se memoriza lo decidido (incluida una duda de Jev); un fallo transitorio (timeout) no: el siguiente intento puede acertar.
    this.memo.set(key, p);
    p.then((v) => v === undefined && this.memo.delete(key), () => this.memo.delete(key));
    return (await p) ?? null;
  }

  async categorize(input: CategorizeInput): Promise<number | null> {
    return (await this.categorizeDetailed(input))?.categoryId ?? null;
  }
}
