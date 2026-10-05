// Verifica que el paquete standalone trae lo que el OCR carga por rutas dinámicas (el rastreo de Next no las ve) y que el worker de
// tesseract realmente arranca desde ahí. Uso: node scripts/check-standalone.mjs [.next/standalone]
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// El despliegue es un zip del paquete: los enlaces simbólicos se vuelven directorios reales, y desde ahí un módulo solo encuentra sus
// dependencias si el zip las trae. Se copia sin enlaces a un directorio aparte para que la prueba no "vea" el node_modules del repo.
const source = path.resolve(process.argv[2] ?? ".next/standalone");
const root = mkdtempSync(path.join(tmpdir(), "uzf-standalone-"));
cpSync(source, root, { recursive: true, dereference: true });
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const nm = path.join(root, ".next", "node_modules");
const alias = existsSync(nm) ? readdirSync(nm).find((d) => d.startsWith("tesseract.js-")) : undefined;
if (!alias) {
  console.error("check-standalone: no se encontró tesseract.js en .next/node_modules (¿cambió serverExternalPackages?)");
  process.exit(1);
}
const dir = path.join(nm, alias);
const req = createRequire(path.join(dir, "package.json"));
const deps = Object.keys(req("./package.json").dependencies ?? {}).filter((d) => d !== "opencollective-postinstall" && d !== "idb-keyval");
const missing = [];
for (const d of [...deps, "@tesseract.js-data/spa/package.json"]) {
  try {
    req.resolve(d.includes("/package.json") ? d : d);
  } catch {
    try {
      req.resolve(`${d}/package.json`);
    } catch {
      missing.push(d);
    }
  }
}
// El worker del OCR en Node carga estos módulos al arrancar (utils/setImage.js, etc.).
for (const d of ["bmp-js", "zlibjs/bin/gunzip.min.js", "is-url", "regenerator-runtime"]) {
  try {
    req.resolve(d);
  } catch {
    missing.push(d);
  }
}
if (missing.length) {
  console.error(`check-standalone: faltan en el paquete: ${[...new Set(missing)].join(", ")}`);
  process.exit(1);
}

// Prueba real: arranca el worker español y lee un texto dibujado.
const { createWorker } = req(dir);
const canvasReq = createRequire(path.join(root, "package.json"));
const { createCanvas } = canvasReq("@napi-rs/canvas");
const c = createCanvas(600, 120);
const g = c.getContext("2d");
g.fillStyle = "#fff";
g.fillRect(0, 0, 600, 120);
g.fillStyle = "#000";
g.font = "48px sans-serif";
g.fillText("Monto 750.00", 20, 75);
const langPath = path.join(root, "node_modules", "@tesseract.js-data", "spa", "4.0.0_best_int");
const worker = await createWorker("spa", 1, { langPath, gzip: true, cacheMethod: "none" });
const { data } = await worker.recognize(c.toBuffer("image/png"));
await worker.terminate();
if (!/750[.,]00/.test(data.text)) {
  console.error(`check-standalone: el OCR arrancó pero no leyó el texto de prueba: ${JSON.stringify(data.text)}`);
  process.exit(1);
}
console.log("check-standalone: OK (el OCR arranca y lee desde el paquete)");
