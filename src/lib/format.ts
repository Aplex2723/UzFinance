import { TZ } from "./time";

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

export function monthLabel(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  const name = MONTHS[m - 1];
  return short ? `${name.slice(0, 3)} ${String(y).slice(2)}` : `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const dayFmt = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("es-MX", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const formatDay = (iso: string) => dayFmt.format(new Date(iso)).replace(".", "");
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

/** "Hoy", "Ayer" o "lun 12 oct" a partir de YYYY-MM-DD local. */
export function relativeDay(date: string, todayIso: string): string {
  const d = (s: string) => Date.parse(`${s}T00:00:00Z`);
  const diff = Math.round((d(todayIso) - d(date)) / 86400000);
  if (diff === 0) return "Hoy";
  if (diff === 1) return "Ayer";
  return dayFmt.format(new Date(`${date}T12:00:00Z`)).replace(".", "");
}

export const ISSUER_LABEL = { amex: "American Express", banamex: "Banamex", other: "Otras" } as const;
