#!/usr/bin/env npx tsx
/**
 * Out-of-band config self-heal (epic #1943, child C2).
 *
 * Runs the SAME routine the app runs on boot
 * (`src/lib/config-self-heal.ts` → `runConfigSelfHeal`): for each registered
 * setting, copy the current EFFECTIVE `config/club.json` value into its DB row
 * IFF that row is still absent. Create-if-absent, idempotent, and blue/green
 * safe — it never overwrites an admin's configured value.
 *
 * The default path is automatic (the app self-heals on every boot). Use this
 * script for a deliberate two-phase deploy, to verify a cold DB, or to heal
 * out-of-band without a restart. Requires DATABASE_URL.
 *
 *   npm run config:self-heal
 */
import "dotenv/config";
import process from "node:process";
import { runConfigSelfHeal } from "../src/lib/config-self-heal";
import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("Running config self-heal (create-if-absent boot backfill)...");

  const summary = await runConfigSelfHeal({ db: prisma });

  for (const result of summary.results) {
    const detail = result.error ? ` — ${result.error}` : "";
    console.log(`  ${result.name}: ${result.outcome}${detail}`);
  }

  console.log(
    `Config self-heal complete — healed=${summary.healed}, ` +
      `already-present=${summary.alreadyPresent}, failed=${summary.failed}`,
  );

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
