"use client";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number; /** Cuerpo JSON de la respuesta de error (p. ej. el movimiento parecido de un 409). */ body?: Record<string, unknown> };

export async function apiFetch<T = unknown>(path: string, method: string, body?: unknown, contentType = "application/json"): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { "Content-Type": contentType } : undefined,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: (data as { error?: string }).error ?? `Error ${res.status}`, body: data as Record<string, unknown> };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, status: 0, error: "Sin conexión con el servidor" };
  }
}

/** Eventos globales para abrir diálogos desde cualquier botón o desde ⌘K. */
export const EVENTS = {
  addExpense: "uz:add-expense",
  importCsv: "uz:import-csv",
  editTransaction: "uz:edit-transaction",
  openChat: "uz:open-chat",
} as const;

export const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
