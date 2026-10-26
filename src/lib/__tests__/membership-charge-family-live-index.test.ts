import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES } from "@/lib/subscription-charge-already-paid";

/**
 * #4110: at most one LIVE family charge per family, membership type and season
 * is enforced by the partial unique index MembershipCharge_family_type_year_live_key,
 * whose predicate excludes the terminal no-invoice statuses. The preview's
 * existing-family-charge filter excludes the same statuses through
 * MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES. If the two drift, either the preview
 * lets a re-bill through that the index then refuses (the whole confirm fails),
 * or the index admits a second live family charge the preview never meant to
 * mint. The database half is SQL and cannot import the constant, so this pins
 * the two together (INV-SSOT-001: one canonical definition per concept).
 *
 * The real-PostgreSQL behaviour is proved in
 * `membership-family-rebill.realdb.test.ts`; this test only keeps the predicate
 * and the constant naming the same set.
 */
const REPO_ROOT = resolve(__dirname, "../../..");
const INDEX_NAME = "MembershipCharge_family_type_year_live_key";

function statusesIn(text: string): string[] {
  return [...text.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!).sort();
}

describe("the live family-charge index excludes exactly the no-invoice statuses (#4110)", () => {
  const expected = [...MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES].sort();

  it("in the partial-index manifest CI holds the database to", () => {
    const manifest = readFileSync(join(REPO_ROOT, "prisma/partial-unique-indexes.tsv"), "utf8");
    const rows = manifest.split("\n").filter((line) => line.split("\t")[1] === INDEX_NAME);
    expect(rows, `${INDEX_NAME} must be registered once in prisma/partial-unique-indexes.tsv (INV-SSOT-001)`).toHaveLength(1);
    const [, , indexdef] = rows[0]!.split("\t");
    expect(indexdef).toContain('("seasonYear", "membershipTypeId", "familyGroupId")');
    const predicate = indexdef!.slice(indexdef!.indexOf(" WHERE "));
    expect(
      statusesIn(predicate),
      "The index predicate and MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES must name the same statuses (INV-SSOT-001, #4110)",
    ).toEqual(expected);
  });

  it("in the migration that creates it", () => {
    const migrationsDir = join(REPO_ROOT, "prisma/migrations");
    const creating = readdirSync(migrationsDir)
      .map((name) => join(migrationsDir, name, "migration.sql"))
      .filter((path) => {
        try {
          return readFileSync(path, "utf8").includes(`CREATE UNIQUE INDEX "${INDEX_NAME}"`);
        } catch {
          return false;
        }
      });
    expect(creating, `exactly one migration creates ${INDEX_NAME}`).toHaveLength(1);
    const statement = readFileSync(creating[0]!, "utf8")
      .split("\n")
      .find((line) => line.startsWith(`CREATE UNIQUE INDEX "${INDEX_NAME}"`))!;
    expect(
      statusesIn(statement.slice(statement.indexOf(" WHERE "))),
      "The migration's predicate and MEMBERSHIP_CHARGE_NO_INVOICE_STATUSES must name the same statuses (INV-SSOT-001, #4110)",
    ).toEqual(expected);
  });
});
