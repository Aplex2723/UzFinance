import { TZ } from "@/lib/time";

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const hmFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const minutes = (hm: string): number | null => {
  const m = HM.exec(hm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Minutos desde la medianoche, hora de Ciudad de México. */
export function localMinutes(now: Date): number {
  const parts = hmFmt.formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  return h * 60 + Number(parts.find((p) => p.type === "minute")?.value ?? "0");
}

/**
 * ¿`now` cae en las horas de silencio (hora de Ciudad de México)? La ventana es [inicio, fin): "22:00"–"08:00" cruza la medianoche.
 * Apagadas, con horas inválidas o con inicio = fin (ventana vacía) nunca hay silencio.
 */
export function inQuietHours(now: Date, q: { enabled: boolean; start: string; end: string }): boolean {
  if (!q.enabled) return false;
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === null || e === null || s === e) return false;
  const n = localMinutes(now);
  return s < e ? n >= s && n < e : n >= s || n < e;
}
