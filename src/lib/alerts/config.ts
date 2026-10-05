import { z } from "zod";
import { normalizeMerchant } from "@/lib/merchant";
import { ALERT_RULES, type AlertRule, type AlertSeverity } from "./types";

export type AlertConfig = {
  /** Cada regla se puede apagar por separado. */
  enabled: Record<AlertRule, boolean>;
  /** Compra fuerte por monto absoluto (centavos). */
  largePurchaseCents: number;
  /** Compra fuerte contra lo habitual: N veces la mediana del comercio/categoría. */
  largeVsTypicalFactor: number;
  /** Mínimo para que cuente la regla relativa (un cafecito 4 veces más caro no es noticia). */
  largeRelativeMinCents: number;
  /** Comercio nunca visto: monto desde el que avisa. */
  newMerchantCents: number;
  /** Ritmo: % por encima del mismo periodo del mes anterior que dispara el aviso. */
  paceTolerancePct: number;
  /** Ritmo: diferencia mínima contra el mes anterior (centavos). */
  paceMinDiffCents: number;
  /** Pico del día: N veces el promedio diario de los últimos 30 días. */
  dailySpikeFactor: number;
  dailySpikeMinCents: number;
  /** Meta de ahorro: holgura (%) antes de avisar que te alejas del ritmo. */
  goalTolerancePct: number;
  /** Comercios (normalizados) que nunca generan alertas. */
  mutedMerchants: string[];
  mutedCategoryIds: number[];
  /** Solo se guarda: el envío futuro lo respeta. */
  whatsapp: { enabled: boolean; minSeverity: AlertSeverity };
  /** Horas de silencio (hora de Ciudad de México), "HH:MM". Solo se guardan. */
  quietHours: { enabled: boolean; start: string; end: string };
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: Object.fromEntries(ALERT_RULES.map((r) => [r, true])) as Record<AlertRule, boolean>,
  largePurchaseCents: 5_000_00,
  largeVsTypicalFactor: 3,
  largeRelativeMinCents: 500_00,
  newMerchantCents: 2_000_00,
  paceTolerancePct: 25,
  paceMinDiffCents: 1_000_00,
  dailySpikeFactor: 3,
  dailySpikeMinCents: 1_500_00,
  goalTolerancePct: 20,
  mutedMerchants: [],
  mutedCategoryIds: [],
  whatsapp: { enabled: false, minSeverity: "warn" },
  quietHours: { enabled: false, start: "22:00", end: "08:00" },
};

const MAX_CENTS = 1_000_000_00;
const cents = (min: number) => z.number().int().min(min).max(MAX_CENTS);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const merchant = z.string().trim().min(1).max(80).transform((s) => normalizeMerchant(s)).pipe(z.string().min(1));
const D = DEFAULT_ALERT_CONFIG;

/**
 * `lenient` (lectura): cada campo inválido o ausente cae a su valor por defecto; una configuración corrupta nunca tumba nada.
 * `strict` (escritura): parche parcial; cualquier valor fuera de rango o clave desconocida es un error de validación.
 */
function buildSchema(strict: boolean) {
  const f = <T extends z.ZodType>(s: T, def: z.output<T>): z.ZodType<z.output<T>> => (strict ? (s.optional() as never) : (s.catch(def) as never));
  const obj = <S extends z.ZodRawShape>(shape: S, def: unknown) => (strict ? z.strictObject(shape).partial() : z.object(shape).catch(def as never));
  const enabledShape = Object.fromEntries(ALERT_RULES.map((r) => [r, f(z.boolean(), true)])) as Record<AlertRule, z.ZodType<boolean>>;
  const shape = {
    enabled: obj(enabledShape, D.enabled),
    largePurchaseCents: f(cents(100_00), D.largePurchaseCents),
    largeVsTypicalFactor: f(z.number().min(1.5).max(50), D.largeVsTypicalFactor),
    largeRelativeMinCents: f(cents(1_00), D.largeRelativeMinCents),
    newMerchantCents: f(cents(100_00), D.newMerchantCents),
    paceTolerancePct: f(z.number().min(5).max(300), D.paceTolerancePct),
    paceMinDiffCents: f(cents(1_00), D.paceMinDiffCents),
    dailySpikeFactor: f(z.number().min(1.5).max(50), D.dailySpikeFactor),
    dailySpikeMinCents: f(cents(1_00), D.dailySpikeMinCents),
    goalTolerancePct: f(z.number().min(0).max(100), D.goalTolerancePct),
    mutedMerchants: f(z.array(merchant).max(100), D.mutedMerchants),
    mutedCategoryIds: f(z.array(z.number().int().positive()).max(100), D.mutedCategoryIds),
    whatsapp: obj({ enabled: f(z.boolean(), D.whatsapp.enabled), minSeverity: f(z.enum(["info", "warn", "high"]), D.whatsapp.minSeverity) }, D.whatsapp),
    quietHours: obj({ enabled: f(z.boolean(), D.quietHours.enabled), start: f(hhmm, D.quietHours.start), end: f(hhmm, D.quietHours.end) }, D.quietHours),
  };
  return strict ? z.strictObject(shape).partial() : z.object(shape);
}

const lenient = buildSchema(false);
const strictPatch = buildSchema(true);

const uniq = <T>(xs: T[]) => [...new Set(xs)];
const clone = (c: AlertConfig): AlertConfig => structuredClone(c);

/** Lee una configuración guardada (cualquier cosa: JSON corrupto, null, tipos equivocados) y devuelve una válida y completa. */
export function parseAlertConfig(raw: unknown): AlertConfig {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return clone(D);
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return clone(D);
  const r = lenient.safeParse(v);
  if (!r.success) return clone(D);
  const c = structuredClone(r.data) as unknown as AlertConfig; // el esquema puede devolver los defaults por referencia
  return { ...c, mutedMerchants: uniq(c.mutedMerchants), mutedCategoryIds: uniq(c.mutedCategoryIds) };
}

/** Aplica un parche parcial (estricto: lanza ZodError si algo no es válido) sobre `current`. */
export function applyAlertConfigPatch(current: AlertConfig, patch: unknown): AlertConfig {
  const p = strictPatch.parse(patch) as Partial<Omit<AlertConfig, "enabled" | "whatsapp" | "quietHours">> & {
    enabled?: Partial<AlertConfig["enabled"]>;
    whatsapp?: Partial<AlertConfig["whatsapp"]>;
    quietHours?: Partial<AlertConfig["quietHours"]>;
  };
  const next: AlertConfig = {
    ...current,
    ...Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== undefined && !["enabled", "whatsapp", "quietHours"].includes(k))),
    enabled: { ...current.enabled, ...stripUndefined(p.enabled) },
    whatsapp: { ...current.whatsapp, ...stripUndefined(p.whatsapp) },
    quietHours: { ...current.quietHours, ...stripUndefined(p.quietHours) },
  };
  next.mutedMerchants = uniq(next.mutedMerchants);
  next.mutedCategoryIds = uniq(next.mutedCategoryIds);
  return next;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
}
