import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], setupFiles: ["tests/setup-env.ts"] } },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/setup-env.ts"],
          globalSetup: ["tests/global-setup.ts"],
          fileParallelism: false, // comparten una sola base
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: { provider: "v8", include: ["src/lib/**"], reporter: ["text-summary"] },
  },
});
