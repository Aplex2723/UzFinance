import path from "node:path";
import { createWorker, PSM, type Worker } from "tesseract.js";
import { renderPageAsImage } from "unpdf";
import { readImage, visionConfig, VisionError, type VisionConfig } from "./ocr-azure";
import { openPdf, PDF_MAX_PAGES } from "./text";

/**
 * OCR para PDFs de solo imagen (p. ej. el comprobante de transferencia de la app de Banamex: el texto va como bitmaps). Nunca un modelo
 * de lenguaje: devuelven el texto impreso, sin interpretar cifras.
 *  - Con `AZURE_VISION_ENDPOINT` (producción): Azure AI Vision (ver ocr-azure.ts), ~1 s por página y gratis a este volumen.
 *  - Sin él, o si Azure falla: OCR LOCAL con tesseract (WASM) y el idioma español empaquetado en node_modules. Nada sale del servidor,
 *    pero en el plan B1 tarda ~100 s por comprobante: es el respaldo, no el camino normal.
 *
 * Cada página se lee DOS veces con distinta resolución: quien consume compara los campos críticos (monto, rastreo, fecha…)
 * y, si no coinciden, pide revisión humana en vez de registrar un dato dudoso.
 */
export const OCR_MAX_PAGES = 3;
export const OCR_SCALES = [2.5, 3.5] as const;
/** Resoluciones para Azure (imágenes más chicas: la lectura ya es muy exacta y el tamaño por llamada es menor). */
export const VISION_SCALES = [2, 3] as const;
/** Tope de píxeles por página renderizada (una página gigante a 3.5× serían GB de memoria nativa). Una carta a 3.5× ≈ 6 MP. */
export const OCR_MAX_PIXELS = 25_000_000;
// Tiempos medidos en el plan B1 (un núcleo compartido): el motor tarda ~45 s en arrancar en frío y cada lectura de página 10–20 s (en una laptop,
// menos de 1 s). Un comprobante de 2 páginas leído a 2 resoluciones son 4 lecturas: ~100 s en frío, ~55 s con el motor ya caliente.
const OCR_TIMEOUT_MS = 240_000;
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 5_000;
/** El motor local se apaga tras este rato sin uso (memoria) y el siguiente documento paga el arranque. */
const IDLE_MS = 15 * 60_000;

export class OcrError extends Error {}

const langPath = () => process.env.OCR_LANG_PATH ?? path.join(process.cwd(), "node_modules", "@tesseract.js-data", "spa", "4.0.0_best_int");

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();

/** Espera `p` como máximo `ms`; si no responde, `onTimeout` decide (lanzar o seguir). Un worker roto puede no resolver NI rechazar jamás. */
function within<T>(p: Promise<T>, ms: number, onTimeout: () => T | Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => Promise.resolve().then(onTimeout).then(resolve, reject), ms);
    timer.unref?.();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

async function getWorker(): Promise<Worker> {
  workerPromise ??= within(
    createWorker("spa", 1, { langPath: langPath(), gzip: true, cacheMethod: "none" })
      // El modo por omisión de tesseract.js (un solo bloque) se salta líneas sueltas en letra grande, como el "$750.00 MXN" de los comprobantes
      // de Banamex. La segmentación automática de página las lee en las dos resoluciones.
      .then(async (w) => {
        await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        return w;
      }),
    START_TIMEOUT_MS,
    () => {
      throw new Error("el motor no arrancó a tiempo");
    },
  ).catch((e) => {
    workerPromise = null;
    throw new OcrError(`No se pudo iniciar el OCR: ${(e as Error).message}`);
  });
  return workerPromise;
}

async function stopWorker() {
  const p = workerPromise;
  workerPromise = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!p) return;
  // Un worker que nunca terminó de arrancar deja su promesa colgada: esperarla sin límite bloquearía la cola de OCR para siempre.
  await within(
    p.then((w) => w.terminate()).then(() => undefined, () => undefined),
    STOP_TIMEOUT_MS,
    () => undefined,
  );
}

const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stopWorker(), IDLE_MS);
  idleTimer.unref?.();
};

export type OcrPass = { scale: number; pages: { page: number; text: string; confidence: number }[] };
export type OcrResult = { passes: OcrPass[]; numPages: number };

type Control = { aborted: boolean };
/** Un motor lee la imagen de una página (PNG) y devuelve su texto y confianza (0–100). */
type Engine = (png: Buffer) => Promise<{ text: string; confidence: number }>;

const localEngine = async (): Promise<Engine> => {
  const worker = await getWorker();
  return async (png) => {
    const { data } = await worker.recognize(png);
    return { text: data.text, confidence: data.confidence };
  };
};

async function run(bytes: Uint8Array, scales: readonly number[], password: string | undefined, ctl: Control, engine: () => Promise<Engine>): Promise<OcrResult> {
  const pdf = await openPdf(bytes, password);
  try {
    const numPages = Math.min(pdf.numPages, OCR_MAX_PAGES, PDF_MAX_PAGES);
    const read = await engine();
    const passes: OcrPass[] = [];
    for (const scale of scales) {
      const pages: OcrPass["pages"] = [];
      for (let p = 1; p <= numPages; p++) {
        // Si el tiempo se agotó, esta corrida huérfana se detiene en la siguiente página en vez de seguir gastando memoria.
        if (ctl.aborted) throw new OcrError("Lectura cancelada");
        const vp = (await pdf.getPage(p)).getViewport({ scale: 1 });
        if (vp.width * vp.height * scale * scale > OCR_MAX_PIXELS) throw new OcrError("Una página del PDF es demasiado grande para leerla");
        const png = await renderPageAsImage(pdf, p, { canvasImport: () => import("@napi-rs/canvas"), scale });
        const { text, confidence } = await read(Buffer.from(png));
        pages.push({ page: p, text, confidence });
      }
      passes.push({ scale, pages });
    }
    return { passes, numPages };
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.();
  }
}

const visionEngine = (cfg: VisionConfig) => async (): Promise<Engine> => (png) => readImage(png, cfg);

/** Azure primero (si está configurado) y, si falla, el OCR local. Los errores del PDF mismo (contraseña, dañado) no se reintentan. */
async function runBest(bytes: Uint8Array, scales: readonly number[], password: string | undefined, ctl: Control): Promise<OcrResult> {
  const cfg = visionConfig();
  if (cfg) {
    try {
      const t0 = Date.now();
      const r = await run(bytes, VISION_SCALES, password, ctl, visionEngine(cfg));
      console.log(`[ocr] Azure Vision: ${r.numPages} pág. × ${VISION_SCALES.length} lecturas en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return r;
    } catch (e) {
      if (!(e instanceof VisionError)) throw e;
      console.warn(`[ocr] Azure Vision falló (${e.message.slice(0, 120)}): se usa el OCR local`);
    }
  }
  const t0 = Date.now();
  const r = await run(bytes, scales, password, ctl, localEngine);
  console.log(`[ocr] local: ${r.numPages} pág. × ${scales.length} lecturas en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r;
}

/** Lee el PDF con OCR. Un solo documento a la vez (la memoria del plan B1 es limitada) y con tope de tiempo. */
export function ocrPdf(bytes: Uint8Array, scales: readonly number[] = OCR_SCALES, password?: string): Promise<OcrResult> {
  const job = chain.then(async () => {
    // El temporizador de inactividad no debe matar al worker mientras hay trabajo (subidas encadenadas).
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const ctl: Control = { aborted: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runBest(bytes, scales, password, ctl),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => {
            ctl.aborted = true;
            rej(new OcrError("El OCR tardó demasiado"));
          }, OCR_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      // Cualquier fallo (WASM roto, memoria, PDF raro) reinicia el worker: uno envenenado no debe arruinar los siguientes documentos.
      ctl.aborted = true;
      await stopWorker();
      throw e instanceof OcrError ? e : new OcrError(`No se pudo leer el PDF con OCR: ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
      armIdle();
    }
  });
  chain = job.catch(() => undefined);
  return job;
}

export const ocrText = (r: OcrPass) => r.pages.map((p) => p.text).join("\n");
export const ocrConfidence = (r: OcrPass) => (r.pages.length ? Math.min(...r.pages.map((p) => p.confidence)) : 0);
