import { expect, request as pwRequest, test, type Page } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN, principal } from "./env";

const BASE = `http://localhost:${E2E_PORT}`;
const uid = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const cdmx = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" });
const todayMX = () => cdmx.format(new Date());
const addDays = (d: string, n: number) => {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day + n)).toISOString().slice(0, 10);
};

const MARK = uid();
const AMEX = "American Express Platinum";

test.describe("Transacciones: filtros dinámicos", () => {
  let amexId = 0;
  let oroId = 0;
  let costcoId = 0;

  test.beforeAll(async () => {
    const api = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { "x-ms-client-principal": principal("uziel.francotorres@gmail.com") } });
    const cards = (await (await api.get("/api/cards")).json()) as { id: number; name: string }[];
    amexId = cards.find((c) => c.name === AMEX)!.id;
    oroId = cards.find((c) => c.name === "Banamex Oro")!.id;
    costcoId = cards.find((c) => c.name === "Banamex Costco")!.id;
    const ing = pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { authorization: `Bearer ${E2E_TOKEN}` } });
    const ext = await ing;
    // Hoy: la compra más alta es de Amex ($20,000.00, mucho más que cualquier dato de ejemplo) y hay otra en Banamex Oro.
    for (const [merchant, amount, card] of [[`FILTROS AMEX ${MARK}`, "20000.00", AMEX], [`FILTROS ORO ${MARK}`, "3333.00", "Banamex Oro"]] as const) {
      const r = await ext.post("/api/ingest", { data: { merchant, amount, card, date: new Date().toISOString() } });
      expect(r.status()).toBeLessThan(300);
    }
    await ext.dispose();
    await api.dispose();
  });

  const bar = (page: Page) => page.getByTestId("tx-filters");
  const rows = (page: Page) => page.getByTestId("tx-row");
  const amounts = async (page: Page) => (await rows(page).locator("p.text-right").allInnerTexts()).map((t) => Number(t.replace(/[^0-9.-]/g, "")));

  test("chips de tarjeta: selección múltiple, contador, URL con card repetida y 'Todas'", async ({ page }) => {
    await page.goto("/transacciones");
    const chips = page.getByTestId("card-chips");
    await expect(page.getByTestId("card-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("card-count")).toHaveText("Todas");

    await page.getByTestId(`card-chip-${amexId}`).click();
    await expect(page.getByTestId(`card-chip-${amexId}`)).toHaveAttribute("aria-pressed", "true"); // respuesta inmediata
    await expect(page.getByTestId("card-all")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("card-count")).toHaveText("1 seleccionada");
    await page.getByTestId(`card-chip-${oroId}`).click();
    await expect(page.getByTestId("card-count")).toHaveText("2 seleccionadas");
    await expect(page).toHaveURL(new RegExp(`card=${amexId}&card=${oroId}`));
    await expect(chips).toBeVisible();

    // Solo se listan movimientos de las tarjetas elegidas (nunca Costco)
    await expect(rows(page).first()).toBeVisible();
    const texts = await rows(page).allInnerTexts();
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) { expect(t).toMatch(/American Express Platinum|Banamex Oro/); expect(t).not.toContain("Banamex Costco"); }

    // Desactivar una: toca de nuevo
    await page.getByTestId(`card-chip-${oroId}`).click();
    await expect(page.getByTestId("card-count")).toHaveText("1 seleccionada");
    await expect(page).toHaveURL(new RegExp(`card=${amexId}(&|$)`));
    await expect(page).not.toHaveURL(new RegExp(`card=${oroId}`));

    await page.getByTestId("card-all").click();
    await expect(page.getByTestId("card-count")).toHaveText("Todas");
    await expect(page).not.toHaveURL(/card=/);
  });

  test("el enlace card=<id> de otras pantallas sigue funcionando y se ve elegido", async ({ page }) => {
    await page.goto(`/transacciones?card=${costcoId}`);
    await expect(page.getByTestId(`card-chip-${costcoId}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("active-tag")).toHaveCount(1);
    for (const t of await rows(page).allInnerTexts()) expect(t).toContain("Banamex Costco");
  });

  test("atajo Hoy: filtra, resalta, URL con from/to/preset y tarjetitas con lo gastado hoy", async ({ page }) => {
    const today = todayMX();
    await page.goto("/transacciones");
    await page.getByTestId("period-today").click();
    await expect(page.getByTestId("period-today")).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp(`from=${today}&to=${today}&preset=today`));

    const total = page.getByTestId("insight-total");
    await expect(total).toContainText("Hoy llevas");
    await expect(total).toContainText(/en \d+ movimientos?/);
    const totalValue = Number((await page.getByTestId("insight-total-value").innerText()).replace(/[^0-9.-]/g, ""));
    expect(totalValue).toBeGreaterThanOrEqual(23333);
    await expect(total).toContainText(/ayer|Sin gasto ayer/);

    // Tarjetas que más gastaron: Amex primero, con monto y %
    const first = page.getByTestId("insight-card-row").first();
    await expect(first).toContainText(AMEX);
    await expect(first).toContainText("%");
    // Compra más alta
    await expect(page.getByTestId("insight-top")).toContainText("$20,000.00");
    await expect(page.getByTestId("insight-top")).toContainText(`FILTROS AMEX ${MARK}`);
    await expect(page.getByTestId("insight-category")).toBeVisible();

    // Solo hoy: aparecen las compras de hoy y la lista usa el mismo conjunto
    await expect(rows(page).filter({ hasText: `FILTROS AMEX ${MARK}` })).toHaveCount(1);

    // Tocar de nuevo el atajo activo lo quita
    await page.getByTestId("period-today").click();
    await expect(page.getByTestId("period-today")).toHaveAttribute("aria-pressed", "false");
    await expect(page).not.toHaveURL(/from=/);
  });

  test("tarjetitas compactas: una fila y poco alto en escritorio", async ({ page }, info) => {
    await page.goto("/transacciones?preset=today");
    const tiles = page.getByTestId("tx-insights").locator("> div");
    await expect(tiles).toHaveCount(4);
    if (info.project.name === "desktop") {
      const boxes = await Promise.all((await tiles.all()).map((t) => t.boundingBox()));
      const ys = new Set(boxes.map((b) => Math.round(b!.y)));
      expect(ys.size, "las 4 tarjetitas van en la misma fila").toBe(1);
      for (const b of boxes) expect(b!.height, `alto ${b!.height}`).toBeLessThanOrEqual(135);
    }
  });

  test("los atajos Ayer / Esta semana / Este mes / Mes pasado / 30 días ponen el periodo correcto", async ({ page }) => {
    const today = todayMX();
    await page.goto("/transacciones");
    await page.getByTestId("period-yesterday").click();
    await expect(page).toHaveURL(new RegExp(`from=${addDays(today, -1)}&to=${addDays(today, -1)}&preset=yesterday`));
    await page.getByTestId("period-last30").click();
    await expect(page).toHaveURL(new RegExp(`from=${addDays(today, -29)}&to=${today}&preset=last30`));
    await expect(page.getByTestId("period-last30")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("period-month").click();
    await expect(page).toHaveURL(new RegExp(`month=${today.slice(0, 7)}`));
    await expect(page.getByTestId("month-nav")).toBeVisible();
    // navegar al mes anterior
    await page.getByRole("button", { name: "Mes anterior" }).click();
    await expect(page).toHaveURL(/month=\d{4}-\d{2}/);
    await expect(page).not.toHaveURL(new RegExp(`month=${today.slice(0, 7)}`));
    await expect(page.getByTestId("period-last_month")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Mes siguiente" })).toBeEnabled();
    await page.getByTestId("period-week").click();
    await expect(page).toHaveURL(/preset=week/);
    await expect(page.getByTestId("period-week")).toHaveAttribute("aria-pressed", "true");
  });

  test("rango personalizado: dos fechas, corrige si quedan al revés", async ({ page }) => {
    await page.goto("/transacciones");
    await page.getByTestId("period-custom").click();
    const range = page.getByTestId("custom-range");
    await expect(range).toBeVisible();
    await range.getByLabel("Desde").fill("2026-01-10");
    await range.getByLabel("Hasta").fill("2026-02-20");
    await expect(page).toHaveURL(/from=2026-01-10&to=2026-02-20/);
    await expect(page).not.toHaveURL(/preset=/);
    // "Desde" posterior a "Hasta": la otra se alinea, nunca queda un rango imposible
    await range.getByLabel("Desde").fill("2026-03-05");
    await expect(page).toHaveURL(/from=2026-03-05&to=2026-03-05/);
    await expect(page.getByTestId("period-custom")).toHaveAttribute("aria-pressed", "true");
    // sin movimientos en ese periodo: una sola línea
    await page.goto("/transacciones?from=2019-01-01&to=2019-01-02");
    await expect(page.getByTestId("tx-insights-empty")).toHaveText("Sin movimientos en este periodo");
  });

  test("búsqueda con debounce: actualiza la URL sin recargar la página", async ({ page }) => {
    await page.goto("/transacciones");
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });
    const search = page.getByRole("searchbox", { name: "Buscar" });
    await search.pressSequentially(`FILTROS AMEX ${MARK}`, { delay: 20 });
    await expect(page).toHaveURL(new RegExp(`q=FILTROS\\+AMEX\\+${MARK}`), { timeout: 8000 });
    await expect(rows(page)).toHaveCount(1);
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true); // misma página: no hubo recarga
    await expect(page.getByTestId("active-tag").filter({ hasText: "Búsqueda" })).toBeVisible();
    // borrar con la x
    await page.getByRole("button", { name: "Borrar búsqueda" }).click();
    await expect(page).not.toHaveURL(/q=/);
    await expect(search).toHaveValue("");
  });

  test("más filtros: fuente, monto, solo recurrentes, orden y etiquetas removibles", async ({ page }) => {
    await page.goto("/transacciones");
    await page.getByTestId("more-filters").click();
    await expect(page.getByTestId("advanced-filters")).toBeVisible();

    await page.getByTestId("source-shortcut").click();
    await expect(page).toHaveURL(/source=shortcut/);
    await expect(rows(page).first()).toBeVisible();
    for (const t of await rows(page).allInnerTexts()) expect(t).toContain("Atajo");

    await page.getByLabel("Monto mínimo").fill("15000");
    await expect(page).toHaveURL(/min=15000/, { timeout: 8000 });
    await expect(rows(page).first()).toContainText("$20,000.00"); // la compra de Amex de hoy (llegó por el Atajo)
    for (const a of await amounts(page)) expect(a).toBeGreaterThanOrEqual(15000);
    await expect(page.getByTestId("active-tag").filter({ hasText: "Monto: desde $15,000" })).toBeVisible();

    // quitar solo la etiqueta del monto
    await page.getByRole("button", { name: /Quitar filtro: Monto/ }).click();
    await expect(page).not.toHaveURL(/min=/);
    await expect(page).toHaveURL(/source=shortcut/);

    await page.getByLabel("Ordenar por").selectOption("amount_desc");
    await expect(page).toHaveURL(/sort=amount_desc/);
    const a = await amounts(page);
    expect(a[0]).toBeGreaterThanOrEqual(20000);
    expect([...a].sort((x, y) => y - x)).toEqual(a);

    await page.getByTestId("flag-recurring").click();
    await expect(page).toHaveURL(/recurring=1/);
    // El seed tiene Netflix/Spotify... pero llegan por el Atajo sin la bandera de recurrente (solo el correo la pone): puede no haber filas.
    await expect(page.getByTestId("flag-recurring")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("flag-recurring").click();
    await expect(page).not.toHaveURL(/recurring=1/);

    // "Sin categoría"
    await page.getByLabel("Categoría", { exact: true }).selectOption("none");
    await expect(page).toHaveURL(/category=none/);
    await expect(page.getByTestId("active-tag").filter({ hasText: "Sin categoría" })).toBeVisible();
  });

  test("Limpiar filtros quita todo (menos el orden) y las etiquetas desaparecen", async ({ page }) => {
    await page.goto(`/transacciones?card=${amexId}&card=${oroId}&preset=today&source=shortcut&min=10&msi=1&sort=oldest`);
    const tags = page.getByTestId("active-tag");
    await expect(tags.first()).toBeVisible();
    // tarjetas (2) + periodo + fuente + monto + MSI
    await expect(tags).toHaveCount(6);
    await expect(page.getByTestId("more-filters")).toContainText("3"); // fuente + monto + MSI viven en "Más filtros"
    await page.getByTestId("clear-filters").click();
    await expect(tags).toHaveCount(0);
    await expect(page).toHaveURL(/\/transacciones\?sort=oldest$/); // el orden se conserva
    await expect(page.getByTestId("card-count")).toHaveText("Todas");
    await expect(page.getByTestId("clear-filters")).toHaveCount(0);
  });

  test("al cambiar un filtro se vuelve a la página 1 y la paginación conserva los filtros", async ({ page }) => {
    await page.goto("/transacciones");
    const next = page.getByRole("link", { name: "Siguiente" });
    await next.click();
    await expect(page).toHaveURL(/page=2/);
    await page.getByTestId(`card-chip-${amexId}`).click();
    await expect(page).toHaveURL(new RegExp(`card=${amexId}`));
    await expect(page).not.toHaveURL(/page=/);
    // el enlace de la página siguiente (si existe) conserva la tarjeta
    const link = page.getByRole("link", { name: "Siguiente" });
    if (await link.count()) await expect(link).toHaveAttribute("href", new RegExp(`card=${amexId}.*page=2`));
  });

  test("Gastos / Pagos de tarjeta conservan los filtros; el resumen habla de pagos", async ({ page }) => {
    await page.goto(`/transacciones?card=${oroId}&preset=today`);
    await page.getByRole("link", { name: "Pagos de tarjeta" }).click();
    await expect(page).toHaveURL(new RegExp(`kind=card_payment`));
    await expect(page).toHaveURL(new RegExp(`card=${oroId}`));
    await expect(page.getByRole("link", { name: "Pagos de tarjeta" })).toHaveAttribute("aria-current", "page");
    // Sin pagos hoy: una sola línea; con pagos (otros periodos) no existe la tarjetita de categorías
    await page.goto("/transacciones?kind=card_payment");
    await expect(page.getByTestId("insight-category")).toHaveCount(0);
  });

  test("parámetros inválidos no rompen la pantalla", async ({ page }) => {
    const res = await page.goto("/transacciones?from=2026-02-30&to=hoy&min=abc&max=-3&source=x&sort=zz&card=abc&category=zzz&month=2026-13&page=-4&msi=quizas");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Transacciones" })).toBeVisible();
    await expect(page.getByTestId("active-tag")).toHaveCount(0);
    await expect(rows(page).first()).toBeVisible();
  });

  test("accesible: chips con aria-pressed, etiquetas y foco visible por teclado", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "teclado: escritorio");
    await page.goto("/transacciones");
    await expect(bar(page).getByRole("group", { name: "Periodo" })).toBeVisible();
    await expect(bar(page).getByRole("group", { name: "Tarjetas" }).first()).toBeVisible();
    const chip = page.getByTestId("period-yesterday");
    await chip.focus();
    await expect(chip).toBeFocused();
    const outline = await chip.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Enter"); // activa/desactiva con el teclado
    await expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  test("celular: sin desbordamiento horizontal, objetivos táctiles ≥ 40 px y chips que se desplazan", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "solo celular");
    for (const url of ["/transacciones", "/transacciones?preset=today&source=shortcut&min=10", `/transacciones?card=${amexId}&card=${oroId}`, "/transacciones?preset=today&kind=card_payment"]) {
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      if (!url.includes("source=")) { await page.getByTestId("more-filters").click(); await expect(page.getByTestId("advanced-filters")).toBeVisible(); }
      const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      expect(sw, `${url}: scrollWidth ${sw} > ${cw}`).toBeLessThanOrEqual(cw);
    }
    await page.goto("/transacciones");
    for (const id of ["period-today", "period-custom", "card-all", `card-chip-${amexId}`]) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height, `${id} alto ${box.height}`).toBeGreaterThanOrEqual(40);
    }
    // La fila de tarjetas se desplaza en horizontal dentro de su contenedor
    const scroller = page.getByTestId("card-chips");
    const dims = await scroller.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
    expect(dims.ox).toBe("auto");
    expect(dims.sw).toBeGreaterThan(dims.cw);
    // Las tarjetitas se desplazan en horizontal en su propia fila
    const insights = page.getByTestId("tx-insights");
    const d2 = await insights.evaluate((el) => ({ ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth }));
    expect(d2.ox).toBe("auto");
  });
});
