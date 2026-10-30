import { expect, test, type Page } from "@playwright/test";

/** Respuesta NDJSON simulada del servidor (el e2e nunca llama a OpenRouter). */
const ndjson = (...events: object[]) => `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
const ANSWER = ndjson(
  { type: "tool", id: "t1", label: "Agrupando por categoría", phase: "start" },
  { type: "tool", id: "t1", label: "Agrupando por categoría", phase: "end", ok: true },
  { type: "text", delta: "Gastas más en **Súper**" },
  { type: "text", delta: ": $4,030.01.\n\n- Segunda: **Suscripciones**" },
  { type: "done" },
);

async function openChat(page: Page) {
  await page.goto("/");
  await page.getByTestId("uzchat-open").click();
  const chat = page.getByRole("dialog", { name: "UzChat" });
  await expect(chat).toBeVisible();
  return chat;
}

test.describe("UzChat", () => {
  test("el orbe abre el chat con el brillo en el borde; Esc y la X lo cierran", async ({ page }) => {
    const chat = await openChat(page);
    await expect(chat.locator(".uz-glow")).toHaveAttribute("data-on", "true");
    await expect(chat.getByText("Hola, soy UzChat")).toBeVisible();
    await expect(chat.getByRole("button", { name: /Cómo voy este mes/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(chat).toBeHidden();
    await expect(page.getByTestId("uzchat-open")).toBeVisible();
    await page.getByTestId("uzchat-open").click();
    await chat.getByRole("button", { name: "Cerrar UzChat" }).click();
    await expect(chat).toBeHidden();
  });

  test("pregunta → consulta → respuesta con formato, y la conversación se recuerda", async ({ page }) => {
    let sent: { messages: { role: string; content: string }[] } | null = null;
    await page.route("**/api/chat", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ANSWER });
    });
    const chat = await openChat(page);
    await page.getByTestId("uzchat-input").fill("¿En qué gasto más?");
    await page.getByTestId("uzchat-send").click();
    await expect(chat.getByText("¿En qué gasto más?")).toBeVisible();
    await expect(chat.getByText("Agrupando por categoría")).toBeVisible();
    await expect(chat.locator("b", { hasText: "Súper" })).toBeVisible();
    await expect(chat.getByRole("listitem")).toContainText("Suscripciones");
    expect(sent).toEqual({ messages: [{ role: "user", content: "¿En qué gasto más?" }] });
    // Sin conversación vacía de nuevo: al recargar y abrir, sigue ahí.
    await page.reload();
    await page.getByTestId("uzchat-open").click();
    await expect(page.getByRole("dialog", { name: "UzChat" }).getByText("¿En qué gasto más?")).toBeVisible();
    // «Nueva conversación» la borra.
    await page.getByRole("button", { name: "Nueva conversación" }).click();
    await expect(page.getByText("Hola, soy UzChat")).toBeVisible();
  });

  test("un error del servidor se muestra y «Reintentar» vuelve a preguntar", async ({ page }) => {
    let n = 0;
    await page.route("**/api/chat", async (route) => {
      n++;
      if (n === 1) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "Ya mandaste muchos mensajes" }) });
      return route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson({ type: "text", delta: "Listo." }, { type: "done" }) });
    });
    const chat = await openChat(page);
    await chat.getByRole("button", { name: /Cómo voy este mes/ }).click();
    await expect(chat.getByRole("alert")).toContainText("Ya mandaste muchos mensajes");
    await chat.getByRole("button", { name: "Reintentar" }).click();
    await expect(chat.getByText("Listo.")).toBeVisible();
    await expect(chat.getByRole("alert")).toHaveCount(0);
    expect(n).toBe(2);
  });

  test("un error a media respuesta conserva lo que ya llegó", async ({ page }) => {
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson({ type: "text", delta: "Empecé a contestar" }, { type: "error", message: "El modelo tardó demasiado" }) }));
    const chat = await openChat(page);
    await page.getByTestId("uzchat-input").fill("hola");
    await page.getByTestId("uzchat-send").click();
    await expect(chat.getByText("Empecé a contestar")).toBeVisible();
    await expect(chat.getByRole("alert")).toContainText("El modelo tardó demasiado");
  });

  test("un flujo que se corta sin «done» no se toma por respuesta completa y no se recuerda", async ({ page }) => {
    await page.route("**/api/chat", (route) => route.fulfill({ status: 200, contentType: "application/x-ndjson", body: ndjson({ type: "text", delta: "Media respuesta" }) }));
    const chat = await openChat(page);
    await page.getByTestId("uzchat-input").fill("hola");
    await page.getByTestId("uzchat-send").click();
    await expect(chat.getByText("Media respuesta")).toBeVisible();
    await expect(chat.getByRole("alert")).toContainText("Se cortó la respuesta");
    await page.reload();
    await page.getByTestId("uzchat-open").click();
    await expect(page.getByRole("dialog", { name: "UzChat" }).getByText("Media respuesta")).toHaveCount(0);
  });

  test("reabrir justo después de cerrar no lo vuelve a cerrar", async ({ page }) => {
    const chat = await openChat(page);
    await chat.getByRole("button", { name: "Cerrar UzChat" }).click();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("uz:open-chat")));
    await page.waitForTimeout(400); // más que los 220 ms de la animación de cierre
    await expect(chat).toBeVisible();
  });

  test("desde ⌘K se puede abrir; en celular el orbe no tapa la barra inferior", async ({ page }, info) => {
    await page.goto("/");
    if (info.project.name === "mobile") {
      const orb = await page.getByTestId("uzchat-open").boundingBox();
      const bar = await page.getByTestId("bottom-nav").boundingBox();
      expect(orb && bar && orb.y + orb.height <= bar.y).toBe(true);
    } else {
      await page.keyboard.press("Control+k");
      await page.getByRole("combobox").getByRole("textbox").fill("uzchat");
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog", { name: "UzChat" })).toBeVisible();
    }
  });
});
