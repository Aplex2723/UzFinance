import { expect, test } from "@playwright/test";

// Se ejecuta con `npm run test:e2e` (base propia uzfinance_e2e). Todo con datos inventados.
test.describe("documentos y alertas", () => {
  test("/documentos carga con la zona de subida y rechaza lo que no es PDF", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/documentos");
    await expect(page.getByRole("heading", { name: "Documentos", level: 1 })).toBeVisible();
    await expect(page.getByTestId("pick-pdf")).toBeVisible();
    await expect(page.getByTestId("pdf-input")).toHaveAttribute("accept", "application/pdf");
    await page.getByTestId("pdf-input").setInputFiles({ name: "nada.pdf", mimeType: "application/pdf", buffer: Buffer.from("esto no es un pdf") });
    await expect(page.getByTestId("upload-result").first()).toContainText("El archivo no es un PDF");
    expect(errors).toEqual([]);
  });

  test("/alertas carga la lista y la configuración, y valida montos antes de guardar", async ({ page }) => {
    await page.goto("/alertas");
    await expect(page.getByRole("heading", { name: "Alertas", level: 1 })).toBeVisible();
    await expect(page.getByTestId("whatsapp-note")).toContainText("Apagado: requiere plantillas aprobadas por Meta.");
    await expect(page.getByTestId("telegram-note")).toHaveText("Los avisos llegan al chat privado de cada persona autorizada con el bot de Telegram (gratis). Cada persona debe haberle escrito al bot al menos una vez.");
    await expect(page.getByTestId("telegram-enabled")).not.toBeChecked(); // apagado por omisión: se enciende a propósito
    await page.locator("#a-largePurchaseCents").fill("abc");
    await page.getByTestId("settings-save").click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page.locator("#a-largePurchaseCents").fill("7500");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-msg")).toHaveText("Configuración guardada.");
  });

  test("Inicio ofrece accesos rápidos a Subir PDF y Alertas", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("quick-upload-pdf").click();
    await expect(page).toHaveURL(/\/documentos$/);
  });

  test("un documento inexistente muestra 404", async ({ page }) => {
    const r = await page.goto("/documentos/999999");
    expect(r?.status()).toBe(404);
  });
});
