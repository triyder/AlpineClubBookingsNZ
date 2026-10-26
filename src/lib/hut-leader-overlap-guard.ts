import { calculateOverlapDays } from "@/lib/hut-leader-overlap";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { isCustodianOccupancy } from "@/lib/custodian-occupancy";
import {
  loadHutLeaderNightCover,
  type HutLeaderNightCover,
  type HutLeaderShift,
} from "@/lib/hut-leader-night-cover";
import { HutLeaderAssignmentSource } from "@prisma/client";
import type { Prisma } from "@prisma/client";

/** The proposed row's own facts, when the caller has them (#3821). */
export type HutLeaderOverlapCandidate = {
  memberId: string;
  bedId: string | null;
  isCustodian: boolean;
  source: HutLeaderAssignmentSource;
};

/**
 * May a hut-leader assignment occupy these nights at this lodge? (#2887)
 *
 * The three writers that DECIDE this predicate — `POST /api/admin/hut-leaders`,
 * its `PUT`, and `cron-hut-leader-auto-assign` — each held their own copy of
 * the read and the >1-day comparison. Three copies of one rule is how the rule
 * drifts: `docs/CONCURRENCY_AND_LOCKING.md` states the guarantee they jointly
 * provide, and it is only true while all three agree. There is one now.
 *
 * Call it with the TRANSACTION client, after `acquireLodgeCapacityLock`. It is
 * a read, so it is only authoritative under that key — outside it the answer is
 * a guess that a concurrent insert can invalidate before the caller writes.
 *
 * `lodgeNullTolerantScope` is a STRICT per-lodge match, despite the name. The
 * name is a leftover from the expand-release phase when `lodgeId` was nullable;
 * `HutLeaderAssignment.lodgeId` is NOT NULL now (`prisma/schema.prisma`) and the
 * helper returns a plain `{ lodgeId }` — see its own comment in `lodges.ts`.
 * There are no null-lodge rows to tolerate, and if one somehow existed it would
 * be EXCLUDED from this read rather than treated as conflicting everywhere.
 * (This docblock claimed the opposite on both counts, inherited from the PUT
 * comment it was extracted from, where it was already wrong.)
 *
 * School-teacher records ARE excluded (#2926, owner decision 17 Aug 2026), and
 * the exclusion is keyed on `HutLeaderAssignment.source`, the provenance the
 * CREATING writer stamps on the row. Approving a school booking creates one
 * assignment per teacher, deliberately overlapping each other, and those rows
 * used to block a later manual or cron assignment for those nights while never
 * being blocked themselves — the school path runs no overlap read at all.
 * Only that one direction changed: whether an existing assignment blocks a
 * TEACHER is untouched, because the school path still asks nothing.
 *
 * WHY `source` AND NOT THE MEMBER. This has to be a property of the ROW, never
 * of the member's current classification, and the first attempt got that wrong
 * in a way that is worth naming so it is not repeated. It filtered on
 * `member.role != "SCHOOL"`. `Member.role` is DERIVED and admin-writable:
 * `legacyRoleFromAccessRoles` maps the ORG access role to `"SCHOOL"`, and the
 * member editor's User Type control grants ORG. So reclassifying an ordinary
 * member as an organisation made their LIVE assignment vanish from this
 * predicate, and an admin or the cron could then create a second overlapping
 * leader for those nights. Reading the ACCESS ROLE here instead fails the same
 * way and one step earlier: `accessRoleTokensForUserType("organisation")`
 * returns `["ORG"]`, dropping `USER`. `source` is written once by the insert and
 * by nothing afterwards, so no membership edit can move it.
 *
 * `Member.role = "SCHOOL"` is also the SCHOOL CONTACT member, not only a
 * teacher, which is a second reason it never identified the rows it was being
 * asked about.
 *
 * A CUSTODIAN DOES NOT BLOCK A SCHOOL NIGHT IT DOES NOT COVER (#3821). A lodge
 * may leave "the lodge custodian" unticked for school bookings (#3819), so on
 * a school group's nights a season-long custodian row is not a leader the
 * cover counts, and the officer has to add one who is. Those nights are left
 * out of the overlap between a custodian row and an ordinary one — either
 * side may be the custodian, the existing row or the proposed `candidate` —
 * only when the custodian does not cover the night AND the ordinary side does
 * (`shiftCoversNight`, the coverage reader's own answer): the exemption makes
 * room for the leader the school night needs, never for a second row that
 * does not lead it either. Two custodians are never exempted from each other,
 * so they cannot double up on uncovered school nights, and with no
 * `candidate` the proposed side is unknown and nothing is exempted. The
 * one-night allowance then applies to each run of shared nights that is left,
 * so a replacement may hand over at both ends of the school stay. Every other
 * overlap is judged exactly as before, and the cover is read only when a
 * custodian row clashes with an ordinary one.
 */
export async function findHutLeaderOverlapRefusal(
  tx: Pick<
    Prisma.TransactionClient,
    "hutLeaderAssignment" | "bookingGuest" | "booking" | "lodgeSettings"
  >,
  input: {
    lodgeId: string;
    startDate: Date;
    endDate: Date;
    /** The row being edited, excluded from its own overlap check. */
    excludeAssignmentId?: string;
    /**
     * Whether a SCHOOL_BOOKING row may be overlapped (#2926).
     *
     * DEFAULTS TO FALSE, and the default is the load-bearing part. The carve-out
     * answers "may a DELIBERATE assignment stand here?" — an officer choosing to
     * put a leader beside a school group is not to be refused. It does NOT answer
     * "should an automatic job plant one?", and conflating the two is a real
     * defect rather than a theoretical one:
     *
     *   teachers 10-14 Aug at a lodge; a sole adult member's stay is 12-20 Aug;
     *   the nightly job reaches 15 Aug, whose coverage probe finds nothing; with
     *   the carve-out applied the span read over 12-20 Aug skips the teacher rows
     *   and the job plants a CRON row across 12-20 — including the school nights
     *   it is documented never to reach. That row is MANUAL-equivalent, so it then
     *   blocks officers across the whole span too.
     *
     * So an AUTOMATIC caller omits this and keeps refusing, which is exactly the
     * behaviour that existed before the carve-out; only the two deliberate admin
     * routes opt in. Omitting it is always the safe answer, which is why the flag
     * is opt-in rather than opt-out.
     */
    allowOverlappingSchoolRows?: boolean;
    /**
     * The proposed row, so a proposed custodian is judged like an existing
     * one, and a proposed ordinary leader by whether it covers the school
     * nights it would share with a custodian. Omitted, the proposed row is an
     * ordinary one whose cover is unknown, so no night is exempted.
     */
    candidate?: HutLeaderOverlapCandidate;
  },
): Promise<{ error: string } | null> {
  const overlaps = await tx.hutLeaderAssignment.findMany({
    where: {
      ...(input.excludeAssignmentId
        ? { id: { not: input.excludeAssignmentId } }
        : {}),
      startDate: { lte: input.endDate },
      endDate: { gte: input.startDate },
      ...lodgeNullTolerantScope(input.lodgeId),
      // The teacher carve-out, keyed on the row's own provenance, and applied
      // only for a DELIBERATE caller. `source` is NOT NULL with a database
      // default, so `not` has no three-valued-logic hole: every row is either
      // SCHOOL_BOOKING or it is not.
      ...(input.allowOverlappingSchoolRows
        ? { source: { not: HutLeaderAssignmentSource.SCHOOL_BOOKING } }
        : {}),
    },
    include: { member: { select: { firstName: true, lastName: true } } },
  });

  const candidateShift: HutLeaderShift | null = input.candidate
    ? {
        id: input.excludeAssignmentId ?? "proposed",
        memberId: input.candidate.memberId,
        lodgeId: input.lodgeId,
        startDate: input.startDate,
        endDate: input.endDate,
        source: input.candidate.source,
        bedId: input.candidate.bedId,
        isCustodian: input.candidate.isCustodian,
      }
    : null;
  let cover: HutLeaderNightCover | null = null;

  for (const other of overlaps) {
    // One day of overlap is allowed, deliberately: it is the handover.
    let overlapDays = calculateOverlapDays(
      input.startDate,
      input.endDate,
      other.startDate,
      other.endDate,
    );
    const pair = custodianAndOrdinary(other, candidateShift);
    if (overlapDays > 1 && pair) {
      cover ??= await loadHutLeaderNightCover(tx, {
        scope: { kind: "lodge", lodgeId: input.lodgeId },
        from: input.startDate,
        to: input.endDate,
        memberIds: candidateShift ? [candidateShift.memberId] : [],
      });
      overlapDays = longestSharedRun(cover, input, other, pair);
    }
    if (overlapDays > 1) {
      const name = `${other.member.firstName} ${other.member.lastName}`;
      return {
        error: `Assignment overlaps with ${name}'s assignment (${formatDateOnly(other.startDate)} to ${formatDateOnly(other.endDate)}) by ${overlapDays} days. Maximum 1 day overlap is allowed for handover.`,
      };
    }
  }
  return null;
}

/**
 * The custodian and the ordinary row of a clash, or null when the clash is not
 * exactly one of each: two custodians, two ordinary rows, or an ordinary
 * existing row against a proposed row the caller did not describe.
 */
function custodianAndOrdinary(
  other: HutLeaderShift,
  candidate: HutLeaderShift | null,
): { custodian: HutLeaderShift; ordinary: HutLeaderShift } | null {
  if (!candidate) return null;
  const otherIsCustodian = isCustodianOccupancy(other);
  if (otherIsCustodian === isCustodianOccupancy(candidate)) return null;
  return otherIsCustodian
    ? { custodian: other, ordinary: candidate }
    : { custodian: candidate, ordinary: other };
}

/**
 * The longest run of nights both rows claim, leaving out each school night the
 * custodian does not cover and the ordinary row does (see the custodian note
 * above).
 */
function longestSharedRun(
  cover: HutLeaderNightCover,
  input: { lodgeId: string; startDate: Date; endDate: Date },
  other: { startDate: Date; endDate: Date },
  pair: { custodian: HutLeaderShift; ordinary: HutLeaderShift },
): number {
  const from = Math.max(input.startDate.getTime(), other.startDate.getTime());
  const to = Math.min(input.endDate.getTime(), other.endDate.getTime());
  let longest = 0;
  let run = 0;
  for (let night = new Date(from); night.getTime() <= to; night = addDaysDateOnly(night, 1)) {
    const exempt =
      cover.schoolNightKinds(input.lodgeId, night) !== null &&
      !cover.shiftCoversNight(pair.custodian, night) &&
      cover.shiftCoversNight(pair.ordinary, night);
    run = exempt ? 0 : run + 1;
    longest = Math.max(longest, run);
  }
  return longest;
}
