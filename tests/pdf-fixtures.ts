import path from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

// Fuente empaquetada en node_modules: así el dibujo (y el OCR de las pruebas) es idéntico en cualquier máquina,
// con o sin fuentes del sistema (CI en Linux, Mac…). Con la fuente por omisión el OCR leía distinto según el sistema.
const FONT = "UzTestSans";
try {
  GlobalFonts.registerFromPath(path.join(process.cwd(), "node_modules", "@fontsource-variable", "inter", "files", "inter-latin-wght-normal.woff2"), FONT);
} catch {
  /* sin la fuente se usa la del sistema */
}

/**
 * PDFs sintéticos para pruebas (todo inventado; el repo puede ser público):
 *  - textPdf: capa de texto real (Helvetica), como un estado de cuenta.
 *  - imagePdf: SOLO imagen (no hay texto que extraer), como el comprobante de la app de Banamex → obliga a pasar por OCR.
 */
const esc = (s: string) => s.replace(/[\\()]/g, "\\$&").replace(/[^\x20-\x7e]/g, "?");

function assemble(objects: (string | Buffer)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from("\nendobj\n")]);
    parts.push(b);
    pos += b.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return new Uint8Array(Buffer.concat(parts));
}

/** Una página por arreglo de renglones. Texto ASCII (los acentos se pierden: no importa para las pruebas). */
export function textPdf(pages: string[][], mediaBox: [number, number] = [612, 792]): Uint8Array {
  const n = pages.length;
  const objs: (string | Buffer)[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${n} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((lines, i) => {
    const content = `BT /F1 10 Tf 40 780 Td 13 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBox[0]} ${mediaBox[1]}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  return assemble(objs);
}

/** Una página por arreglo de renglones, dibujados como bitmap JPEG (sin texto en el PDF). */
export function imagePdf(pages: string[][]): Uint8Array {
  const W = 850;
  const H = 1100;
  const objs: (string | Buffer)[] = [];
  const kids: string[] = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(""); // Pages: se completa abajo
  pages.forEach((lines) => {
    const canvas = createCanvas(W, H);
    const g = canvas.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, W, H);
    g.fillStyle = "#0b2a30";
    let y = 90;
    for (const l of lines) {
      const big = /^\$/.test(l);
      g.font = big ? `64px ${FONT}, sans-serif` : `28px ${FONT}, sans-serif`;
      g.fillText(l, 60, y);
      y += big ? 90 : 56;
    }
    const jpeg = canvas.toBuffer("image/jpeg", 95);
    const base = objs.length + 1;
    kids.push(`${base} 0 R`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${base + 1} 0 R >> >> /Contents ${base + 2} 0 R >>`);
    objs.push(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]));
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  return assemble(objs);
}

const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
/** "DD mmm AAAA" de hace `daysAgo` días (hora de CDMX): las pruebas no caducan ni quedan "en el futuro". */
export function recentDate(daysAgo = 10): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000 - 6 * 3_600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Comprobante de la app de Banamex (inventado) como PDF de imagen de 2 páginas. */
export function receiptPdf(o: { amount?: string; origin?: string; dest?: string; bank?: string; auth?: string; key?: string; concept?: string; ref?: string; when?: string; status?: string } = {}): Uint8Array {
  return imagePdf([
    ["Comprobante de transferencia", `Banamex ${recentDate()} 09:05:12 h`, o.status ?? "Transferencia exitosa", "Esta transferencia ha sido aceptada.", o.amount ?? "$1,234.56 MXN", "Cuenta origen", o.origin ?? "MiCuenta Banamex **456", "Cuenta destino", o.dest ?? "Casero Ejemplo **789", o.bank ?? "Bbva Mexico - Juan Perez Lopez *", "Datos de la transferencia", `Numero de autorizacion ${o.auth ?? "123456"}`, `Clave de rastreo ${o.key ?? "012345678901234567"}`],
    ["Comprobante de transferencia", `Banamex ${recentDate()} 09:05:12 h`, "Tipo de cuenta Debito", "Tipo de beneficiario Persona fisica", `Concepto ${o.concept ?? "Renta depa"}`, `Referencia numerica ${o.ref ?? "4321"}`, `Fecha y hora ${o.when ?? `${recentDate()} 09:05 h`}`],
  ]);
}
