import { telegramWebhook } from "@/lib/telegram/webhook";

// Webhook de Telegram (Bot API). Fuera de Easy Auth (excludedPaths): Telegram no tiene sesión de Entra. Solo POST, autenticado con el
// encabezado X-Telegram-Bot-Api-Secret-Token (el secret_token del setWebhook) comparado en tiempo constante; GET responde 405.
// Toda la lógica vive en src/lib/telegram/webhook.ts (fábrica probable con dependencias falsas; un route.ts de Next solo puede
// exportar handlers y configuración).
export const dynamic = "force-dynamic";

export const GET = telegramWebhook.GET;
export const POST = telegramWebhook.POST;
