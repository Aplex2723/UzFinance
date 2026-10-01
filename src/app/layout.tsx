import type { Metadata, Viewport } from "next";
// Tipografías autoalojadas (sin descargas de Google en el build ni en el navegador).
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "./globals.css";

export const metadata: Metadata = {
  title: "UzFinance",
  description: "Tracker personal de gastos",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#060606", colorScheme: "dark", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX">
      <body className="relative">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
