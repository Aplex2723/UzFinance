/** Fechas YYYY-MM-DD (hora local de Ciudad de México ya resuelta por quien llama). Sin husos: aritmética en UTC puro. */
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function addDays(iso: string, n: number): string {
  return new Date(ms(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Días de `from` a `to` (positivo si `to` es posterior). */
export function daysBetween(from: string, to: string): number {
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Semana ISO (lunes a domingo): "2026-W41". Las semanas que cruzan año pertenecen al año del jueves. */
export function isoWeekKey(iso: string): string {
  const d = new Date(ms(iso));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // jueves de esa semana
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** "4 de octubre". */
export function longDay(iso: string): string {
  return `${Number(iso.slice(8, 10))} de ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? "?"}`;
}
