import { HttpError, json, protectedRoute } from "@/lib/api";
import { IntakeError, processDocument } from "@/lib/docs/intake";
import { PDF_MAX_BYTES } from "@/lib/pdf/text";
import { listDocuments } from "@/lib/repo/documents";
import { readLimitedBytes } from "@/lib/security/body";
import { RateLimiter } from "@/lib/security/ratelimit";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // el OCR de un comprobante tarda unos segundos; estados grandes, más

/** Cupo de subidas (el OCR y los extractores son lo más caro de la app). */
const uploads = new RateLimiter(20, 10 * 60_000);
const MULTIPART_OVERHEAD = 256 * 1024;

// La huella del archivo es interna (idempotencia): no sale por la API.
export const GET = protectedRoute(async () => json({ documents: (await listDocuments(100)).map((d) => ({ ...d, sha256: undefined })) }));

/** Sube UN PDF (multipart: campo `file`, y `password` opcional). La misma lógica atenderá a WhatsApp con origin "whatsapp". */
export const POST = protectedRoute(async ({ req, user }) => {
  if (!uploads.hit(user.email)) throw new HttpError(429, "Demasiadas subidas, espera unos minutos");
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("multipart/form-data")) throw new HttpError(415, "Content-Type debe ser multipart/form-data");
  const raw = await readLimitedBytes(req, PDF_MAX_BYTES + MULTIPART_OVERHEAD);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), { headers: { "content-type": ct } }).formData();
  } catch {
    throw new HttpError(400, "Formulario malformado");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Falta el archivo (campo `file`)");
  const password = form.get("password");
  try {
    const r = await processDocument({
      bytes: new Uint8Array(await file.arrayBuffer()),
      origin: "app",
      filename: file.name.slice(0, 200),
      password: typeof password === "string" && password.length > 0 && password.length <= 100 ? password : undefined,
    });
    return json(r);
  } catch (e) {
    if (e instanceof IntakeError) throw new HttpError(e.status, e.message);
    throw e;
  }
});
