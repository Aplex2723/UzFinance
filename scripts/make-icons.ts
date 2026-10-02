import sharp from "sharp";
import { writeFileSync } from "node:fs";

/**
 * Genera los íconos de la app instalable (PNG) a partir del mismo logo del dashboard.
 *   npx tsx scripts/make-icons.ts
 * Los PNG se versionan en public/icons: no se corre en el build.
 */
const logo = (scale: number) => `
  <g transform="translate(256 256) scale(${scale}) translate(-16 -16)" stroke="#ff4d1c" stroke-width="2.6" stroke-linecap="round" fill="none">
    <path d="M16 5v6M16 21v6M5 16h6M21 16h6M8.2 8.2l4.2 4.2M19.6 19.6l4.2 4.2M23.8 8.2l-4.2 4.2M12.4 19.6l-4.2 4.2"/>
  </g>`;
const svg = (scale: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="60%"><stop offset="0" stop-color="#2a1208"/><stop offset="1" stop-color="#0b0b0b"/></radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#glow)"/>${logo(scale)}
</svg>`;

async function png(name: string, size: number, scale: number) {
  writeFileSync(`public/icons/${name}`, await sharp(Buffer.from(svg(scale))).resize(size, size).png().toBuffer());
  console.log(`public/icons/${name}`);
}

async function main() {
  await png("icon-192.png", 192, 11);
  await png("icon-512.png", 512, 11);
  await png("icon-maskable-512.png", 512, 8.2); // margen de seguridad (80%) para máscaras circulares de Android
  await png("apple-touch-icon.png", 180, 11); // iOS no admite transparencia: fondo completo
}
main();
