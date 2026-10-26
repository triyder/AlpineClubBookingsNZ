import { describe, expect, it, vi } from "vitest";

import { findHutLeaderOverlapRefusal } from "@/lib/hut-leader-overlap-guard";

/**
 * The one hut-leader overlap predicate, and the SCHOOL carve-out (#2887, #2926).
 *
 * Consolidating four hand-copied versions of this rule into one predicate is
 * what this file guards: the >1-day comparison, the lodge scope and the
 * exclude-self behaviour now have a single home, so they cannot drift between
 * the POST, the PUT and the cron.
 *
 * School-teacher rows ARE excluded now (#2926), on the row's own
 * `source` provenance. Behaviour on real rows — including the reclassification
 * case, which is the whole reason the first attempt was reverted — is proved
 * against a real PostgreSQL in `hut-leader-teacher-exclusion.realdb.test.ts`.
 * What THIS file can prove is the shape of the query, and that is worth pinning
 * separately: the failure mode being guarded against is a filter that reads
 * correctly and whose meaning an admin can move.
 */
function tx(rows: Array<Record<string, unknown>>) {
  const findMany = vi.fn(async () => rows);
  return {
    client: { hutLeaderAssignment: { findMany } } as unknown as Parameters<
      typeof findHutLeaderOverlapRefusal
    >[0],
    findMany,
  };
}

const WINDOW = {
  lodgeId: "lodge-1",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-05T00:00:00.000Z"),
};

const CLASHING_ROW = {
  id: "other",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  endDate: new Date("2026-07-05T00:00:00.000Z"),
  member: { firstName: "Ada", lastName: "Lovelace" },
};

describe("findHutLeaderOverlapRefusal (#2887)", () => {
  it("refuses a clash with an ordinary assignment", async () => {
    const { client } = tx([CLASHING_ROW]);
    await expect(findHutLeaderOverlapRefusal(client, WINDOW)).resolves.toMatchObject({
      error: expect.stringContaining("Ada Lovelace"),
    });
  });

  it("excludes school-created rows on the ROW's provenance, never on the member (#2926)", async () => {
    /*
      This is the tripwire, and it is deliberately kept rather than relaxed.

      It used to assert the predicate had NO member-side filter at all, because
      school-teacher rows still blocked. #2926 changed WHICH rows are covered —
      the ones the school-approval path CREATED — and did not change what the
      predicate is allowed to ask about. The half that matters is unchanged and
      is still asserted below: the query names no member, no role and no access
      role. A filter derived from the member is exactly what was shipped and
      reverted once, and nothing else in this file would notice it coming back.

      WHICH ROWS THIS COVERS, stated because the previous version of this test
      demanded it be stated: rows whose `source` is `SCHOOL_BOOKING`, i.e. the
      one-per-teacher assignments `school-booking-request.ts` creates when a
      school request is approved. NOT "rows belonging to a member whose role is
      SCHOOL" — that set also contains the school CONTACT member, and it moves
      whenever an admin edits a member.
    */
    const { client, findMany } = tx([]);
    // The carve-out is opt-in, so a DELIBERATE caller has to ask for it. The
    // companion test below pins what an automatic caller gets instead.
    await findHutLeaderOverlapRefusal(client, {
      ...WINDOW,
      allowOverlappingSchoolRows: true,
    });
    const where = (
      findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;

    expect(Object.keys(where).sort()).toEqual([
      "endDate",
      "lodgeId",
      "source",
      "startDate",
    ]);
    expect(where.source).toEqual({ not: "SCHOOL_BOOKING" });

    // The carve-out is a property of the row. Nothing about the member may
    // appear anywhere in this query, at any depth: `Member.role` is derived
    // from the access roles and both are admin-writable, so any of these names
    // in the predicate means a membership edit can move a live assignment out
    // of the overlap check.
    expect(where).not.toHaveProperty("member");
    const serialised = JSON.stringify(where);
    for (const forbidden of ["member", "role", "accessRoles", "canLogin"]) {
      expect(
        serialised,
        `the overlap predicate derives the teacher carve-out from "${forbidden}", which an admin can edit`,
      ).not.toContain(forbidden);
    }
  });

  it("still scopes to the lodge and still allows a one-day handover", async () => {
    const { client, findMany } = tx([
      {
        id: "handover",
        // Ends the day this one starts: exactly one day, which is the handover
        // the rule exists to permit.
        startDate: new Date("2026-06-28T00:00:00.000Z"),
        endDate: new Date("2026-07-01T00:00:00.000Z"),
        member: { firstName: "Grace", lastName: "Hopper" },
      },
    ]);
    await expect(findHutLeaderOverlapRefusal(client, WINDOW)).resolves.toBeNull();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lodgeId: expect.anything() }),
      }),
    );
  });

  it("does NOT carve out school rows for an automatic caller (#2926 cron defect)", async () => {
    /*
      The mirror of the test above, and the reason the flag is opt-in.

      The carve-out answers "may a DELIBERATE assignment stand here?" — an
      officer putting a leader beside a school group is not to be refused. It
      does not answer "should an automatic job plant one?", and applying it to
      the nightly job was a reachable defect:

        teachers 10-14 Aug at a lodge; a sole adult member's stay 12-20 Aug; the
        job reaches 15 Aug, whose coverage probe finds nothing; with the carve-out
        applied the span read over 12-20 Aug skipped the teacher rows and the job
        planted a CRON row across 12-20 — including the school nights it is
        documented never to reach. Being MANUAL-equivalent, that row then blocked
        officers across the whole span.

      So omitting the flag must leave NO source filter, which restores exactly
      the pre-carve-out refusal for the job. Asserted on the query rather than on
      an outcome, because the whole point is that the automatic caller asks a
      different question from the deliberate one.
    */
    const { client, findMany } = tx([]);
    await findHutLeaderOverlapRefusal(client, WINDOW);
    const where = (
      findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;

    expect(where).not.toHaveProperty("source");
    expect(Object.keys(where).sort()).toEqual([
      "endDate",
      "lodgeId",
      "startDate",
    ]);
  });

  it("refuses a span that overlaps a teacher row by more than a day when not opted in", async () => {
    // The behavioural half: the query shape above must actually produce a
    // refusal, or the guard could ask the right question and ignore the answer.
    const { client } = tx([
      {
        id: "school-row",
        startDate: new Date("2026-06-20T00:00:00.000Z"),
        endDate: new Date("2026-07-05T00:00:00.000Z"),
        source: "SCHOOL_BOOKING",
        member: { firstName: "Ada", lastName: "Teacher" },
      },
    ]);

    await expect(
      findHutLeaderOverlapRefusal(client, WINDOW),
    ).resolves.toMatchObject({ error: expect.stringContaining("overlaps") });
  });

  it("excludes the row being edited when asked to", async () => {
    const { client, findMany } = tx([]);
    await findHutLeaderOverlapRefusal(client, {
      ...WINDOW,
      excludeAssignmentId: "a1",
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "a1" } }),
      }),
    );
  });
});

describe("a custodian does not block a school night it does not cover (#3821)", () => {
  // The custodian lives on site all season; a school group holds nights
  // 10–12 Aug. The lodge leaves "the lodge custodian" unticked for school
  // bookings, so on those nights the officer must add a leader the cover counts.
  // Rewi is a member on the school booking, which the lodge accepts.
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const CUSTODIAN = {
    id: "cust",
    memberId: "m-cust",
    lodgeId: "lodge-1",
    startDate: d("2026-07-01"),
    endDate: d("2026-09-30"),
    source: "MANUAL",
    bedId: null,
    isCustodian: true,
    member: { firstName: "Cara", lastName: "Custodian" },
  };
  const SCHOOL = { id: "school", lodgeId: "lodge-1", checkIn: d("2026-08-10"), checkOut: d("2026-08-13") };
  const REWI_ON_SCHOOL = {
    memberId: "m-rep",
    stayStart: SCHOOL.checkIn,
    stayEnd: SCHOOL.checkOut,
    nights: [],
    booking: SCHOOL,
  };
  const REWI = { memberId: "m-rep", bedId: null, isCustodian: false, source: "MANUAL" as const };

  function db(
    rows: Array<Record<string, unknown>>,
    custodianTicked: boolean,
    stays: Array<Record<string, unknown>> = [REWI_ON_SCHOOL],
  ) {
    return {
      hutLeaderAssignment: { findMany: vi.fn(async () => rows) },
      booking: { findMany: vi.fn(async () => [SCHOOL]) },
      bookingGuest: { findMany: vi.fn(async () => stays) },
      lodgeSettings: {
        findUnique: vi.fn(async () => ({
          capacity: null,
          schoolHutLeaderTeacherOnBooking: false,
          schoolHutLeaderCustodian: custodianTicked,
          schoolHutLeaderMemberOnBooking: true,
          schoolHutLeaderMemberStayingSeparately: true,
        })),
      },
    } as unknown as Parameters<typeof findHutLeaderOverlapRefusal>[0];
  }
  const ask = (client: Parameters<typeof findHutLeaderOverlapRefusal>[0], start: string, end: string, extra = {}) =>
    findHutLeaderOverlapRefusal(client, { lodgeId: "lodge-1", startDate: d(start), endDate: d(end), ...extra });

  it("lets a replacement who covers them take exactly the school nights", async () => {
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-10", "2026-08-12", { candidate: REWI }),
    ).resolves.toBeNull();
  });

  it("allows a one-night handover at each end of the school stay", async () => {
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-09", "2026-08-13", { candidate: REWI }),
    ).resolves.toBeNull();
  });

  it("still refuses two shared ordinary nights, which the custodian does cover", async () => {
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-08", "2026-08-12", { candidate: REWI }),
    ).resolves.toMatchObject({ error: expect.stringContaining("by 2 days") });
  });

  it("still refuses the school nights when the lodge ticks the custodian", async () => {
    await expect(
      ask(db([CUSTODIAN], true), "2026-08-10", "2026-08-12", { candidate: REWI }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Cara Custodian") });
  });

  it("refuses a replacement who does not cover the school nights either", async () => {
    // Not staying, so not present: the exemption makes room only for a leader
    // the night needs.
    await expect(
      ask(db([CUSTODIAN], false, []), "2026-08-10", "2026-08-12", { candidate: REWI }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Cara Custodian") });
  });

  it("exempts nothing when the caller does not describe the proposed row", async () => {
    await expect(ask(db([CUSTODIAN], false), "2026-08-10", "2026-08-12")).resolves.toMatchObject({
      error: expect.stringContaining("Cara Custodian"),
    });
  });

  it("never lets two custodians overlap on uncovered school nights", async () => {
    // Neither covers the school nights, so neither is the leader they need.
    const second = { memberId: "m-cust2", bedId: null, isCustodian: true, source: "MANUAL" as const };
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-10", "2026-08-12", { candidate: second }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Cara Custodian") });
    // Not even when the second custodian also stays on the school booking and
    // so covers those nights: two custodians are never exempted from each
    // other, so two season-long rows cannot both stand there.
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-10", "2026-08-12", {
        candidate: { ...REWI, isCustodian: true },
      }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Cara Custodian") });
    // A bed holder is a custodian too.
    const bedHolder = { memberId: "m-bed", bedId: "bed-1", isCustodian: false, source: "MANUAL" as const };
    await expect(
      ask(db([CUSTODIAN], false), "2026-08-10", "2026-08-12", { candidate: bedHolder }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Cara Custodian") });
  });

  it("judges a PROPOSED custodian the same way, against an existing replacement", async () => {
    const replacement = {
      ...CUSTODIAN,
      id: "rep",
      memberId: "m-rep",
      isCustodian: false,
      startDate: d("2026-08-10"),
      endDate: d("2026-08-12"),
      member: { firstName: "Rewi", lastName: "Replacement" },
    };
    const candidate = { memberId: "m-cust", bedId: null, isCustodian: true, source: "MANUAL" as const };
    await expect(
      ask(db([replacement], false), "2026-07-01", "2026-09-30", { candidate }),
    ).resolves.toBeNull();
    await expect(
      ask(db([replacement], true), "2026-07-01", "2026-09-30", { candidate }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Rewi Replacement") });
    // An existing "replacement" who is not staying covers nothing, so the
    // proposed custodian is refused.
    await expect(
      ask(db([replacement], false, []), "2026-07-01", "2026-09-30", { candidate }),
    ).resolves.toMatchObject({ error: expect.stringContaining("Rewi Replacement") });
  });

  it("reads no cover when no custodian is in the clash", async () => {
    const client = db([{ ...CUSTODIAN, isCustodian: false }], false);
    await expect(ask(client, "2026-08-10", "2026-08-12", { candidate: REWI })).resolves.not.toBeNull();
    expect((client as unknown as { booking: { findMany: ReturnType<typeof vi.fn> } }).booking.findMany).not.toHaveBeenCalled();
  });
});
