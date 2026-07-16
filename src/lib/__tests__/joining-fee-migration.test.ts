import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260717170000_joining_fee_model/migration.sql"),
  "utf8",
);

// #1931 (E5): SQL pins for the JoiningFee fan-out migration — the shapes that
// protect money and cannot be exercised without a shadow database in unit CI.
describe("joining-fee model migration", () => {
  it("fans out per D-R1 and keeps the EntranceFee table (E13 drops it)", () => {
    expect(sql).toContain("WHEN 'CHILD' THEN ARRAY['CHILD', 'INFANT']::\"AgeTier\"[]");
    expect(sql).toContain("WHERE mt.\"key\" NOT IN ('NON_MEMBER', 'SCHOOL', 'FAMILY')");
    expect(sql).toContain("AND mt.\"key\" = 'FAMILY'");
    expect(sql).not.toContain('DROP TABLE "EntranceFee"');
  });

  it("materialises legacy amounts on COVERAGE of the migration day, not row existence", () => {
    // A lapsed-window-plus-legacy-amount install kept billing via the removed
    // runtime fallback; the pre-check must therefore key on "no window covers
    // today", not "no row exists".
    expect(sql).not.toMatch(
      /WHERE NOT EXISTS \(SELECT 1 FROM "EntranceFee" e2 WHERE e2\."category" = c\.category\)/,
    );
    const coverageChecks = sql.match(
      /AND e2\."effectiveFrom" <= timezone\('Pacific\/Auckland', statement_timestamp\(\)\)::date/g,
    );
    // Present in BOTH the per-tier and the flat-family statement.
    expect(coverageChecks).toHaveLength(2);
    expect(sql).toContain(
      'OR e2."effectiveTo" >= timezone(\'Pacific/Auckland\', statement_timestamp())::date',
    );
  });

  it("bounds a materialised window to the day before the earliest future window", () => {
    const bounds = sql.match(/SELECT MIN\(e3\."effectiveFrom"\) - 1/g);
    expect(bounds).toHaveLength(2);
    const futureGuards = sql.match(
      /AND e3\."effectiveFrom" > timezone\('Pacific\/Auckland', statement_timestamp\(\)\)::date/g,
    );
    expect(futureGuards).toHaveLength(2);
  });

  it("keeps honest club-time dates and explicit UTC bookkeeping timestamps", () => {
    expect(sql).toContain("timezone('Pacific/Auckland', statement_timestamp())::date");
    expect(sql).toContain("timezone('UTC', statement_timestamp())");
    expect(sql).not.toContain("CURRENT_DATE");
  });
});
