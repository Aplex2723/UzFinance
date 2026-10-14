import { defineConfig } from "@playwright/test";
import { E2E_ENV, E2E_PORT, principal } from "./e2e/env";

const baseURL = `http://localhost:${E2E_PORT}`;
const extraHTTPHeaders = { "x-ms-client-principal": principal("owner@example.com") };

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL, extraHTTPHeaders, trace: "retain-on-failure" },
  // Requiere `npm run build` previo (el script test:e2e ya lo hace).
  webServer: { command: "npm run start", env: E2E_ENV, url: `${baseURL}/`, reuseExistingServer: false, timeout: 120_000, ignoreHTTPSErrors: true,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 } },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } },
  ],
});
