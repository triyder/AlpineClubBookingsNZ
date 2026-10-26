/**
 * Real-PostgreSQL proof for #4165: the audit category filters' literal action
 * prefixes and fragments select the same real rows the wildcard ones did, and refuse the
 * rows only a wildcard `_` reached.
 *
 * `actionStartsWith` (`audit-query.ts`) now writes its prefix through
 * `exactPrefix`. This seeds a null-category row (the only rows the legacy
 * action-name leg judges) for every action in the #2581 history, the
 * `xero.` family and a witness under every legacy prefix, plus decoys that
 * differ from a prefix only where it has a `_`. For every category, and for
 * a member's own timeline, it asks PostgreSQL for the rows the literal filter
 * and the old one (`unescapeLikeOperands`) select: the real rows must be the
 * same, and each decoy must leave exactly the categories the old filter gave
 * it. It then checks the shared `matchesWhere` answers every one of those
 * questions as PostgreSQL did, which is what lets the unit replay
 * (`audit-legacy-filter-exact-prefix.test.ts`) and the #2581 member-boundary
 * test stand in for the database. The `DATA_EXPORT` rows pin the same for
 * `actionContains`, whose operand Prisma also leaves unescaped (`exactContains`).
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL that `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so hosted CI reaches it, and it cleans its
 * own `race-4165` rows.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AUDIT_CATEGORIES, type AuditCategory } from "@/lib/audit-categories";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { matchesWhere } from "./support/prisma-where";
import {
  LEGACY_FILTER_PREFIX_WITNESSES,
  LEGACY_FILTER_WILDCARD_DECOYS,
  XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME,
  unescapeLikeOperands,
} from "./support/audit-legacy-filter-like";
import {
  HISTORICAL_NULL_CATEGORY_MAP_2581,
  WITHHELD_HISTORICAL_NULL_ACTIONS_2581,
} from "../../../scripts/audit/audit-writer-census-manifest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const REQUEST_ID = "race-4165";
/** The rows of the LIKE-edge case, kept out of the category population. */
const LIKE_EDGE_REQUEST_ID = "race-4165-like-edge";
const MEMBER = "race-4165-member";
/** Filed under `privacy` by `actionContains("DATA_EXPORT")` literally, old filter and new. */
const CONTAINS_LITERAL_WITNESS = "race4165.DATA_EXPORT.witness";

const REAL_ACTIONS = [
  ...new Set([
    ...Object.keys(HISTORICAL_NULL_CATEGORY_MAP_2581),
    ...Object.keys(WITHHELD_HISTORICAL_NULL_ACTIONS_2581),
    ...XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME,
    ...LEGACY_FILTER_PREFIX_WITNESSES,
  ]),
];
const DECOY_ACTIONS = LEGACY_FILTER_WILDCARD_DECOYS.map((decoy) => decoy.action);

const rowSelect = {
  id: true,
  action: true,
  category: true,
  subjectMemberId: true,
  memberId: true,
  actorMemberId: true,
  targetId: true,
  entityType: true,
  entityId: true,
} satisfies Prisma.AuditLogSelect;

type SeededRow = Prisma.AuditLogGetPayload<{ select: typeof rowSelect }>;

let prisma: PrismaClient;
let audit: typeof import("@/lib/audit-query");
let seeded: SeededRow[] = [];

async function clean(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { requestId: { in: [REQUEST_ID, LIKE_EDGE_REQUEST_ID] } } });
}

/** The seeded actions PostgreSQL selects for `where`, sorted. */
async function selected(where: Prisma.AuditLogWhereInput): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { AND: [{ requestId: REQUEST_ID }, where] },
    select: { action: true },
  });
  return rows.map((row) => row.action).sort();
}

/** The same question answered by the shared in-memory evaluator. */
function simulated(where: Prisma.AuditLogWhereInput): string[] {
  return seeded
    .filter((row) => matchesWhere(row, where as Record<string, unknown>))
    .map((row) => row.action)
    .sort();
}

function withoutDecoys(actions: string[]): string[] {
  return actions.filter((action) => !DECOY_ACTIONS.includes(action));
}

(RUN ? describe : describe.skip)(
  "the audit category filters' literal prefixes against PostgreSQL (#4165)",
  () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "Audit exact-prefix");
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      audit = await import("@/lib/audit-query");
      await clean();
      await prisma.auditLog.createMany({
        data: [...REAL_ACTIONS, ...DECOY_ACTIONS, CONTAINS_LITERAL_WITNESS].map((action) => ({
          action,
          category: null,
          subjectMemberId: MEMBER,
          requestId: REQUEST_ID,
        })),
      });
      seeded = await prisma.auditLog.findMany({ where: { requestId: REQUEST_ID }, select: rowSelect });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clean();
    });

    it("seeds the population it claims to", () => {
      expect(REAL_ACTIONS.length).toBeGreaterThan(100);
      expect(seeded).toHaveLength(REAL_ACTIONS.length + DECOY_ACTIONS.length + 1);
    });

    it("selects the same real rows for every category, and only the decoys' old categories change", async () => {
      for (const category of AUDIT_CATEGORIES) {
        const literal = audit.buildAuditCategoryWhere(category)!;
        const old = unescapeLikeOperands(literal);
        const literalRows = await selected(literal);
        const oldRows = await selected(old);
        expect(withoutDecoys(literalRows), `${category}: a real action moved`).toEqual(withoutDecoys(oldRows));
        expect(literalRows.filter((action) => DECOY_ACTIONS.includes(action)), `${category}: decoy under the literal filter`).toEqual([]);
        expect(
          oldRows.filter((action) => DECOY_ACTIONS.includes(action)),
          `${category}: the old filter's wildcard decoys`,
        ).toEqual(
          LEGACY_FILTER_WILDCARD_DECOYS.filter((decoy) => decoy.oldCategories.includes(category as AuditCategory))
            .map((decoy) => decoy.action)
            .sort(),
        );
      }
      // Named, because this is the change a reader most needs to trust.
      const xero = await selected(audit.buildAuditCategoryWhere("xero")!);
      expect(xero).toEqual(expect.arrayContaining(["xero_account_mappings_updated", ...XERO_DOT_ACTIONS_THE_CENSUS_CANNOT_NAME]));
      expect(xero).not.toContain("xeroXfoo");
      expect(await selected(unescapeLikeOperands(audit.buildAuditCategoryWhere("xero")!))).toContain("xeroXfoo");
    });

    it("shows a member the same real rows on their own timeline", async () => {
      const literal = audit.buildMemberVisibleAuditLogWhere(MEMBER);
      const literalRows = await selected(literal);
      const oldRows = await selected(unescapeLikeOperands(literal));
      expect(withoutDecoys(literalRows)).toEqual(withoutDecoys(oldRows));
      expect(literalRows).toContain("MEMBERSHIP_APPLICATION_APPROVED");
      expect(literalRows.filter((action) => DECOY_ACTIONS.includes(action))).toEqual([]);
      expect(oldRows).toContain("MEMBERSHIPXAPPLICATIONXAPPROVED");
    });

    it("is answered by the shared matchesWhere exactly as PostgreSQL answers it", async () => {
      const wheres: [string, Prisma.AuditLogWhereInput][] = [
        ...AUDIT_CATEGORIES.map((category): [string, Prisma.AuditLogWhereInput] => [category, audit.buildAuditCategoryWhere(category)!]),
        ["member timeline", audit.buildMemberVisibleAuditLogWhere(MEMBER)],
      ];
      for (const [label, literal] of wheres) {
        for (const [shape, where] of [["literal", literal], ["old", unescapeLikeOperands(literal)]] as const) {
          expect(simulated(where), `${label} (${shape})`).toEqual(await selected(where));
        }
      }
      // Prisma leaves a `contains` operand unescaped as well: the old fragment's
      // `_` takes the decoy, and the escaped one still takes the literal text.
      const privacy = audit.buildAuditCategoryWhere("privacy")!;
      expect(await selected(unescapeLikeOperands(privacy))).toContain("DATAXEXPORTfoo");
      expect(await selected(privacy)).not.toContain("DATAXEXPORTfoo");
      expect(await selected(privacy)).toContain(CONTAINS_LITERAL_WITNESS);
    });

    it("reads a trailing backslash and a non-BMP character the way the shared matchesWhere does", async () => {
      // Prisma appends `%` to the operand, so its trailing backslash escapes
      // that `%`; and PostgreSQL's `_` is one character, even outside the BMP.
      const actions = ["race4165bs.a%", "race4165bs.a%x", "race4165bs.a\\", "xrace4165bs.a%", "race4165\u{1F600}x"];
      await prisma.auditLog.createMany({
        data: actions.map((action) => ({ action, requestId: LIKE_EDGE_REQUEST_ID })),
      });
      const rows = await prisma.auditLog.findMany({ where: { requestId: LIKE_EDGE_REQUEST_ID }, select: rowSelect });
      const cases: [Prisma.AuditLogWhereInput, string[]][] = [
        [{ action: { startsWith: "race4165bs.a\\" } }, ["race4165bs.a%"]],
        [{ action: { contains: "race4165bs.a\\" } }, ["race4165bs.a%", "xrace4165bs.a%"]],
        [{ action: { startsWith: "race4165_x" } }, ["race4165\u{1F600}x"]],
        [{ action: { startsWith: "race4165__x" } }, []],
      ];
      for (const [where, expected] of cases) {
        const fromDb = (
          await prisma.auditLog.findMany({ where: { AND: [{ requestId: LIKE_EDGE_REQUEST_ID }, where] }, select: { action: true } })
        )
          .map((row) => row.action)
          .sort();
        expect(fromDb, JSON.stringify(where)).toEqual([...expected].sort());
        expect(
          rows.filter((row) => matchesWhere(row, where as Record<string, unknown>)).map((row) => row.action).sort(),
          `matchesWhere: ${JSON.stringify(where)}`,
        ).toEqual(fromDb);
      }
    });
  },
);
