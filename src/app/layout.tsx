import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const grotesk = Space_Grotesk({ variable: "--font-grotesk", subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "UzFinance",
  description: "Tracker personal de gastos",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#060606", colorScheme: "dark", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX" className={`${inter.variable} ${grotesk.variable}`}>
      <body className="relative">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
