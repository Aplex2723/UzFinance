"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { apiFetch } from "@/lib/client";

declare global {
  interface Window {
    /** Solo para pruebas e2e: acorta el intervalo. */
    __UZ_POLL_MS?: number;
  }
}

const DEFAULT_POLL_MS = 20_000;
const ACTIVE_WINDOW_MS = 5 * 60_000; // sin actividad del usuario → se deja de consultar
const MIN_GAP_MS = 5_000;

/**
 * Mantiene la pantalla al día cuando los datos cambian fuera de esta pestaña
 * (Atajo del iPhone, otro dispositivo).
 *
 * Cuida el cupo gratuito de Azure SQL: consulta solo con la pestaña visible y
 * actividad reciente; sin actividad deja que la base se pause.
 */
export function LiveRefresh() {
  const router = useRouter();
  const rev = useRef<string | null>(null);
  const lastCheck = useRef(0);
  const lastActive = useRef(0);

  useEffect(() => {
    lastActive.current = Date.now();
    let stopped = false;

    async function check(force = false) {
      const now = Date.now();
      if (stopped || document.visibilityState !== "visible") return;
      if (!force && now - lastCheck.current < MIN_GAP_MS) return;
      lastCheck.current = now;
      const r = await apiFetch<{ rev: string }>("/api/changes", "GET");
      if (!r.ok || stopped) return;
      const changed = rev.current !== null && rev.current !== r.data.rev;
      rev.current = r.data.rev;
      // No pisar la pantalla mientras se escribe en un diálogo.
      if (changed && !document.querySelector("dialog[open]")) router.refresh();
    }

    const touch = () => { lastActive.current = Date.now(); };
    const onVisible = () => { touch(); void check(true); };
    const interval = window.__UZ_POLL_MS ?? DEFAULT_POLL_MS;
    const timer = setInterval(() => {
      if (Date.now() - lastActive.current <= ACTIVE_WINDOW_MS) void check();
    }, interval);

    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible); // Safari/iOS: volver desde el caché de páginas
    void check(true); // fija la revisión inicial

    return () => {
      stopped = true;
      clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, touch));
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
    };
  }, [router]);

  return null;
}
