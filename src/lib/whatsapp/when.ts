import { localDate, TZ } from "@/lib/time";

/** Fechas y horas en hora de Ciudad de México, sin depender de la zona del servidor (Azure corre en UTC). */
const wall = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

function parts(d: Date) {
  const o: Record<string, number> = {};
  for (const p of wall.formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** "14:03" en hora de CDMX. */
export function localTime(d: Date): string {
  const p = parts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isRealDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || y < 1970 || y > 2100) return false;
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}

export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Días de `a` a `b` (b - a). */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** El instante UTC en que en CDMX son las `hour`:00 de ese día (12:00 por omisión). */
export function cdmxAt(date: string, hour = 12): Date {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hour, 0, 0);
  let ms = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(ms));
    const diff = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - target;
    if (diff === 0) break;
    ms -= diff;
  }
  return new Date(ms);
}

const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

/** "hoy 14:03", "ayer", "3 oct" (con año si no es el actual). La hora solo se muestra hoy: en otros días es la marcada por omisión (12:00). */
export function whenLabel(at: Date, now: Date): string {
  const day = localDate(at);
  const today = localDate(now);
  const diff = daysBetween(day, today);
  if (diff === 0) return `hoy ${localTime(at)}`;
  if (diff === 1) return "ayer";
  if (diff === 2) return "anteayer";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MON[m - 1]}${y === Number(today.slice(0, 4)) ? "" : ` ${y}`}`;
}
