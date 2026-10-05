/**
 * Easy Auth entrega la cookie de sesión sin caducidad propia (de sesión del navegador): el
 * iPhone la borra al cerrar la app instalada. Aquí se vuelve a emitir el MISMO valor con
 * Max-Age para que sobreviva; la validez real sigue decidiéndola Easy Auth en el servidor
 * (cookieExpiration), así que esto no alarga ni salta ninguna sesión.
 *
 * El valor es base64 (lleva `/`, `+`, `=`): se copia CRUDO del encabezado Cookie y se escribe a mano en Set-Cookie.
 * Usar `response.cookies.set` lo re-codificaría (`%2F`, `%2B`, `%3D`) y Easy Auth ya no lo reconocería.
 */
export const EASY_AUTH_COOKIE = "AppServiceAuthSession";
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

const RAW = new RegExp(`(?:^|;\\s*)${EASY_AUTH_COOKIE}=([^;\\s]+)`);
/** Solo lo que puede ir en una cookie sin entrecomillar: nunca algo que permita inyectar atributos o encabezados. */
const SAFE_VALUE = /^[A-Za-z0-9+/=_.~%-]{1,4096}$/;

export function persistAuthCookie(cookieHeader: string | null, responseHeaders: Headers): boolean {
  const value = cookieHeader ? RAW.exec(cookieHeader)?.[1] : undefined;
  if (!value || !SAFE_VALUE.test(value)) return false;
  responseHeaders.append("set-cookie", `${EASY_AUTH_COOKIE}=${value}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  return true;
}
