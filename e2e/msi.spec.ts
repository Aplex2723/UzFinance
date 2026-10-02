import { expect, test } from "@playwright/test";

test.describe("meses sin intereses", () => {
  test("la página resume la carga del mes, el saldo, cuándo terminas y lista los planes", async ({ page }) => {
    await page.goto("/msi");
    await expect(page.getByRole("heading", { name: "Meses sin intereses", level: 1 })).toBeVisible();
    await expect(page.getByTestId("msi-load")).toContainText("$");
    await expect(page.getByTestId("msi-remaining")).toContainText("$");
    await expect(page.getByTestId("msi-free")).not.toHaveText("—");
    await expect(page.getByTestId("insight-list")).toBeVisible();
    await expect(page.getByTestId("msi-timeline")).toBeVisible();
    await expect(page.getByTestId("msi-started")).toBeVisible();
    const plans = page.getByTestId("msi-plans").locator("li");
    await expect(plans).toHaveCount(3);
    await expect(plans.first()).toContainText(/Pago \d+ de \d+/);
    for (const name of ["LAPTOP DEMO", "VIAJE DEMO", "SOFA DEMO"]) await expect(plans.filter({ hasText: name })).toHaveCount(1);
    // Ordenados por fecha de término: la laptop (24 meses) va al final.
    await expect(plans.last()).toContainText("LAPTOP DEMO");
    await expect(page.getByRole("heading", { name: /Tus planes vigentes · 3/ })).toBeVisible();
  });

  test("las cifras clave quedan antes que las gráficas y el celular no se desborda", async ({ page }, info) => {
    await page.goto("/msi");
    await page.waitForLoadState("networkidle");
    const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    expect(await top('section[aria-label="Cifras clave de MSI"]')).toBeLessThan(await top('[data-testid="msi-timeline"]'));
    if (info.project.name === "mobile") {
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw).toBeLessThanOrEqual(cw);
    }
  });

  test("el inicio trae el resumen de MSI y el menú lo enlaza", async ({ page }, info) => {
    await page.goto("/");
    const panel = page.getByTestId("msi-summary");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Se cobra este mes");
    await page.getByRole("link", { name: "Ver detalle" }).click();
    await expect(page).toHaveURL(/\/msi$/);
    if (info.project.name === "desktop") await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Meses sin intereses" })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("comercios por categorizar", () => {
  test("lista los comercios sin categoría con su total", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "la prueba de celular los categoriza");
    await page.goto("/");
    const rows = page.getByTestId("pending-merchant");
    await expect(page.getByTestId("pending-merchants")).toBeVisible();
    await expect(rows.filter({ hasText: "TIENDITA DEL BARRIO DEMO" })).toContainText("2 movimientos");
    await expect(rows.filter({ hasText: "PUESTO RARO DEMO" })).toContainText("1 movimiento");
  });

  test("elegir la categoría la aplica a TODOS los movimientos de ese comercio y lo quita de la lista", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "una sola vez: cambia datos");
    await page.goto("/");
    const row = page.getByTestId("pending-merchant").filter({ hasText: "TIENDITA DEL BARRIO DEMO" });
    await row.getByRole("combobox").selectOption({ label: "Supermercado" });
    await expect(page.getByTestId("pending-merchant").filter({ hasText: "TIENDITA DEL BARRIO DEMO" })).toHaveCount(0);
    await page.goto("/transacciones?q=TIENDITA");
    const items = page.getByRole("listitem").filter({ hasText: "TIENDITA DEL BARRIO DEMO" });
    await expect(items).toHaveCount(2);
    for (const i of await items.all()) await expect(i).not.toContainText("IA ");
    await page.goto("/transacciones?q=TIENDITA&category=none");
    await expect(page.getByText("TIENDITA DEL BARRIO DEMO")).toHaveCount(0);
  });
});

test.describe("categorías y descripciones", () => {
  test("cada categoría muestra su descripción editable (criterio de la IA) y se guarda", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "una sola vez: cambia datos");
    await page.goto("/categorias");
    const box = page.getByLabel("Descripción de Salud");
    await expect(box).toContainText("Farmacias");
    await box.fill("Farmacias, doctores y dentista (descripción de prueba)");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/categories/") && r.request().method() === "PUT"), box.blur()]);
    await page.reload();
    await expect(page.getByLabel("Descripción de Salud")).toHaveValue(/descripción de prueba/);
    // Renombrar/recolorear no debe borrar la descripción.
    await page.getByLabel("Nombre de Salud").fill("Salud y bienestar");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/categories/") && r.request().method() === "PUT"), page.getByLabel("Nombre de Salud").blur()]);
    await page.reload();
    await expect(page.getByLabel("Descripción de Salud y bienestar")).toHaveValue(/descripción de prueba/);
    await page.getByLabel("Nombre de Salud y bienestar").fill("Salud");
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/categories/") && r.request().method() === "PUT"), page.getByLabel("Nombre de Salud y bienestar").blur()]);
    await page.reload();
    await expect(page.getByLabel("Descripción de Salud")).toBeVisible();
  });
});

test.describe("meta de ahorro", () => {
  test("se crea desde el inicio y muestra avance, faltante y cuánto apartar al mes", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "una sola vez: cambia datos");
    await page.goto("/");
    await expect(page.getByTestId("goal-panel")).toContainText("Crea una meta");
    await page.getByTestId("edit-goal").click();
    const dialog = page.getByRole("dialog", { name: "Meta de ahorro" });
    await dialog.getByLabel("Nombre").fill("Pago de departamento");
    await dialog.getByLabel("Meta (MXN)").fill("abc");
    await dialog.getByLabel("Fecha límite").fill("2099-10-05");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog.getByRole("alert")).toContainText("inválido");
    await dialog.getByLabel("Meta (MXN)").fill("1600000");
    await dialog.getByLabel("Ahorrado hoy (MXN)").fill("308500");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog).toBeHidden();
    const panel = page.getByTestId("goal-panel");
    await expect(panel).toContainText("Pago de departamento");
    await expect(page.getByTestId("goal-pct")).toHaveText("19%");
    await expect(page.getByTestId("goal-remaining")).toContainText("$1,291,500");
    await expect(page.getByTestId("goal-permonth")).toContainText("$");
    await expect(panel.getByTestId("insight-list")).toContainText("necesitas apartar");
  });

  test("la meta queda arriba (antes de las tarjetas) y el celular no se desborda", async ({ page }, info) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    expect(await top('[data-testid="goal-panel"]')).toBeLessThan(await top('section[aria-label="Tarjetas"]'));
    if (info.project.name === "mobile") {
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw).toBeLessThanOrEqual(cw);
    }
  });
});
