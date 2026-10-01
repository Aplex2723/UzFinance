import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readLimitedText } from "@/lib/security/body";
import { clientIp, RateLimiter } from "@/lib/security/ratelimit";
import { extractBearer, safeEqual, verifyIngestToken } from "@/lib/security/token";
import { isSameOrigin } from "@/lib/api";
import { csvCell } from "@/lib/csv-export";

const T = "a".repeat(40);

describe("token de ingesta", () => {
  it("safeEqual compara correctamente", () => {
    expect(safeEqual(T, T)).toBe(true);
    expect(safeEqual(T, T + "x")).toBe(false);
    expect(safeEqual("", T)).toBe(false);
  });
  it("extractBearer exige esquema y formato", () => {
    expect(extractBearer(`Bearer ${T}`)).toBe(T);
    for (const bad of [null, "", T, `bearer ${T}`, "Bearer short", `Bearer ${T} extra`, `Basic ${T}`]) expect(extractBearer(bad)).toBeNull();
  });
  it("verifica vigente y, en rotación, el anterior", () => {
    const prev = "b".repeat(40);
    expect(verifyIngestToken(`Bearer ${T}`, T)).toBe(true);
    expect(verifyIngestToken(`Bearer ${prev}`, T)).toBe(false);
    expect(verifyIngestToken(`Bearer ${prev}`, T, prev)).toBe(true);
    expect(verifyIngestToken(`Bearer ${"c".repeat(40)}`, T, prev)).toBe(false);
    expect(verifyIngestToken(null, T)).toBe(false);
  });
});

describe("RateLimiter", () => {
  it("bloquea al pasar el límite y se reinicia al terminar la ventana", () => {
    const rl = new RateLimiter(3, 1000);
    expect([1, 2, 3].map(() => rl.hit("ip", 0))).toEqual([true, true, true]);
    expect(rl.hit("ip", 10)).toBe(false);
    expect(rl.blocked("ip", 20)).toBe(true);
    expect(rl.retryAfterSeconds("ip", 20)).toBe(1);
    expect(rl.hit("otra", 10)).toBe(true);
    expect(rl.hit("ip", 1001)).toBe(true);
  });
  it("clientIp toma el primer XFF y quita el puerto", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9:5122, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("readLimitedText", () => {
  it("lee bodies pequeños", async () => {
    expect(await readLimitedText(new Request("http://x", { method: "POST", body: "hola" }), 100)).toBe("hola");
  });
  it("rechaza por Content-Length y por bytes reales", async () => {
    await expect(readLimitedText(new Request("http://x", { method: "POST", body: "x".repeat(50), headers: { "content-length": "50" } }), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(50))); c.close(); } });
    await expect(readLimitedText(new Request("http://x", { method: "POST", body: stream, duplex: "half" } as RequestInit), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("anti-CSRF y CSV", () => {
  const r = (h: Record<string, string>) => new Request("http://localhost:3000/api/x", { method: "POST", headers: h });
  it("isSameOrigin", () => {
    expect(isSameOrigin(r({ host: "app.test", origin: "https://app.test" }))).toBe(true);
    expect(isSameOrigin(r({ host: "app.test", origin: "https://evil.test" }))).toBe(false);
    expect(isSameOrigin(r({ host: "app.test", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(r({ host: "app.test" }))).toBe(true);
  });
  it("csvCell escapa y neutraliza fórmulas", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("+52 55")).toBe("'+52 55");
    expect(csvCell(12.5)).toBe("12.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell("-12.50")).toBe("'-12.50"); // texto, no número
  });
});
