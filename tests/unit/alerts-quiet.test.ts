import { describe, expect, it } from "vitest";
import { inQuietHours, localMinutes } from "@/lib/alerts/quiet";

// CDMX es UTC-6 todo el año (sin horario de verano desde 2022).
const at = (hhmmUtc: string, day = "2026-10-05") => new Date(`${day}T${hhmmUtc}:00Z`);
const Q = { enabled: true, start: "22:00", end: "08:00" };

describe("localMinutes", () => {
  it("convierte a hora de Ciudad de México", () => {
    expect(localMinutes(at("06:00"))).toBe(0);
    expect(localMinutes(at("05:59"))).toBe(23 * 60 + 59);
    expect(localMinutes(at("18:30"))).toBe(12 * 60 + 30);
  });
});

describe("inQuietHours", () => {
  it("ventana que cruza la medianoche: [22:00, 08:00)", () => {
    expect(inQuietHours(at("04:00"), Q)).toBe(true); // 22:00 CDMX
    expect(inQuietHours(at("06:00"), Q)).toBe(true); // 00:00
    expect(inQuietHours(at("13:59"), Q)).toBe(true); // 07:59
    expect(inQuietHours(at("14:00"), Q)).toBe(false); // 08:00: el fin ya no es silencio
    expect(inQuietHours(at("18:00"), Q)).toBe(false); // mediodía
    expect(inQuietHours(at("03:59"), Q)).toBe(false); // 21:59
  });
  it("ventana dentro del mismo día", () => {
    const q = { enabled: true, start: "13:00", end: "15:30" };
    expect(inQuietHours(at("19:00"), q)).toBe(true); // 13:00
    expect(inQuietHours(at("21:29"), q)).toBe(true);
    expect(inQuietHours(at("21:30"), q)).toBe(false);
    expect(inQuietHours(at("18:59"), q)).toBe(false);
  });
  it("la hora se mide en CDMX, no en UTC (23:00 UTC ya es 17:00 local)", () => {
    expect(inQuietHours(at("23:00"), { enabled: true, start: "22:00", end: "23:59" })).toBe(false);
    expect(inQuietHours(at("23:00"), { enabled: true, start: "16:00", end: "18:00" })).toBe(true);
  });
  it("apagadas, inicio = fin u horas inválidas: nunca hay silencio", () => {
    expect(inQuietHours(at("06:00"), { ...Q, enabled: false })).toBe(false);
    expect(inQuietHours(at("06:00"), { enabled: true, start: "22:00", end: "22:00" })).toBe(false);
    expect(inQuietHours(at("06:00"), { enabled: true, start: "25:00", end: "08:00" })).toBe(false);
    expect(inQuietHours(at("06:00"), { enabled: true, start: "", end: "" })).toBe(false);
  });
});
