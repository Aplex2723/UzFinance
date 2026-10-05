import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "@/lib/whatsapp/signature";
import { WA } from "../wa-webhook-fixtures";

const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
const good = signBody(WA.appSecret, body);

describe("firma X-Hub-Signature-256 de Meta", () => {
  it("signBody = sha256= + HMAC-SHA256 hex del cuerpo crudo", () => {
    expect(good).toBe(`sha256=${createHmac("sha256", WA.appSecret).update(body).digest("hex")}`);
    expect(good).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("firma válida → true", () => {
    expect(verifySignature(WA.appSecret, body, good)).toBe(true);
  });
  it("acepta hex en mayúsculas y espacios alrededor", () => {
    expect(verifySignature(WA.appSecret, body, `sha256=${good.slice(7).toUpperCase()}`)).toBe(true);
    expect(verifySignature(WA.appSecret, body, ` ${good} `)).toBe(true);
  });
  it("firma de otro secreto → false", () => {
    expect(verifySignature(WA.appSecret, body, signBody("otro-secreto-inventado-0123456789", body))).toBe(false);
  });
  it("cabecera ausente o vacía → false", () => {
    expect(verifySignature(WA.appSecret, body, null)).toBe(false);
    expect(verifySignature(WA.appSecret, body, "")).toBe(false);
  });
  it.each([
    ["prefijo sha1", `sha1=${good.slice(7)}`],
    ["sin prefijo", good.slice(7)],
    ["prefijo mayúsculas", `SHA256=${good.slice(7)}`],
    ["prefijo con espacio", `sha256= ${good.slice(7)}`],
    ["longitud menor", good.slice(0, -2)],
    ["longitud mayor", `${good}00`],
    ["no hexadecimal", `sha256=${"z".repeat(64)}`],
    ["solo el prefijo", "sha256="],
  ])("cabecera mal formada (%s) → false", (_n, h) => {
    expect(verifySignature(WA.appSecret, body, h)).toBe(false);
  });
  it("un bit alterado en el cuerpo invalida la firma", () => {
    const tampered = Buffer.from(body);
    tampered[10] ^= 1;
    expect(verifySignature(WA.appSecret, tampered, good)).toBe(false);
    expect(verifySignature(WA.appSecret, Buffer.concat([body, Buffer.from(" ")]), good)).toBe(false);
    expect(verifySignature(WA.appSecret, Buffer.alloc(0), good)).toBe(false);
  });
  it("firma sobre el cuerpo CRUDO: reordenar el JSON cambia los bytes y la invalida", () => {
    const a = Buffer.from('{"a":1,"b":2}');
    const b = Buffer.from('{"b":2,"a":1}');
    expect(verifySignature(WA.appSecret, b, signBody(WA.appSecret, a))).toBe(false);
  });
  it("cuerpo con UTF-8 multibyte se firma por bytes", () => {
    const utf = Buffer.from('{"text":"café ☕ 😀"}', "utf8");
    expect(verifySignature(WA.appSecret, utf, signBody(WA.appSecret, utf))).toBe(true);
  });
  it("longitudes distintas no lanzan (la comparación se hace entre digests de igual tamaño)", () => {
    expect(() => verifySignature(WA.appSecret, body, "sha256=abcd")).not.toThrow();
    expect(() => verifySignature(WA.appSecret, body, `sha256=${"a".repeat(128)}`)).not.toThrow();
    expect(verifySignature(WA.appSecret, body, `sha256=${"a".repeat(128)}`)).toBe(false);
  });
});
