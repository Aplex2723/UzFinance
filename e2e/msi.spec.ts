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

test.describe("metas de ahorro", () => {
  test("se crean varias desde el inicio, se editan y se eliminan; /metas muestra la predicción", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "una sola vez: cambia datos");
    await page.goto("/");
    const panel = page.getByTestId("goal-panel");
    await expect(panel).toContainText("Crea una meta");

    // Primera meta (con un error de captura primero).
    await panel.getByTestId("new-goal").click();
    const dialog = page.getByRole("dialog", { name: "Nueva meta" });
    await dialog.getByLabel("Nombre").fill("Pago de departamento");
    await dialog.getByLabel("Cuánto cuesta (MXN)").fill("abc");
    await dialog.getByLabel("Para cuándo").fill("2099-10-05");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog.getByRole("alert")).toContainText("inválido");
    await dialog.getByLabel("Cuánto cuesta (MXN)").fill("1600000");
    await dialog.getByLabel("Ahorrado hoy (MXN)").fill("308500");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByTestId("goal-row")).toHaveCount(1);
    await expect(panel).toContainText("Pago de departamento");
    await expect(panel.getByTestId("goal-saved")).toContainText("$308,500");
    await expect(panel.getByTestId("goal-permonth")).toContainText("$");

    // Segunda meta: solo el mes y prioridad alta.
    await panel.getByTestId("new-goal").click();
    const second = page.getByRole("dialog", { name: "Nueva meta" });
    await second.getByLabel("Nombre").fill("Tesla");
    await second.getByLabel("Tipo").selectOption("auto");
    await second.getByLabel("Prioridad").selectOption("1");
    await second.getByLabel("Cuánto cuesta (MXN)").fill("1200000");
    await second.getByRole("button", { name: "Solo el mes" }).click();
    await second.getByLabel("Para cuándo").fill("2099-04");
    await second.getByRole("button", { name: "Guardar" }).click();
    await expect(second).toBeHidden();
    await expect(panel.getByTestId("goal-row")).toHaveCount(2);
    await expect(panel.getByTestId("goal-row").filter({ hasText: "Tesla" })).toContainText("abril 2099");
    await expect(panel.getByTestId("goal-row").first()).toContainText("Tesla"); // prioridad alta primero

    // Página de análisis.
    await panel.getByTestId("goals-detail").click();
    await expect(page).toHaveURL(/\/metas$/);
    await expect(page.getByRole("heading", { name: "Metas", level: 1 })).toBeVisible();
    await expect(page.getByTestId("goal-card")).toHaveCount(2);
    await expect(page.getByTestId("goals-surplus")).toContainText("$");
    await expect(page.getByTestId("scenarios")).toContainText("Como vas hoy");
    await expect(page.getByTestId("recap-generate")).toBeVisible();

    // Editar y eliminar desde el inicio.
    await page.goto("/");
    await panel.getByTestId("goal-row").filter({ hasText: "Tesla" }).getByTestId("edit-goal").click();
    const edit = page.getByRole("dialog", { name: "Editar meta" });
    await edit.getByLabel("Nombre").fill("Tesla Model Y");
    await edit.getByRole("button", { name: "Guardar" }).click();
    await expect(edit).toBeHidden();
    await expect(panel).toContainText("Tesla Model Y");
    await panel.getByTestId("goal-row").filter({ hasText: "Tesla Model Y" }).getByTestId("edit-goal").click();
    const del = page.getByRole("dialog", { name: "Editar meta" });
    await del.getByTestId("delete-goal").click();
    await del.getByTestId("confirm-delete-goal").click();
    await expect(del).toBeHidden();
    await expect(panel.getByTestId("goal-row")).toHaveCount(1);
    await expect(panel).not.toContainText("Tesla");
  });

  test("las metas quedan arriba (antes de las tarjetas) y el celular no se desborda", async ({ page }, info) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    expect(await top('[data-testid="goal-panel"]')).toBeLessThan(await top('section[aria-label="Tarjetas"]'));
    if (info.project.name === "mobile") {
      for (const path of ["/", "/metas"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(sw, path).toBeLessThanOrEqual(cw);
      }
    }
  });
});
