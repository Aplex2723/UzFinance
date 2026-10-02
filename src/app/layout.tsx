import type { Metadata, Viewport } from "next";
// Tipografías autoalojadas (sin descargas de Google en el build ni en el navegador).
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

export const metadata: Metadata = {
  title: "UzFinance",
  description: "Tracker personal de gastos",
  robots: { index: false, follow: false },
  applicationName: "UzFinance",
  appleWebApp: { capable: true, title: "UzFinance", statusBarStyle: "black" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }, { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }], apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = { themeColor: "#060606", colorScheme: "dark", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX">
      <body className="relative">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
