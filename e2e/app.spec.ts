import { expect, request as pwRequest, test } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN, principal } from "./env";

const BASE = `http://localhost:${E2E_PORT}`;
/** Sufijo único: los proyectos desktop y mobile comparten la misma base. */
const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Mes anterior (YYYY-MM): el seed lo tiene completo, así las capturas muestran datos. */
function prevMonthMX() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

test.describe("seguridad (sin sesión / usuario ajeno / token)", () => {
  test("sin sesión: páginas y API → 401", async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
    for (const path of ["/", "/transacciones", "/api/transactions", "/api/cards", "/configuracion"]) {
      expect((await anon.get(path)).status(), path).toBe(401);
    }
    await anon.dispose();
  });
  test("usuario no permitido → 403", async () => {
    const other = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-ms-client-principal": principal("intruso@gmail.com") } });
    for (const path of ["/", "/api/transactions"]) expect((await other.get(path)).status(), path).toBe(403);
    await other.dispose();
  });
  test("ingesta: sin token/ token inválido → 401, malformado → 400, válido → 200 y deduplica", async () => {
    const anon = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: {} });
    const data = { merchant: `E2E CAFE ${uid()}`, amount: "42.00", card: "Banamex Oro" };
    expect((await anon.post("/api/ingest", { data })).status()).toBe(401);
    expect((await anon.post("/api/ingest", { data, headers: { authorization: "Bearer " + "z".repeat(48) } })).status()).toBe(401);
    const auth = { authorization: `Bearer ${E2E_TOKEN}` };
    expect((await anon.post("/api/ingest", { data: { merchant: "x" }, headers: auth })).status()).toBe(400);
    const date = new Date().toISOString();
    const ok = await anon.post("/api/ingest", { data: { ...data, date }, headers: auth });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).status).toBe("inserted");
    expect((await (await anon.post("/api/ingest", { data: { ...data, date }, headers: auth })).json()).status).toBe("duplicate");
    await anon.dispose();
  });
  test("cabeceras de seguridad y CSP con nonce", async ({ request }) => {
    const res = await request.get("/");
    const h = res.headers();
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-powered-by"]).toBeUndefined();
    expect(h["access-control-allow-origin"]).toBeUndefined();
  });
});

test.describe("dashboard", () => {
  test("selector de día y barras por día de la semana son interactivos", async ({ page }) => {
    await page.goto(`/?month=${prevMonthMX()}`);
    const day = page.getByRole("group", { name: "Seleccionar día del mes" }).getByRole("button", { name: "10", exact: true });
    await day.click();
    await expect(day).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("acumulado al día 10")).toBeVisible();
    const bar = page.getByRole("group", { name: "Gasto por día de la semana" }).getByRole("button").first();
    await bar.click();
    await expect(bar).toHaveAttribute("aria-pressed", "true");
  });

  test("navegar mes anterior/siguiente", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Mes anterior" }).click();
    await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
    await page.getByRole("link", { name: "Mes siguiente" }).click();
    await expect(page).not.toHaveURL(/month=/);
  });
});

test.describe("páginas y flujos", () => {
  test("todas las secciones cargan sin errores de consola (CSP incluida)", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    for (const [path, heading] of [["/transacciones", "Transacciones"], ["/tarjetas", "Tarjetas"], ["/categorias", "Categorías"], ["/recurrentes", "Recurrentes"], ["/actividad", "Actividad"], ["/analitica", "Analítica"], ["/reportes", "Reportes"], ["/configuracion", "Configuración"]]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("configuración nunca muestra el token", async ({ page }) => {
    await page.goto("/configuracion");
    await expect(page.locator("body")).not.toContainText(E2E_TOKEN);
    await expect(page.locator("body")).toContainText("/api/ingest");
  });

  test("agregar un gasto desde el diálogo lo muestra en Transacciones", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Agregar gasto" }).click();
    const dlg = page.getByRole("dialog", { name: "Agregar gasto" });
    const name = `Tacos e2e ${uid()}`;
    await dlg.getByLabel("Comercio").fill(name);
    await dlg.getByLabel("Monto (MXN)").fill("123.45");
    await dlg.getByRole("button", { name: "Agregar gasto" }).click();
    await expect(dlg).toBeHidden();
    await page.goto(`/transacciones?q=${encodeURIComponent(name)}`);
    await expect(page.getByTestId("tx-row")).toHaveCount(1);
    await expect(page.getByTestId("tx-row")).toContainText("$123.45");
  });

  test("buscador ⌘K: abre, filtra y navega", async ({ page, isMobile }) => {
    await page.goto("/");
    if (isMobile) await page.getByRole("button", { name: "Abrir buscador de comandos" }).click();
    else await page.keyboard.press("Control+k");
    const dlg = page.getByRole("dialog", { name: "Buscador de comandos" });
    await expect(dlg).toBeVisible();
    await dlg.getByRole("combobox").locator("input").fill("tarjet");
    await dlg.getByRole("option", { name: "Tarjetas" }).click();
    await expect(page).toHaveURL(/\/tarjetas/);
  });

  test("buscador ⌘K encuentra transacciones por comercio", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Abrir buscador de comandos" }).click();
    await page.getByPlaceholder(/Buscar comercio/).fill("starbucks");
    await expect(page.getByRole("group", { name: "Transacciones" }).getByRole("option").first()).toBeVisible();
  });

  test("crear tarjeta y categoría desde la UI", async ({ page }) => {
    await page.goto("/tarjetas?new=1");
    const dlg = page.getByRole("dialog", { name: "Nueva tarjeta" });
    const card = `Tarjeta E2E ${uid()}`;
    await dlg.getByLabel("Nombre").fill(card);
    await dlg.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText(card)).toBeVisible();
    await page.goto("/categorias");
    const cat = `Categoría E2E ${uid()}`;
    await page.getByRole("form", { name: "Nueva categoría" }).getByLabel("Nombre").fill(cat);
    await page.getByRole("form", { name: "Nueva categoría" }).getByRole("button", { name: "Agregar" }).click();
    await expect(page.getByLabel(`Nombre de ${cat}`)).toBeVisible();
  });
});

test.describe("responsive", () => {
  test("sin desbordamiento horizontal y menú lateral usable", async ({ page, isMobile }) => {
    for (const path of ["/", "/transacciones", "/tarjetas", "/categorias"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} desborda ${overflow}px`).toBeLessThanOrEqual(1);
    }
    if (isMobile) {
      await page.goto("/");
      await page.getByRole("button", { name: "Abrir menú" }).click();
      await page.getByRole("dialog", { name: "Menú" }).getByRole("link", { name: "Tarjetas" }).click();
      await expect(page).toHaveURL(/\/tarjetas/);
    }
  });
});
