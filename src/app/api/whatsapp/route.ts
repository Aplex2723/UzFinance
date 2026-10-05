import { webhook } from "@/lib/whatsapp/webhook";

// Webhook de Meta (WhatsApp Cloud API). Fuera de Easy Auth (excludedPaths): GET se protege con el verify token y POST con la
// firma HMAC-SHA256 (X-Hub-Signature-256) del cuerpo crudo. Toda la lógica vive en src/lib/whatsapp/webhook.ts (fábrica probable
// con dependencias falsas; un route.ts de Next solo puede exportar handlers y configuración).
export const dynamic = "force-dynamic";

export const GET = webhook.GET;
export const POST = webhook.POST;
