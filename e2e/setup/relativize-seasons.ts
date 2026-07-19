// E2E bootstrap: re-date the base-seed booking seasons to RELATIVE spans so the
// seeded fixtures never expire (issue #2117). Run by scripts/e2e-stack.sh AFTER
// the base seed has created the seasons + their rates, and BEFORE the optional
// second-lodge provisioning (which mirrors lodge A's season dates), so lodge B
// inherits the same relative spans.
//
// WHY here and not in prisma/seed.ts: seed.ts is the club-agnostic PRODUCTION
// first-run seed — a real club's "Winter 2026" season is genuine operational
// data and must stay fixed. Only the demo/E2E database gets relative seasons.
// The single source of truth for the spans is SEEDED_SEASONS in
// prisma/e2e-fixtures.ts, which e2e/helpers/stay-dates.ts also reads, so the DB
// seasons and the specs' winter/summer rate-column math can never drift.
import { PrismaClient } from "@prisma/client";
import { createPrismaPgAdapter } from "../../src/lib/prisma-adapter";
import { SEEDED_SEASONS } from "../../prisma/e2e-fixtures";

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

// Convert a YYYY-MM-DD (date-only) string to the UTC-midnight Date the schema's
// @db.Date columns store — matching prisma/seed.ts's own `new Date("YYYY-MM-DD")`.
function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

async function main() {
  // Map the base seed's WINTER/SUMMER seasons onto the relative spans by type,
  // so this works regardless of the base seed's season ids.
  const byType: Record<string, { start: string; end: string }> = {
    winter: SEEDED_SEASONS[0],
    summer: SEEDED_SEASONS[1],
  };

  for (const [key, span] of Object.entries(byType)) {
    const type = key.toUpperCase();
    const result = await prisma.season.updateMany({
      where: { type: type as never },
      data: { startDate: dateOnly(span.start), endDate: dateOnly(span.end) },
    });
    console.log(
      `Relativized ${result.count} ${type} season(s): ${span.start} … ${span.end}`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
