import { expect, test } from "@playwright/test";

/** Corre primero (orden alfabético): la captura muestra solo los datos de ejemplo del seed. */
function prevMonthMX() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

test.describe("dashboard (captura de diseño)", () => {
  test("muestra los 7 módulos con datos y captura de pantalla", async ({ page }, info) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`/?month=${prevMonthMX()}`);

    await expect(page.getByTestId("month-total")).toContainText("$");
    await expect(page.getByRole("button", { name: "Agregar gasto" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Importar CSV" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Categorizar" })).toBeVisible();
    // tarjetero: un montón por banco; al tocarlo se despliegan sus tarjetas
    await expect(page.getByTestId("wallet-amex")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(0);
    await page.getByTestId("wallet-amex").click();
    await expect(page.getByTestId("wallet-amex")).toHaveAttribute("aria-expanded", "true");
    expect(await page.getByRole("article").count()).toBeGreaterThanOrEqual(1);
    await page.getByTestId("wallet-amex").click();
    await expect(page.getByRole("article")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Agregar otra tarjeta/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Gasto acumulado/ })).toBeVisible();
    await expect(page.getByRole("group", { name: "Gasto por día de la semana" }).getByRole("button")).toHaveCount(7);
    await expect(page.getByRole("heading", { name: "Actividad reciente" })).toBeVisible();
    await expect(page.getByRole("img", { name: /Flujo del gasto/ })).toBeVisible();
    await expect(page.getByRole("img", { name: /Mapa de calor/ })).toBeVisible();
    await page.waitForTimeout(600); // animaciones/medidas de las gráficas

    await page.screenshot({ path: `docs/screenshots/dashboard-${info.project.name}.png`, fullPage: true });
    expect(errors, errors.join("\n")).toEqual([]);
  });
});
