import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(process.cwd(), "prisma/migrations/20260713110000_authoritative_fee_schedules/migration.sql"),
  "utf8",
);

describe("authoritative fee migration", () => {
  it("defaults all public listings hidden and keeps legacy amount columns", () => {
    expect(sql).toContain('"publiclyListed" BOOLEAN NOT NULL DEFAULT false');
    expect(sql).not.toContain('DROP COLUMN "amountCents"');
    expect(sql).not.toContain("DELETE FROM \"XeroAccountMapping\"");
  });

  it("backfills granular amounts before the flat legacy fallback without providers", () => {
    expect(sql).toContain('FROM "XeroItemCodeMapping" e');
    expect(sql).toContain('WHERE "key" = \'entranceFeeAmountCents\'');
    expect(sql).toContain("timezone('Pacific/Auckland', statement_timestamp())::date");
    expect(sql).not.toContain("CURRENT_DATE");
    expect(sql).toContain("timezone('UTC', statement_timestamp())");
    expect(sql).toContain("\"code\" ~ '^[0-9]{1,10}$'");
    expect(sql).toContain('"code"::bigint <= 2147483647');
    expect(sql).not.toMatch(/https?:\/\//);
  });

  it("stores a Prisma-representable membership-row recipient that clears on removal", () => {
    expect(sql).toContain('"billingMembershipId" TEXT');
    expect(sql).toContain('CONSTRAINT "FamilyGroup_billingMembershipId_fkey"');
    expect(sql).toContain('REFERENCES "FamilyGroupMember"("id") ON DELETE SET NULL');
  });

  it("uses the explicitly mapped short annual-fee lookup index name", () => {
    expect(sql).toContain('CREATE INDEX "MembershipAnnualFee_effective_lookup_idx"');
  });

  it("enforces cents, date ordering, no-invoice zero, and database overlap guards", () => {
    expect(sql).toContain('"MembershipAnnualFee_amount_nonnegative"');
    expect(sql).toContain('"MembershipAnnualFee_date_order"');
    expect(sql).toContain('"MembershipAnnualFee_no_invoice_zero"');
    expect(sql).toContain('"MembershipAnnualFee_no_overlap"');
    expect(sql).toContain('"EntranceFee_no_overlap"');
    expect(sql).toContain("EXCLUDE USING gist");
  });
});
