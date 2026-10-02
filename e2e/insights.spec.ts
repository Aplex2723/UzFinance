import { expect, request as pwRequest, test } from "@playwright/test";
import { E2E_PORT } from "./env";

const BASE = `http://localhost:${E2E_PORT}`;

test.describe("app instalable (PWA)", () => {
  test("manifest e íconos son públicos (sin sesión) y válidos; las páginas siguen protegidas", async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
    const m = await anon.get("/manifest.webmanifest");
    expect(m.status()).toBe(200);
    const manifest = await m.json();
    expect(manifest).toMatchObject({ name: "UzFinance", display: "standalone", start_url: "/", lang: "es-MX" });
    expect(manifest.icons.map((i: { purpose: string }) => i.purpose)).toEqual(expect.arrayContaining(["any", "maskable"]));
    for (const icon of manifest.icons as { src: string; type: string }[]) {
      const r = await anon.get(icon.src);
      expect(r.status(), icon.src).toBe(200);
      expect(r.headers()["content-type"]).toContain("image/png");
    }
    expect((await anon.get("/icons/apple-touch-icon.png")).status()).toBe(200);
    // Lo público es solo lo estático: nada de datos.
    for (const path of ["/", "/analitica", "/configuracion", "/api/settings/income", "/api/transactions"]) expect((await anon.get(path)).status(), path).toBe(401);
    await anon.dispose();
  });

  test("el HTML declara manifest, ícono de iOS y viewport-fit=cover", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest/);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /apple-touch-icon\.png/);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "UzFinance");
  });
});

test.describe("navegación móvil", () => {
  test("barra inferior solo en celular; «Más» abre el menú completo", async ({ page }, info) => {
    await page.goto("/");
    const bar = page.getByTestId("bottom-nav");
    if (info.project.name === "mobile") {
      await expect(bar).toBeVisible();
      await bar.getByRole("link", { name: "Analítica" }).click();
      await expect(page).toHaveURL(/\/analitica/);
      await expect(bar.getByRole("link", { name: "Analítica" })).toHaveAttribute("aria-current", "page");
      await page.getByTestId("bottom-nav").getByRole("button", { name: "Más opciones" }).click();
      await expect(page.getByRole("dialog", { name: "Menú" }).getByRole("link", { name: "Configuración" })).toBeVisible();
    } else {
      await expect(bar).toBeHidden();
    }
  });

  for (const path of ["/", "/analitica", "/tarjetas", "/transacciones", "/configuracion", "/recurrentes"]) {
    test(`sin desborde horizontal en ${path}`, async ({ page }, info) => {
      test.skip(info.project.name !== "mobile", "solo celular");
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `scrollWidth ${sw} > ${cw}`).toBeLessThanOrEqual(cw);
    });
  }
});

test.describe("ingreso e insights", () => {
  test("el inicio muestra ingreso, ritmo, promedio por día y proyección", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("pace-bar")).toBeVisible();
    await expect(page.getByTestId("income-used")).toHaveText(/\d+%/);
    await expect(page.getByTestId("avg-per-day")).toContainText("$");
    await expect(page.getByTestId("projection")).toContainText("$");
    await expect(page.getByTestId("insight-list").first()).toBeVisible();
    // Los 4 KPIs y el estado de ingreso quedan antes que las tarjetas y las gráficas.
    const top = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
    expect(await top('[data-testid="pace-bar"]')).toBeLessThan(await top('section[aria-label="Tarjetas"]'));
    expect(await top('section[aria-label="Cifras clave"]')).toBeLessThan(await top('section[aria-label="Tarjetas"]'));
  });

  test("editar el ingreso lo guarda y cambia los porcentajes", async ({ page }) => {
    await page.goto("/");
    const before = await page.getByTestId("income-used").innerText();
    await page.getByTestId("pace-bar").getByTestId("edit-income").click();
    const dialog = page.getByRole("dialog", { name: "Ingreso mensual" });
    await dialog.getByLabel("Monto mensual (MXN)").fill("abc");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Monto inválido");
    await dialog.getByLabel("Monto mensual (MXN)").fill("10000");
    await dialog.getByRole("button", { name: "Guardar" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("pace-bar")).toContainText("$10,000 al mes");
    await expect(page.getByTestId("income-used")).not.toHaveText(before);

    await page.goto("/configuracion");
    await expect(page.getByTestId("income-value")).toHaveText("$10,000.00");
    // Se deja como estaba (ingreso inicial) para no afectar otras pruebas.
    await page.getByTestId("edit-income").click();
    await page.getByRole("dialog", { name: "Ingreso mensual" }).getByLabel("Monto mensual (MXN)").fill("350000");
    await page.getByRole("dialog", { name: "Ingreso mensual" }).getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByTestId("income-value")).toHaveText("$350,000.00");
  });

  test("analítica: gráfica de 12 meses, comparación con meses anteriores y categorías", async ({ page }) => {
    await page.goto("/analitica");
    await expect(page.getByTestId("income-chart")).toBeVisible();
    await expect(page.getByTestId("history-table").locator("tbody tr")).toHaveCount(6);
    await expect(page.getByTestId("category-compare")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Comercios donde más gastas/ })).toBeVisible();
    await page.getByRole("link", { name: "Mes anterior" }).click();
    await expect(page).toHaveURL(/month=/);
    await expect(page.getByTestId("pace-bar")).toContainText("Mes cerrado");
  });

  test("tarjetas ilustradas: cada tarjeta muestra su diseño", async ({ page }) => {
    await page.goto("/tarjetas");
    await expect(page.locator("[data-art]").first()).toBeVisible();
    await expect(page.locator('[data-art="amex-platinum"]').first()).toBeVisible();
    await page.getByRole("button", { name: "Editar" }).first().click();
    await expect(page.getByLabel("Diseño de la tarjeta")).toBeVisible();
  });
});
