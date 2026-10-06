/**
 * OCR con Azure AI Vision (Image Analysis 4.0, característica `read`) para los comprobantes de solo imagen. Es el motor principal en
 * producción porque el plan B1 no tiene CPU ni memoria para tesseract (~100 s por comprobante y casi sin margen de RAM): Azure lee una
 * página en ~1 s, con más exactitud, y el nivel gratuito (F0: 5,000 lecturas al mes) sobra para unos 25 comprobantes al mes.
 *
 * Seguridad y privacidad:
 *  - Solo se manda la imagen de la página a un recurso de Azure del MISMO tenant (`*.cognitiveservices.azure.com`); el punto de acceso
 *    se valida para que el token de la identidad de la app nunca viaje a otro host.
 *  - Se autentica con la identidad administrada de la app (sin llaves en la configuración). `AZURE_VISION_KEY` existe solo para
 *    pruebas manuales desde una laptop.
 *  - Es un OCR, no un modelo de lenguaje: devuelve el texto tal cual está impreso, sin "interpretar" cifras.
 *  - Sin `AZURE_VISION_ENDPOINT` no se usa (laptop, pruebas): se lee con el OCR local de tesseract.
 */
export class VisionError extends Error {}

export type VisionConfig = { endpoint: string; key?: string };

const HOST_OK = /^[a-z0-9-]+\.cognitiveservices\.azure\.com$/i;

export function visionConfig(env: Record<string, string | undefined> = process.env): VisionConfig | null {
  const raw = env.AZURE_VISION_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !HOST_OK.test(u.hostname) || u.username || u.password) return null;
    return { endpoint: u.origin, key: env.AZURE_VISION_KEY?.trim() || undefined };
  } catch {
    return null;
  }
}

const API = "/computervision/imageanalysis:analyze?api-version=2024-02-01&features=read";
const CALL_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 2;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let cached: { token: string; expiresAt: number } | null = null;

/** Token de la identidad administrada de App Service (sin librerías: un GET al endpoint local que inyecta la plataforma). */
async function managedIdentityToken(fetchImpl: typeof fetch): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const header = process.env.IDENTITY_HEADER;
  if (!endpoint || !header) throw new VisionError("no hay identidad administrada para llamar a Azure Vision");
  const res = await fetchImpl(`${endpoint}?resource=${encodeURIComponent("https://cognitiveservices.azure.com")}&api-version=2019-08-01`, {
    headers: { "X-IDENTITY-HEADER": header },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new VisionError(`la identidad administrada respondió ${res.status}`);
  const j = (await res.json()) as { access_token?: unknown; expires_on?: unknown };
  const expiresOn = Number(j.expires_on);
  if (typeof j.access_token !== "string" || !j.access_token) throw new VisionError("la identidad administrada no devolvió un token");
  cached = { token: j.access_token, expiresAt: Number.isFinite(expiresOn) && expiresOn > 0 ? expiresOn * 1000 : Date.now() + 30 * 60_000 };
  return j.access_token;
}

/** Solo para pruebas: olvida el token guardado. */
export function resetVisionToken() {
  cached = null;
}

export type VisionRead = { text: string; confidence: number };

/** Texto de una imagen (PNG/JPEG) en el orden de lectura de Azure, una línea por renglón, y la confianza media de las palabras (0–100). */
export async function readImage(image: Uint8Array, cfg: VisionConfig, deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Promise<VisionRead> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  let last = "sin respuesta";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 4000));
    let res: Response;
    try {
      const auth: Record<string, string> = cfg.key ? { "Ocp-Apim-Subscription-Key": cfg.key } : { Authorization: `Bearer ${await managedIdentityToken(fetchImpl)}` };
      res = await fetchImpl(`${cfg.endpoint}${API}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: image as BodyInit,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      if (e instanceof VisionError) throw e;
      last = `red: ${((e as Error)?.message ?? "").slice(0, 80)}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      cached = null; // el token pudo caducar o cambiar el permiso: el siguiente intento pide otro
      if (attempt < MAX_RETRIES && res.status === 401) {
        last = "401";
        continue;
      }
      throw new VisionError(`Azure Vision rechazó la solicitud (${res.status}): revisa el permiso de la identidad de la app`);
    }
    if (res.status === 429 || res.status >= 500) {
      last = String(res.status);
      continue;
    }
    if (!res.ok) throw new VisionError(`Azure Vision respondió ${res.status}`);
    return parseRead(await res.json().catch(() => null));
  }
  throw new VisionError(`Azure Vision no respondió (${last})`);
}

type Line = { text?: unknown; words?: { confidence?: unknown }[] };

function parseRead(j: unknown): VisionRead {
  const blocks = (j as { readResult?: { blocks?: unknown } } | null)?.readResult?.blocks;
  const lines = (Array.isArray(blocks) ? blocks : []).flatMap((b: { lines?: unknown }) => (Array.isArray(b?.lines) ? (b.lines as Line[]) : []));
  const text = lines.map((l) => (typeof l?.text === "string" ? l.text.replace(/\s+/g, " ").trim() : "")).filter(Boolean).join("\n");
  const conf = lines.flatMap((l) => (Array.isArray(l?.words) ? l.words : [])).map((w) => Number(w?.confidence)).filter((n) => Number.isFinite(n));
  return { text, confidence: conf.length ? Math.round((conf.reduce((a, b) => a + b, 0) / conf.length) * 1000) / 10 : 0 };
}
