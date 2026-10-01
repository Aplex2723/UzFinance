import { execSync } from "node:child_process";
import { E2E_ENV } from "./env";

/** Recrea y siembra la base e2e antes de arrancar. */
export default function setup() {
  const run = (cmd: string) => execSync(cmd, { env: E2E_ENV, stdio: "inherit" });
  run("npx tsx scripts/reset.ts");
  run("npx tsx scripts/migrate.ts");
  run("npx tsx scripts/seed.ts");
}
