import { expect, request as pwRequest, test } from "@playwright/test";
import { E2E_PORT } from "./env";

const BASE = `http://localhost:${E2E_PORT}`;
const EMAIL_TOKEN = "e2e-email-token-0123456789-abcdefghijklmnopqrstuvwxyz";
const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Hoy en hora de Ciudad de México como "YYYY/M/D" (formato del correo). */
const todaySlash = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date()).replaceAll("-", "/");

const body = (rows: [string, string][]) => rows.map(([k, v]) => `${k}\n${v}`).join("\n");
const purchase = (auth: string, amount: string) => `Se realizó la siguiente operación: Retiro / Compra
EXPLORA BANAMEX**777
${body([["Monto", amount], ["Establecimiento", "TIENDA E2E CR CIUDAD"], ["Fecha y hora", `${todaySlash()} 01:15:00 AM`], ["Estatus", "Exitoso"], ["No. Autorización", auth]])}`;
const payment = (auth: string, amount: string) => `Se recibió un depósito
CLASICA BANAMEX**888
${body([["Monto", amount], ["Medio", "MOBILE"], ["Fecha y hora", `${todaySlash()} 01:20:00 AM`], ["No. Autorización", auth]])}`;

test("configuración: pagadores propios editables (AMEX por defecto)", async ({ page }) => {
  await page.goto("/configuracion");
  await expect(page.getByTestId("payee-row").filter({ hasText: "AMERICAN EXPRESS" })).toBeVisible();
  const name = `BANCO E2E ${uid().toUpperCase()}`.slice(0, 30);
  await page.getByLabel("Comercio").fill(name);
  await page.getByRole("button", { name: "Agregar" }).click();
  const row = page.getByTestId("payee-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: /Quitar/ }).click();
  await expect(row).toHaveCount(0);
});

test("correo → dashboard: pagos de tarjeta fuera del total, tarjeta sin nombrar y pendientes", async ({ page, playwright }) => {
  const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
  const send = async (id: string, subject: string, bodyText: string) =>
    (await api.post("/api/ingest/email", {
      headers: { authorization: `Bearer ${EMAIL_TOKEN}` },
      data: { messageId: `e2e-${id}`, from: "notificaciones@banamex.com", subject, receivedAt: new Date().toISOString(), bodyText },
    })).json();

  await page.goto("/");
  const readTotal = async () => (await page.getByTestId("month-total").innerText()).trim();
  const before = await readTotal();

  const id = uid();
  expect((await send(`p-${id}`, "Retiro/Compra con tarjeta Banamex", purchase(`A${id}`, "$10.00"))).status).toBe("created");
  expect((await send(`d-${id}`, "Depósito a Cuenta o Tarjeta Banamex", payment(`B${id}`, "$ 123,456.00"))).status).toBe("created");
  expect((await send(`u-${id}`, "Retiro/Compra con tarjeta Banamex", "correo roto sin campos")).status).toBe("unparsed");
  expect((await send(`p-${id}`, "Retiro/Compra con tarjeta Banamex", purchase(`A${id}`, "$10.00"))).status).toBe("duplicate");

  await page.goto("/");
  // El pago de $123,456 no debe mover el total del mes: solo suman los $10 de la compra.
  const after = await readTotal();
  const num = (s: string) => Number(s.replace(/[^\d.]/g, ""));
  expect(num(after) - num(before)).toBeCloseTo(10, 2);

  const review = page.getByTestId("review-panel");
  await expect(review).toBeVisible();
  await expect(review.getByTestId("unnamed-card").first()).toBeVisible();
  await expect(review.getByTestId("unparsed-row").first()).toContainText("Retiro/Compra");
  await expect(page.getByTestId("payments-total")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Pagos de tarjeta/ })).toBeVisible();

  // Sección aparte y listado de gastos sin el pago.
  await page.goto("/transacciones?kind=card_payment");
  await expect(page.getByText("Pago a tarjeta Banamex").first()).toBeVisible();
  await page.goto("/transacciones");
  await expect(page.getByText("Pago a tarjeta Banamex")).toHaveCount(0);

  // Descartar el pendiente.
  await page.goto("/");
  const rows = review.getByTestId("unparsed-row");
  const n = await rows.count();
  await rows.first().getByRole("button", { name: /Descartar/ }).click();
  await expect(rows).toHaveCount(n - 1);

  await page.goto("/tarjetas");
  await expect(page.getByTestId("card-unnamed").first()).toContainText("Sin nombrar");
  await api.dispose();
  void playwright;
});
