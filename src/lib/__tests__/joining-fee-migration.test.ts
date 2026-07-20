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

  it("materialises legacy amounts only where a legacy amount exists (not row existence)", () => {
    // A lapsed-window-plus-legacy-amount install kept billing via the removed
    // runtime fallback; the fill must key on "a legacy amount exists", never on
    // the naive "no EntranceFee row exists for this category".
    expect(sql).not.toMatch(
      /WHERE NOT EXISTS \(SELECT 1 FROM "EntranceFee" e2 WHERE e2\."category" = c\.category\)/,
    );
    // The legacy amount (per-category mapping, then global flat) gates every
    // fill, in BOTH the per-tier and the flat-family statement.
    const legacyJoins = sql.match(/JOIN legacy_amount la ON la\.category = g\.category/g);
    expect(legacyJoins).toHaveLength(2);
    const amountGuards = sql.match(/WHERE la\.amount IS NOT NULL\s+AND la\.amount > 0/g);
    expect(amountGuards).toHaveLength(2);
  });

  it("reproduces the uncovered-date fallback by filling EVERY gap, not just the leading one", () => {
    // (a) leading gap before the earliest relevant window (only when no window
    // covers the migration day).
    const leadingGaps = sql.match(
      /HAVING MIN\(GREATEST\(r\."effectiveFrom", timezone\('Pacific\/Auckland', statement_timestamp\(\)\)::date\)\)\s+> timezone\('Pacific\/Auckland', statement_timestamp\(\)\)::date/g,
    );
    expect(leadingGaps).toHaveLength(2);
    // (b) inter-window gap and (c) open tail after each bounded window: the span
    // starts the day after a window ends, up to the day before the NEXT window
    // (or +infinity — NULL gap_to — when it is the last).
    const interAndTail = sql.match(/r\."effectiveTo" \+ 1 AS gap_from/g);
    expect(interAndTail).toHaveLength(2);
    const nextWindow = sql.match(
      /\(SELECT MIN\(r2\."effectiveFrom"\)\s+FROM rel r2\s+WHERE r2\.category = r\.category\s+AND r2\."effectiveFrom" > r\."effectiveTo"\) - 1 AS gap_to/g,
    );
    expect(nextWindow).toHaveLength(2);
    // (d) whole open line when no relevant window exists for the category.
    const wholeLine = sql.match(
      /NULL::date AS gap_to\s+FROM cats c\s+WHERE NOT EXISTS \(SELECT 1 FROM rel r WHERE r\.category = c\.category\)/g,
    );
    expect(wholeLine).toHaveLength(2);
  });

  it("makes materialised windows the complement of the schedule windows (no overlap)", () => {
    // Only windows still on the migration-day-onward line are relevant; empty
    // gaps between adjacent windows are dropped, open tails (NULL) are kept — so
    // a fill never overlaps a scheduled EntranceFee window.
    const relevance = sql.match(
      /WHERE e\."effectiveTo" IS NULL\s+OR e\."effectiveTo" >= timezone\('Pacific\/Auckland', statement_timestamp\(\)\)::date/g,
    );
    expect(relevance).toHaveLength(2);
    const emptyGapGuard = sql.match(
      /AND \(g\.gap_to IS NULL OR g\.gap_to >= g\.gap_from\)/g,
    );
    expect(emptyGapGuard).toHaveLength(2);
  });

  it("keeps honest club-time dates and explicit UTC bookkeeping timestamps", () => {
    expect(sql).toContain("timezone('Pacific/Auckland', statement_timestamp())::date");
    expect(sql).toContain("timezone('UTC', statement_timestamp())");
    expect(sql).not.toContain("CURRENT_DATE");
  });
});
