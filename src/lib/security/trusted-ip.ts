/**
 * IP para los limitadores de los webhooks (WhatsApp y Telegram): la ÚLTIMA entrada de X-Forwarded-For. La primera la controla el
 * cliente (un atacante podría poner la IP de Meta o de Telegram y hacer que se bloquee); la última es la que agrega el proxy de Azure.
 * Quita ":puerto" (IPv4 y "[IPv6]:puerto"). Sin cabecera usa X-Client-IP y, al final, "unknown".
 */
export function limiterIp(headers: Headers): string {
  const xff = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const raw = xff.length ? xff[xff.length - 1] : (headers.get("x-client-ip") ?? "").trim() || "unknown";
  return raw
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1")
    .replace(/^\[([0-9A-Fa-f:.]+)\](?::\d+)?$/, "$1")
    .slice(0, 64);
}
