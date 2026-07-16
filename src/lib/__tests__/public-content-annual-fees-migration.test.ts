import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// E7 review Findings F1/F2 (#1933): the public-content annual-fees migration must
// preserve the public visibility an existing install already had, with no admin
// action required. These assertions fail before the two back-compat backfills are
// added and pass once they are.
const sql = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260717200000_public_content_annual_fees/migration.sql",
  ),
  "utf8",
);

// Normalise whitespace so the assertions are tolerant of formatting/line breaks.
const normalised = sql.replace(/\s+/g, " ");

describe("public-content annual-fees migration", () => {
  it("adds the dedicated annualFees visibility gate", () => {
    expect(sql).toContain('ADD COLUMN "annualFees" BOOLEAN NOT NULL DEFAULT false');
  });

  it("F2: backfills the new annualFees gate from the legacy membershipTypes gate so a previously-visible {{membership-types}} embed stays visible", () => {
    expect(normalised).toContain(
      'UPDATE "PublicContentSettings" SET "annualFees" = "membershipTypes";',
    );
    // Legacy gate column is retained (visibility-preserving, no destructive drop).
    expect(sql).not.toContain('DROP COLUMN "membershipTypes"');
  });

  it("F1: marks the built-in FULL and FAMILY types publicly listed so their historically-public joining fees survive E7's publiclyListed filter", () => {
    expect(normalised).toContain(
      "UPDATE \"MembershipType\" SET \"publiclyListed\" = true WHERE \"key\" IN ('FULL', 'FAMILY') AND \"publiclyListed\" = false;",
    );
    // The backfill must stay scoped to the two core built-in types — it must not
    // flip every membership type public (that would leak genuinely non-public types).
    expect(normalised).not.toMatch(
      /UPDATE\s+"MembershipType"\s+SET\s+"publiclyListed"\s*=\s*true\s*;/,
    );
  });

  it("performs the backfills without a session clock (blue/green safety)", () => {
    expect(sql).not.toMatch(/\bnow\s*\(/i);
    expect(sql).not.toContain("CURRENT_TIMESTAMP");
  });
});
