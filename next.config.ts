import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // OCR y lectura de PDF: paquetes con WASM / binarios nativos / workers que no deben empaquetarse (se cargan desde node_modules).
  serverExternalPackages: ["mssql", "tedious", "tesseract.js", "tesseract.js-core", "@napi-rs/canvas", "unpdf"],
  // El rastreo de archivos no ve lo que se carga por ruta dinámica: se incluyen el idioma del OCR, el worker y el WASM.
  outputFileTracingIncludes: {
    "/api/documents": [
      "./node_modules/@tesseract.js-data/spa/**/*",
      "./node_modules/tesseract.js/**/*",
      "./node_modules/tesseract.js-core/**/*",
      "./node_modules/@napi-rs/canvas*/**/*",
      "./node_modules/unpdf/**/*",
    ],
  },
  // Con proxy.ts, Next copia el cuerpo de cada petición en memoria (10 MB por omisión): los PDF caben (máx. 12 MB + formulario).
  experimental: { proxyClientMaxBodySize: "14mb" },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
