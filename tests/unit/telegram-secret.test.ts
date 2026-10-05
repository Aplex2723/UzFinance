import { describe, expect, it } from "vitest";
import { limiterIp } from "@/lib/security/trusted-ip";
import { limiterIp as reexported } from "@/lib/telegram/ip";
import { verifySecret } from "@/lib/telegram/secret";
import { TG } from "../tg-webhook-fixtures";

describe("verifySecret", () => {
  it("igual → true", () => expect(verifySecret(TG.secret, TG.secret)).toBe(true));
  it.each([
    ["distinto", TG.secret.slice(0, -1) + "X"],
    ["longitud distinta (más corto)", TG.secret.slice(0, 10)],
    ["longitud distinta (más largo)", TG.secret + "0"],
    ["ausente (null)", null],
    ["ausente (undefined)", undefined],
    ["vacío", ""],
    ["mayúsculas cambiadas", TG.secret.toUpperCase()],
    ["con espacios alrededor", ` ${TG.secret} `],
  ])("%s → false", (_n, header) => {
    expect(verifySecret(TG.secret, header as string | null | undefined)).toBe(false);
  });
  it("un secreto esperado vacío nunca autoriza (ni siquiera con encabezado vacío)", () => {
    expect(verifySecret("", "")).toBe(false);
    expect(verifySecret("", null)).toBe(false);
  });
});

describe("limiterIp: la ÚLTIMA entrada de X-Forwarded-For (la que agrega el proxy de Azure)", () => {
  const ip = (h: Record<string, string>) => limiterIp(new Headers(h));
  it("una sola entrada", () => expect(ip({ "x-forwarded-for": "198.51.100.7" })).toBe("198.51.100.7"));
  it("toma la última, no la primera (la primera la controla el cliente)", () => {
    expect(ip({ "x-forwarded-for": "149.154.167.10, 203.0.113.9, 198.51.100.7" })).toBe("198.51.100.7");
    expect(ip({ "x-forwarded-for": "149.154.167.10,198.51.100.7" })).toBe("198.51.100.7");
  });
  it("quita :puerto de IPv4 y de [IPv6]:puerto", () => {
    expect(ip({ "x-forwarded-for": "1.2.3.4, 198.51.100.7:51234" })).toBe("198.51.100.7");
    expect(ip({ "x-forwarded-for": "[2001:db8::1]:443" })).toBe("2001:db8::1");
    expect(ip({ "x-forwarded-for": "2001:db8::2" })).toBe("2001:db8::2");
  });
  it("ignora entradas vacías al final y usa x-client-ip o 'unknown' como respaldo", () => {
    expect(ip({ "x-forwarded-for": "198.51.100.7, " })).toBe("198.51.100.7");
    expect(ip({ "x-client-ip": "198.51.100.8" })).toBe("198.51.100.8");
    expect(ip({})).toBe("unknown");
    expect(ip({ "x-forwarded-for": " , " })).toBe("unknown");
  });
  it("telegram/ip reexporta la misma función (compartida con WhatsApp)", () => expect(reexported).toBe(limiterIp));
  it("acota la longitud", () => expect(ip({ "x-forwarded-for": "a".repeat(500) })).toHaveLength(64));
});
