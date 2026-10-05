import { signBody } from "@/lib/whatsapp/signature";

/** Datos 100 % inventados. */
export const WA = {
  verifyToken: "verify-token-inventado-0123456789",
  appSecret: "app-secret-inventado-0123456789abcdef",
  accessToken: "EAAT-token-de-acceso-inventado-0123456789",
  phoneNumberId: "100200300400500",
  allowed: "5215511110001=Uziel,5215522220002=Ana",
  uziel: "5215511110001", // Meta lo manda con el 1 de móviles de México
  ana: "5215522220002",
  intruso: "5215599990009",
};

export const WA_ENV = {
  WHATSAPP_VERIFY_TOKEN: WA.verifyToken,
  WHATSAPP_APP_SECRET: WA.appSecret,
  WHATSAPP_ACCESS_TOKEN: WA.accessToken,
  WHATSAPP_PHONE_NUMBER_ID: WA.phoneNumberId,
  WHATSAPP_ALLOWED: WA.allowed,
};

type Msg = Record<string, unknown>;

/** Payload de Meta con los mensajes dados. */
export function webhookBody(messages: Msg[], over: { phoneNumberId?: string; statuses?: Msg[]; object?: string } = {}) {
  return {
    object: over.object ?? "whatsapp_business_account",
    entry: [
      {
        id: "999000111222333",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: over.phoneNumberId ?? WA.phoneNumberId },
              contacts: [{ profile: { name: "Nombre Inventado" }, wa_id: WA.uziel }],
              ...(messages.length ? { messages } : {}),
              ...(over.statuses ? { statuses: over.statuses } : {}),
            },
          },
        ],
      },
    ],
  };
}

export const textMsg = (id: string, body: string, from = WA.uziel, ts: number | string = "1790000000"): Msg => ({ from, id, timestamp: String(ts), type: "text", text: { body } });
export const signed = (raw: string, secret = WA.appSecret) => ({ "x-hub-signature-256": signBody(secret, raw) });
