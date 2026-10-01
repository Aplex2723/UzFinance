import { headers } from "next/headers";
import { authenticate } from "./session";

/** Cada página/layout revalida la sesión (el proxy no es la única barrera). */
export async function requirePageUser() {
  const auth = authenticate(await headers());
  if (!auth.ok) throw new Error(auth.status === 401 ? "No autenticado" : "No autorizado");
  return auth.user;
}
