import type { MetadataRoute } from "next";

/** Hace la app instalable (“Añadir a pantalla de inicio”). Sin service worker: nada de tus datos se guarda en caché del dispositivo. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "UzFinance",
    short_name: "UzFinance",
    description: "Tracker personal de gastos",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "es-MX",
    background_color: "#060606",
    theme_color: "#060606",
    categories: ["finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Transacciones", url: "/transacciones", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Analítica", url: "/analitica", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
