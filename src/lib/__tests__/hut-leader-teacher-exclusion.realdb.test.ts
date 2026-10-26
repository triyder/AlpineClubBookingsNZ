/**
 * Real-PostgreSQL proof that the hut-leader overlap predicate's school-teacher
 * carve-out is keyed on the ROW and not on the member (#2926).
 *
 * WHY THIS SUITE EXISTS AT ALL, when a mocked `findMany` can already assert the
 * shape of the `where`. The defect this issue was split out for was not a wrong
 * `where` — it was a `where` that read correctly and whose meaning MOVED when
 * somebody edited a member. A shape assertion cannot see that: it pins the
 * query, and the query was never the thing that changed. Only executing the
 * predicate against real rows, on either side of the real membership edit, shows
 * that the same live assignment is still found afterwards.
 *
 * The first attempt filtered on `member.role != "SCHOOL"`. `Member.role` is
 * derived from the access roles (`legacyRoleFromAccessRoles` maps `ORG` ->
 * `SCHOOL`) and the member editor's User Type control writes them, so
 * reclassifying an ordinary member as an organisation removed their LIVE
 * assignment from the predicate for every writer. `THE RECLASSIFICATION CASE`
 * below is that exact sequence, and it fails against that filter.
 *
 * Ordinary Vitest runs skip this. The explicit concurrency job imports the file
 * from `concurrency-lock-races.realdb.test.ts` after migrating a disposable,
 * loopback-only database, which is the same guarded harness (#1881) every other
 * `*.realdb.test.ts` uses — so no workflow change is needed to run it, and it
 * can never touch a database that is not the throwaway one.
 */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const TIMEOUT_MS = 30_000;

const LODGE_ID = "hl-2926-lodge";
const OTHER_LODGE_ID = "hl-2926-other-lodge";
const LEADER_ID = "hl-2926-leader";
const TEACHER_ID = "hl-2926-teacher";
const LOOKALIKE_ID = "hl-2926-lookalike";
const LEADER_ASSIGNMENT_ID = "hl-2926-assignment-leader";
const TEACHER_ASSIGNMENT_ID = "hl-2926-assignment-teacher";
const LOOKALIKE_ASSIGNMENT_ID = "hl-2926-assignment-lookalike";

/**
 * Far-future dates, so nothing here depends on the frozen test clock or on any
 * other fixture in the shared disposable database.
 */
const STAY_START = new Date("2099-04-10T00:00:00.000Z");
const STAY_END = new Date("2099-04-20T00:00:00.000Z");
/** Overlaps the stay above by nine days, which is well past the one-day handover. */
const CLASHING_WINDOW = {
  lodgeId: LODGE_ID,
  startDate: new Date("2099-04-11T00:00:00.000Z"),
  endDate: new Date("2099-04-21T00:00:00.000Z"),
};

let prisma: PrismaClient;
let findHutLeaderOverlapRefusal: typeof import("@/lib/hut-leader-overlap-guard")["findHutLeaderOverlapRefusal"];

function assertSafeUrl(value: string): void {
  const parsed = new URL(value);
  const port = Number.parseInt(parsed.port, 10);
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname.toLowerCase()) ||
    !Number.isFinite(port) ||
    port < 55442 ||
    !name.includes("concurrency_race_1881")
  ) {
    throw new Error(
      "The hut-leader teacher-exclusion proofs require the guarded disposable concurrency database.",
    );
  }
}

async function clearFixtures(): Promise<void> {
  await prisma.hutLeaderAssignment.deleteMany({
    where: {
      id: {
        in: [LEADER_ASSIGNMENT_ID, TEACHER_ASSIGNMENT_ID, LOOKALIKE_ASSIGNMENT_ID],
      },
    },
  });
  await prisma.memberAccessRole.deleteMany({
    where: { memberId: { in: [LEADER_ID, TEACHER_ID, LOOKALIKE_ID] } },
  });
  await prisma.member.deleteMany({
    where: { id: { in: [LEADER_ID, TEACHER_ID, LOOKALIKE_ID] } },
  });
  await prisma.lodge.deleteMany({ where: { id: { in: [LODGE_ID, OTHER_LODGE_ID] } } });
}

(RUN ? describe : describe.skip)(
  "hut-leader overlap: the teacher carve-out is a property of the row (#2926)",
  { timeout: TIMEOUT_MS },
  () => {
    beforeAll(async () => {
      assertSafeUrl(RACE_DB_URL);
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = (await import("@/lib/prisma")) as unknown as { prisma: PrismaClient });
      ({ findHutLeaderOverlapRefusal } = await import("@/lib/hut-leader-overlap-guard"));
    });

    beforeEach(async () => {
      await clearFixtures();
      await prisma.lodge.createMany({
        data: [
          { id: LODGE_ID, name: "Teacher carve-out lodge", slug: "hl-2926" },
          { id: OTHER_LODGE_ID, name: "Teacher carve-out other lodge", slug: "hl-2926-other" },
        ],
      });

      // An ordinary club member, exactly as the admin POST requires one: active,
      // able to log in, holding the USER access role.
      await prisma.member.create({
        data: {
          id: LEADER_ID,
          email: "hl-2926-leader@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Ordinary",
          lastName: "Leader",
          role: "USER",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          accessRoles: { create: [{ role: "USER" }] },
        },
      });

      // A school teacher, in the shape `school-booking-request.ts` creates one.
      await prisma.member.create({
        data: {
          id: TEACHER_ID,
          email: "hl-2926-teacher@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "School",
          lastName: "Teacher",
          role: "SCHOOL",
          ageTier: "ADULT",
          active: true,
          canLogin: false,
        },
      });

      // A member who LOOKS like a teacher by every member-side test — same role,
      // same login state — but whose assignment was not created by the school
      // path. This is the row a member-derived discriminator wrongly excludes.
      await prisma.member.create({
        data: {
          id: LOOKALIKE_ID,
          email: "hl-2926-lookalike@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "School",
          lastName: "Contact",
          role: "SCHOOL",
          ageTier: "ADULT",
          active: true,
          canLogin: false,
        },
      });
    });

    afterAll(async () => {
      if (!prisma) return;
      await clearFixtures();
    });

    it("refuses a clash with an ordinary manual assignment", async () => {
      await prisma.hutLeaderAssignment.create({
        data: {
          id: LEADER_ASSIGNMENT_ID,
          memberId: LEADER_ID,
          lodgeId: LODGE_ID,
          startDate: STAY_START,
          endDate: STAY_END,
          source: "MANUAL",
        },
      });

      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
        }),
      ).resolves.toMatchObject({ error: expect.stringContaining("Ordinary Leader") });
    });

    it(
      "THE RECLASSIFICATION CASE: reclassifying the leader as an organisation " +
        "does not remove their live assignment from the predicate",
      async () => {
        await prisma.hutLeaderAssignment.create({
          data: {
            id: LEADER_ASSIGNMENT_ID,
            memberId: LEADER_ID,
            lodgeId: LODGE_ID,
            startDate: STAY_START,
            endDate: STAY_END,
            source: "MANUAL",
          },
        });

        const before = await findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
        });
        expect(before).toMatchObject({ error: expect.stringContaining("Ordinary Leader") });

        // The membership edit, written the way the member editor writes it:
        // picking User Type = "organisation" resolves to the token set
        // `["ORG"]` (accessRoleTokensForUserType), which DROPS `USER`, and the
        // stored legacy column follows via `legacyRoleFromAccessRoles`, which
        // maps ORG -> SCHOOL. Nothing about the roster is touched.
        await prisma.$transaction(async (tx) => {
          await tx.memberAccessRole.deleteMany({ where: { memberId: LEADER_ID } });
          await tx.memberAccessRole.create({
            data: { memberId: LEADER_ID, role: "ORG" },
          });
          await tx.member.update({
            where: { id: LEADER_ID },
            data: { role: "SCHOOL" },
          });
        });

        const after = await findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
        });
        expect(
          after,
          "a membership edit removed a live hut-leader assignment from the overlap predicate",
        ).toMatchObject({ error: expect.stringContaining("Ordinary Leader") });

        // And the row itself did not move: `source` is written by the create and
        // by nothing else, which is the whole reason the edit above is inert.
        const row = await prisma.hutLeaderAssignment.findUniqueOrThrow({
          where: { id: LEADER_ASSIGNMENT_ID },
          select: { source: true },
        });
        expect(row.source).toBe("MANUAL");
      },
    );

    it("does not refuse a clash with a school-created teacher assignment", async () => {
      await prisma.hutLeaderAssignment.create({
        data: {
          id: TEACHER_ASSIGNMENT_ID,
          memberId: TEACHER_ID,
          lodgeId: LODGE_ID,
          startDate: STAY_START,
          endDate: STAY_END,
          source: "SCHOOL_BOOKING",
        },
      });

      await expect(findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
        })).resolves.toBeNull();
    });

    it("still refuses when a teacher-SHAPED member holds a manual assignment", async () => {
      // Identical member-side facts to the teacher above — `role = "SCHOOL"`,
      // `canLogin = false` — and a row the school path did not create. A
      // member-derived discriminator excludes this and it must not: the row is
      // somebody's real assignment.
      await prisma.hutLeaderAssignment.create({
        data: {
          id: LOOKALIKE_ASSIGNMENT_ID,
          memberId: LOOKALIKE_ID,
          lodgeId: LODGE_ID,
          startDate: STAY_START,
          endDate: STAY_END,
          source: "MANUAL",
        },
      });

      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
        }),
      ).resolves.toMatchObject({ error: expect.stringContaining("School Contact") });
    });

    it("reads the cover on a real database when a custodian is in the clash (#3821)", async () => {
      // A custodian clash loads `hut-leader-night-cover.ts` on the client it
      // was given: the school-booking read (capacity-holding AND school), the
      // stay read (`hutLeaderStayBookingWhere`, its OR of an operational stay
      // and an accepted, CONFIRMED school booking) and the lodge's school kinds. A mocked client
      // accepts any where; PostgreSQL through Prisma proves these shapes are
      // valid. With no school group there, the clash is refused as before.
      await prisma.hutLeaderAssignment.create({
        data: {
          id: LEADER_ASSIGNMENT_ID,
          memberId: LEADER_ID,
          lodgeId: LODGE_ID,
          startDate: STAY_START,
          endDate: STAY_END,
          source: "MANUAL",
          isCustodian: true,
        },
      });

      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          allowOverlappingSchoolRows: true,
          candidate: { memberId: LOOKALIKE_ID, bedId: null, isCustodian: true, source: "MANUAL" },
        }),
      ).resolves.toMatchObject({ error: expect.stringContaining("Ordinary Leader") });

      // The same stay set read by the manual stay check and the coverage
      // reader's "needs a leader" query, on the real schema.
      const { loadHutLeaderStayedNightKeys } = await import("@/lib/hut-leader-stayed-nights");
      await expect(
        loadHutLeaderStayedNightKeys(prisma, {
          memberId: LEADER_ID,
          lodgeId: LODGE_ID,
          rangeStart: STAY_START,
          rangeEnd: STAY_END,
        }),
      ).resolves.toEqual([]);
      const { getUnassignedHutLeaderDates } = await import("@/lib/hut-leader-coverage");
      await expect(
        getUnassignedHutLeaderDates({
          db: prisma as never,
          scope: { kind: "lodge", lodgeId: LODGE_ID },
          from: STAY_START,
          to: STAY_END,
        }),
      ).resolves.toEqual([]);
    });

    it("keeps every other guarantee: lodge scope, the one-day handover, and exclude-self", async () => {
      await prisma.hutLeaderAssignment.create({
        data: {
          id: LEADER_ASSIGNMENT_ID,
          memberId: LEADER_ID,
          lodgeId: LODGE_ID,
          startDate: STAY_START,
          endDate: STAY_END,
          source: "MANUAL",
        },
      });

      // Another lodge is not a conflict.
      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          lodgeId: OTHER_LODGE_ID,
          allowOverlappingSchoolRows: true,
        }),
      ).resolves.toBeNull();

      // One day of overlap is the handover, and is still allowed.
      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          lodgeId: LODGE_ID,
          startDate: STAY_END,
          endDate: new Date("2099-04-25T00:00:00.000Z"),
          allowOverlappingSchoolRows: true,
        }),
      ).resolves.toBeNull();

      // The row being edited is still excluded from its own check.
      await expect(
        findHutLeaderOverlapRefusal(prisma, {
          ...CLASHING_WINDOW,
          excludeAssignmentId: LEADER_ASSIGNMENT_ID,
          allowOverlappingSchoolRows: true,
        }),
      ).resolves.toBeNull();
    });
  },
);
