import path from "node:path";
import { createWorker, type Worker } from "tesseract.js";
import { renderPageAsImage } from "unpdf";
import { openPdf, PDF_MAX_PAGES } from "./text";

/**
 * OCR LOCAL para PDFs de solo imagen (p. ej. el comprobante de transferencia de la app de Banamex: el texto va como bitmaps).
 * Nada sale del servidor: tesseract (WASM) + el idioma español empaquetado en node_modules. Se eligió esto sobre un modelo
 * de visión externo para que ningún documento financiero salga a un tercero y para que el resultado sea reproducible.
 *
 * Cada página se lee DOS veces con distinta resolución: quien consume compara los campos críticos (monto, rastreo, fecha…)
 * y, si no coinciden, pide revisión humana en vez de registrar un dato dudoso.
 */
export const OCR_MAX_PAGES = 3;
export const OCR_SCALES = [2.5, 3.5] as const;
/** Tope de píxeles por página renderizada (una página gigante a 3.5× serían GB de memoria nativa). Una carta a 3.5× ≈ 6 MP. */
export const OCR_MAX_PIXELS = 25_000_000;
const OCR_TIMEOUT_MS = 90_000;
const IDLE_MS = 60_000;

export class OcrError extends Error {}

const langPath = () => process.env.OCR_LANG_PATH ?? path.join(process.cwd(), "node_modules", "@tesseract.js-data", "spa", "4.0.0_best_int");

let workerPromise: Promise<Worker> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();

async function getWorker(): Promise<Worker> {
  workerPromise ??= createWorker("spa", 1, { langPath: langPath(), gzip: true, cacheMethod: "none" }).catch((e) => {
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
  try {
    await (await p)?.terminate();
  } catch {
    /* ya estaba caído */
  }
}

const armIdle = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void stopWorker(), IDLE_MS);
  idleTimer.unref?.();
};

export type OcrPass = { scale: number; pages: { page: number; text: string; confidence: number }[] };
export type OcrResult = { passes: OcrPass[]; numPages: number };

type Control = { aborted: boolean };

async function run(bytes: Uint8Array, scales: readonly number[], password: string | undefined, ctl: Control): Promise<OcrResult> {
  const pdf = await openPdf(bytes, password);
  try {
    const numPages = Math.min(pdf.numPages, OCR_MAX_PAGES, PDF_MAX_PAGES);
    const worker = await getWorker();
    const passes: OcrPass[] = [];
    for (const scale of scales) {
      const pages: OcrPass["pages"] = [];
      for (let p = 1; p <= numPages; p++) {
        // Si el tiempo se agotó, esta corrida huérfana se detiene en la siguiente página en vez de seguir gastando memoria.
        if (ctl.aborted) throw new OcrError("Lectura cancelada");
        const vp = (await pdf.getPage(p)).getViewport({ scale: 1 });
        if (vp.width * vp.height * scale * scale > OCR_MAX_PIXELS) throw new OcrError("Una página del PDF es demasiado grande para leerla");
        const png = await renderPageAsImage(pdf, p, { canvasImport: () => import("@napi-rs/canvas"), scale });
        const { data } = await worker.recognize(Buffer.from(png));
        pages.push({ page: p, text: data.text, confidence: data.confidence });
      }
      passes.push({ scale, pages });
    }
    return { passes, numPages };
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.();
  }
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
        run(bytes, scales, password, ctl),
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
