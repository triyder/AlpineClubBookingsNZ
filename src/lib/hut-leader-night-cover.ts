import { HutLeaderAssignmentSource, type Prisma } from "@prisma/client";
import {
  isGuestActiveOnNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import { isCustodianOccupancy } from "@/lib/custodian-occupancy";
import {
  hutLeaderStayBookingWhere,
  schoolBookingHoldingBedsWhere,
} from "@/lib/hut-leader-stayed-nights";
import {
  loadSchoolHutLeaderKinds,
  type LodgeSettingsReader,
} from "@/lib/lodge-settings";
import {
  DEFAULT_SCHOOL_HUT_LEADER_KINDS,
  type SchoolHutLeaderKind,
  type SchoolHutLeaderKinds,
} from "@/lib/school-hut-leader-kinds";
import { memberName } from "@/lib/member-serialization";
import {
  deriveHutLeaderDayHalves,
  type HutLeaderOnNight,
} from "@/lib/hut-leader-handover";
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
} from "@/lib/club-time";

/**
 * IS LODGE NIGHT D COVERED BY A HUT LEADER? — the one answer (#3818, `INV-DATE-031`).
 *
 * A night is covered when an assignment's nights include D **and** the person
 * on it is in the lodge that night. An assignment row alone used to be enough,
 * which is how a leader who left on Wednesday morning still "covered" Wednesday
 * night: the auto-assign cron (and many manual rows) stamped `endDate` as the
 * checkout day, and every reader took the row's dates at their word (#3789).
 * Presence settles it without touching the rows, so those rows heal themselves
 * and there is no backfill.
 *
 * Presence is decided per row, by what the row is:
 *
 *  - **A custodian occupancy** — an assignment holding a bed, ticked
 *    "Custodian (lives on site)", or both ({@link isCustodianOccupancy},
 *    #3817) — is present on every night it covers, inclusive, whether bed
 *    allocation is on or off. A held bed IS its occupancy (`INV-LIFE-062`) and
 *    the tick says the member lives on site (owner decision on #3820, 3 Oct
 *    2026); a custodian has no `BookingGuest`, so asking for a stay would
 *    discard every custodian.
 *  - **A school-booking teacher row** (`source = SCHOOL_BOOKING`) is present on
 *    a night its dates claim only while a school booking is staying at its
 *    lodge that night (#3819). See {@link isSchoolRowPresentOnNight}.
 *  - **Every other row** — a role-only assignment, not ticked, with no bed —
 *    needs its member on an operational stay at the SAME lodge that night: a
 *    `BookingGuest` row for that member (owning a booking one is not a guest on
 *    does not count), on a booking matching THE hut-leader stay definition
 *    `hutLeaderStayBookingWhere` (#3817: non-deleted, an operational-stay
 *    status or an accepted school booking awaiting its invoice — the same
 *    set that decides a night needs a leader at all — the one rule the
 *    writers and suggestions read too), operationally consented, and active
 *    on the
 *    night by `isGuestActiveOnNight` — the frozen night-model predicate, reused,
 *    never restated (`INV-DATE-003`/`INV-DATE-005`). A cancelled, bumped or
 *    archived stay is simply not loaded, so it covers nothing.
 *
 * **On a school booking's nights the lodge decides who may lead (#3819).** A
 * night on which a school booking (`schoolBookingHoldingBedsWhere`) is
 * staying at the lodge is covered only by a present leader of a kind that
 * lodge ticks in "Who can be hut leader for school bookings"
 * (`loadSchoolHutLeaderKinds`): a teacher on the booking, the lodge custodian,
 * a member on the school booking staying that night, or a member staying
 * separately that night. Any other night keeps the rule above. See
 * {@link schoolHutLeaderKindsOfShift}.
 *
 * Every coverage reader goes through this module — the dashboard card, the
 * sidebar badge, the stuck-state tile, the hut-leaders calendar, the
 * eligible-members suggestions and the auto-assign cron's already-covered probe.
 * `hut-leader-night-cover-census.test.ts` fails a reader that reads assignment
 * dates as coverage on its own.
 */

/** One assignment row, as the coverage question needs it. */
export type HutLeaderShift = {
  id: string;
  memberId: string;
  lodgeId: string | null;
  startDate: Date;
  endDate: Date;
  source: HutLeaderAssignmentSource | `${HutLeaderAssignmentSource}`;
  bedId: string | null;
  /** The "Custodian (lives on site)" tick (#3817). */
  isCustodian: boolean;
  member?: { firstName: string | null; lastName: string | null } | null;
  lodge?: { name: string; active?: boolean } | null;
};

/** One member's stay segment, as presence needs it. */
export type HutLeaderStay = GuestStayRange & {
  memberId: string | null;
  booking: { id: string; lodgeId: string | null; checkIn: Date; checkOut: Date };
};

/** A school booking staying at a lodge, as the school kinds rule needs it. */
export type HutLeaderSchoolBooking = {
  id: string;
  lodgeId: string | null;
  checkIn: Date;
  checkOut: Date;
};

/**
 * The school bookings and each of their lodges' ticked kinds (#3819). Omitted,
 * there are no school bookings, so no night is a school night.
 */
export type HutLeaderSchoolNights = {
  bookings: readonly HutLeaderSchoolBooking[];
  /** Keyed by lodge id; a lodge missing here reads the defaults. */
  kindsByLodge: ReadonlyMap<string, SchoolHutLeaderKinds>;
};


export type HutLeaderNightCoverScope =
  | { kind: "lodge"; lodgeId: string }
  | { kind: "all" };

export type HutLeaderNightCoverDb = LodgeSettingsReader & {
  hutLeaderAssignment: {
    findMany(args: unknown): Promise<HutLeaderShift[]>;
  };
  bookingGuest: {
    findMany(args: unknown): Promise<HutLeaderStay[]>;
  };
  // Typed loosely so a caller's own wider booking read (the coverage reader's)
  // can share one client type; the loader selects, and reads, the school shape.
  booking: {
    findMany(args: unknown): Promise<unknown[]>;
  };
};

/**
 * What the loader accepts: the Prisma client, a transaction client, or a test
 * double speaking the two reads. The select shape is this module's own, so the
 * narrowing cast inside the loader is to the rows it asked for.
 */
export type HutLeaderNightCoverReader =
  | HutLeaderNightCoverDb
  | Pick<
      Prisma.TransactionClient,
      "hutLeaderAssignment" | "bookingGuest" | "booking" | "lodgeSettings"
    >;

export type HutLeaderNightCover = {
  /** The assignments that validly cover `night` at `lodgeId`, in load order. */
  coveringShifts(lodgeId: string | null, night: Date): HutLeaderShift[];
  /**
   * Whether this one row validly covers `night` at its own lodge — the same
   * answer {@link coveringShifts} gives for a loaded row, for a row the caller
   * holds (the overlap guard's existing or proposed custodian). Its member's
   * stays must have been loaded (`memberIds` on the loader).
   */
  shiftCoversNight(shift: HutLeaderShift, night: Date): boolean;
  /** Whether any assignment validly covers `night` at `lodgeId`. */
  isCovered(lodgeId: string | null, night: Date): boolean;
  /**
   * On a night a school booking stays at `lodgeId`, that lodge's ticked
   * school hut-leader kinds; null on any other night (#3819).
   */
  schoolNightKinds(lodgeId: string | null, night: Date): SchoolHutLeaderKinds | null;
  /** Whether a loaded booking is a school group's (#3819). */
  isSchoolBooking(bookingId: string): boolean;
  /** Every assignment loaded, valid or not, for callers that name lodges. */
  readonly shifts: readonly HutLeaderShift[];
};

/** Does the row's own date span claim `night`? Inclusive both ends. */
function shiftClaimsNight(shift: HutLeaderShift, night: Date): boolean {
  const time = night.getTime();
  return shift.startDate.getTime() <= time && time <= shift.endDate.getTime();
}

/**
 * A school-booking teacher row's presence (#3819): a night its own dates claim,
 * while a school booking is staying at its lodge that night.
 *
 * The school writer stamps the row with the booking's first and last nights
 * (`request.checkIn` .. `request.checkOut − 1`, `school-booking-request.ts`),
 * but the row carries no booking key and its teacher is not a `BookingGuest`,
 * so presence cannot be read the way a member's is. Asking for the school's
 * stay instead of trusting the row's span does three things at once: a row
 * written before #3819 with the checkout day as its last night stops covering
 * the night after the school left (no backfill), and a school booking that is
 * cancelled or moved off those nights stops its teacher rows covering them.
 * The stated limit: the row is matched to A school booking at its lodge, not
 * to its own, so two school groups at one lodge on one night share teachers.
 */
function isSchoolRowPresentOnNight(
  shift: HutLeaderShift,
  night: Date,
  schoolBookingsOnNight: (lodgeId: string | null, night: Date) => readonly HutLeaderSchoolBooking[],
): boolean {
  return schoolBookingsOnNight(shift.lodgeId, night).length > 0;
}

/** A member's stays at the shift's lodge that are active on `night`. */
function activeStaysOnNight(
  shift: HutLeaderShift,
  night: Date,
  staysByMember: ReadonlyMap<string, readonly HutLeaderStay[]>,
): HutLeaderStay[] {
  return (staysByMember.get(shift.memberId) ?? []).filter(
    (stay) =>
      stay.booking.lodgeId === shift.lodgeId &&
      isGuestActiveOnNight(stay, night, stay.booking),
  );
}

/**
 * Which of the four school kinds this present leader is on `night` (#3819). A
 * leader can be more than one — a custodian who also books a stay is both the
 * custodian and a member staying separately — and counts if ANY is ticked.
 */
function schoolHutLeaderKindsOfShift(
  shift: HutLeaderShift,
  night: Date,
  staysByMember: ReadonlyMap<string, readonly HutLeaderStay[]>,
  schoolBookingIds: ReadonlySet<string>,
): SchoolHutLeaderKind[] {
  const kinds: SchoolHutLeaderKind[] = [];
  if (isCustodianOccupancy(shift)) kinds.push("custodian");
  if (shift.source === HutLeaderAssignmentSource.SCHOOL_BOOKING) {
    kinds.push("teacherOnBooking");
  }
  for (const stay of activeStaysOnNight(shift, night, staysByMember)) {
    kinds.push(
      schoolBookingIds.has(stay.booking.id) ? "memberOnBooking" : "memberStayingSeparately",
    );
  }
  return kinds;
}

/**
 * Does this row's member need their stays loaded? Every row but a teacher's:
 * a role-only row's presence IS its stay, and a custodian's stay decides
 * whether they are also a member on the school booking or staying separately
 * on a school night (#3819). A teacher is never a guest.
 */
function needsMemberStays(shift: HutLeaderShift): boolean {
  return shift.source !== HutLeaderAssignmentSource.SCHOOL_BOOKING;
}

/**
 * The pure core: given the assignment rows, their members' stays and the school
 * bookings with their lodges' ticked kinds, answer the coverage question for
 * any (lodge, night). No I/O, so every rule above is testable without a
 * database.
 */
export function buildHutLeaderNightCover(
  shifts: readonly HutLeaderShift[],
  stays: readonly HutLeaderStay[],
  school: HutLeaderSchoolNights = { bookings: [], kindsByLodge: new Map() },
): HutLeaderNightCover {
  const staysByMember = new Map<string, HutLeaderStay[]>();
  for (const stay of stays) {
    if (!stay.memberId) continue;
    const list = staysByMember.get(stay.memberId) ?? [];
    list.push(stay);
    staysByMember.set(stay.memberId, list);
  }

  const schoolBookingIds = new Set(school.bookings.map((booking) => booking.id));
  const schoolBookingsOnNight = (lodgeId: string | null, night: Date) =>
    school.bookings.filter(
      (booking) =>
        booking.lodgeId === lodgeId &&
        booking.checkIn.getTime() <= night.getTime() &&
        night.getTime() < booking.checkOut.getTime(),
    );

  const isPresent = (shift: HutLeaderShift, night: Date): boolean => {
    if (isCustodianOccupancy(shift)) return true;
    if (shift.source === HutLeaderAssignmentSource.SCHOOL_BOOKING) {
      return isSchoolRowPresentOnNight(shift, night, schoolBookingsOnNight);
    }
    return activeStaysOnNight(shift, night, staysByMember).length > 0;
  };

  const schoolNightKinds = (lodgeId: string | null, night: Date) =>
    schoolBookingsOnNight(lodgeId, night).length === 0
      ? null
      : ((lodgeId !== null ? school.kindsByLodge.get(lodgeId) : undefined) ??
        DEFAULT_SCHOOL_HUT_LEADER_KINDS);

  const shiftCoversNight = (shift: HutLeaderShift, night: Date): boolean => {
    if (!shiftClaimsNight(shift, night) || !isPresent(shift, night)) return false;
    const ticked = schoolNightKinds(shift.lodgeId, night);
    if (!ticked) return true;
    return schoolHutLeaderKindsOfShift(shift, night, staysByMember, schoolBookingIds).some(
      (kind) => ticked[kind],
    );
  };

  const coveringShifts = (lodgeId: string | null, night: Date) =>
    shifts.filter((shift) => shift.lodgeId === lodgeId && shiftCoversNight(shift, night));

  return {
    shifts,
    coveringShifts,
    shiftCoversNight,
    isCovered: (lodgeId, night) => coveringShifts(lodgeId, night).length > 0,
    schoolNightKinds,
    isSchoolBooking: (bookingId) => schoolBookingIds.has(bookingId),
  };
}

/**
 * May a member staying on `stayBookingId` lead `night` at `lodgeId`? Always,
 * except on a school night, where only if the kind they would be — a member
 * on the school booking, or one staying separately — is ticked at that lodge
 * (#3819). The nightly auto-assign and the eligible-members suggestions ask
 * this before offering or writing a member, so neither proposes a leader the
 * cover would not count.
 */
export function memberMayLeadNight(
  cover: HutLeaderNightCover,
  input: { lodgeId: string | null; night: Date; stayBookingId: string },
): boolean {
  const ticked = cover.schoolNightKinds(input.lodgeId, input.night);
  if (!ticked) return true;
  return ticked[
    cover.isSchoolBooking(input.stayBookingId) ? "memberOnBooking" : "memberStayingSeparately"
  ];
}

/**
 * The nights around `night`, inside the member's stayed run `[first, last]`,
 * that they may lead ({@link memberMayLeadNight}) — contiguous, so one row.
 * Null when they may not lead `night` itself. The nightly auto-assign writes
 * exactly this span (#3821): a run longer than a school group's stay must not
 * carry the member onto school nights their kind is not ticked for, nor
 * through them onto the ordinary nights beyond. `cover` must reach `[first,
 * last]`, so a school booking on any of those nights is known.
 */
export function leadableNightRun(
  cover: HutLeaderNightCover,
  input: { lodgeId: string | null; night: Date; first: Date; last: Date; stayBookingId: string },
): { first: Date; last: Date } | null {
  const mayLead = (night: Date) =>
    memberMayLeadNight(cover, { lodgeId: input.lodgeId, night, stayBookingId: input.stayBookingId });
  if (!mayLead(input.night)) return null;
  let first = input.night;
  for (let previous = shiftNight(first, -1); previous.getTime() >= input.first.getTime() && mayLead(previous); previous = shiftNight(previous, -1)) {
    first = previous;
  }
  let last = input.night;
  for (let next = shiftNight(last, 1); next.getTime() <= input.last.getTime() && mayLead(next); next = shiftNight(next, 1)) {
    last = next;
  }
  return { first, last };
}

/**
 * The school-group nights in the row's own span that it does not cover,
 * because the lodge does not tick its kind for school bookings (#3821) — the
 * nights the manual create warns about. `cover` must reach the row's span and
 * its member's stays (`memberIds`).
 */
export function schoolNightsShiftDoesNotCover(
  cover: HutLeaderNightCover,
  shift: HutLeaderShift,
): string[] {
  return eachNight(shift.startDate, shift.endDate)
    .filter(
      (night) =>
        cover.schoolNightKinds(shift.lodgeId, night) !== null &&
        !cover.shiftCoversNight(shift, night),
    )
    .map(calendarDateOfDateOnlyInstant);
}

/** The scalar columns every coverage answer needs. */
const SHIFT_COVER_SELECT = {
  id: true,
  memberId: true,
  lodgeId: true,
  startDate: true,
  endDate: true,
  source: true,
  bedId: true,
  isCustodian: true,
} as const;

/**
 * The same, plus the member's and lodge's names, for the two callers that show
 * who covers a night (the hut-leaders calendar and the dashboard's handovers).
 */
const SHIFT_COVER_SELECT_WITH_NAMES = {
  ...SHIFT_COVER_SELECT,
  member: { select: { firstName: true, lastName: true } },
  lodge: { select: { name: true, active: true } },
} as const;

/**
 * Load the cover for every lodge in `scope` over the inclusive night window
 * `[from, to]`. A fixed number of Prisma reads, whatever the window: the
 * assignments; then, only for the lodges those assignments are at, the school
 * bookings staying there (#3819) and the stays of the members on them; then the
 * ticked school kinds of each lodge that has a school booking in the window —
 * never one read per night or per member, because the dashboard and the
 * sidebar badge run this on every admin page load. The default select is lean
 * (scalar columns only); pass `withNames` only when the caller shows who
 * covers a night.
 *
 * Pass the transaction client when the answer decides a write (the cron's
 * locked re-ask): it is a read, so it is only authoritative under that lock.
 * `memberIds` adds members whose stays to load beside the assignments' own,
 * for a caller asking {@link HutLeaderNightCover.shiftCoversNight} about a row
 * not yet written.
 */
export async function loadHutLeaderNightCover(
  reader: HutLeaderNightCoverReader,
  input: {
    scope: HutLeaderNightCoverScope;
    from: Date;
    to: Date;
    withNames?: boolean;
    memberIds?: readonly string[];
  },
): Promise<HutLeaderNightCover> {
  const db = reader as unknown as HutLeaderNightCoverDb;
  const shifts = await db.hutLeaderAssignment.findMany({
    where: {
      ...(input.scope.kind === "lodge" ? { lodgeId: input.scope.lodgeId } : {}),
      startDate: { lte: input.to },
      endDate: { gte: input.from },
    },
    select: input.withNames ? SHIFT_COVER_SELECT_WITH_NAMES : SHIFT_COVER_SELECT,
  });

  const lodgeIdsOf = (rows: readonly HutLeaderShift[]) => [
    ...new Set(
      rows
        .map((shift) => shift.lodgeId)
        .filter((lodgeId): lodgeId is string => lodgeId !== null),
    ),
  ];

  const schoolBookings = await loadHutLeaderSchoolBookings(db, input);

  const memberShifts = shifts.filter(needsMemberStays);
  const extraMemberIds = input.memberIds ?? [];
  const stayLodgeIds = [
    ...new Set([
      ...lodgeIdsOf(memberShifts),
      ...(extraMemberIds.length > 0 && input.scope.kind === "lodge" ? [input.scope.lodgeId] : []),
    ]),
  ];
  const stays =
    memberShifts.length === 0 && extraMemberIds.length === 0
      ? []
      : await db.bookingGuest.findMany({
          where: {
            memberId: {
              in: [...new Set([...memberShifts.map((shift) => shift.memberId), ...extraMemberIds])],
            },
            booking: hutLeaderStayBookingWhere({
              lodgeId: stayLodgeIds,
              rangeStart: input.from,
              rangeEnd: input.to,
            }),
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
          select: {
            memberId: true,
            stayStart: true,
            stayEnd: true,
            nights: { select: { stayDate: true } },
            booking: { select: { id: true, lodgeId: true, checkIn: true, checkOut: true } },
          },
        });

  const schoolLodgeIds = [
    ...new Set(
      schoolBookings
        .map((booking) => booking.lodgeId)
        .filter((lodgeId): lodgeId is string => lodgeId !== null),
    ),
  ];
  const kindsByLodge = new Map<string, SchoolHutLeaderKinds>();
  for (const lodgeId of schoolLodgeIds) {
    kindsByLodge.set(lodgeId, await loadSchoolHutLeaderKinds(db, lodgeId));
  }

  return buildHutLeaderNightCover(shifts, stays, {
    bookings: schoolBookings,
    kindsByLodge,
  });
}

/**
 * The school bookings staying in `scope` over `[from, to]`. A school group is
 * "staying" on the nights its booking HOLDS CAPACITY — the capacity engine's
 * own population, never a second status list (`schoolBookingHoldingBedsWhere`,
 * shared with the member stay definition). An approved school booking is
 * CONFIRMED until its Xero invoice is paid, which can be after arrival. A
 * cancelled or deleted one makes none.
 */
async function loadHutLeaderSchoolBookings(
  db: HutLeaderNightCoverDb,
  input: { scope: HutLeaderNightCoverScope; from: Date; to: Date },
): Promise<HutLeaderSchoolBooking[]> {
  return (await db.booking.findMany({
    where: {
      deletedAt: null,
      // Every school booking in scope, not only at lodges with assignments:
      // the auto-assign and the suggestions ask which kinds a night accepts
      // before any leader exists there.
      ...(input.scope.kind === "lodge" ? { lodgeId: input.scope.lodgeId } : {}),
      checkIn: { lte: input.to },
      checkOut: { gt: input.from },
      AND: [schoolBookingHoldingBedsWhere()],
    },
    select: { id: true, lodgeId: true, checkIn: true, checkOut: true },
  })) as HutLeaderSchoolBooking[];
}

/**
 * {@link schoolNightsShiftDoesNotCover} for a row at a lodge, read: the school
 * bookings first, and the whole cover only when one is there, so a lodge with
 * no school group pays one read (#3821, the manual create's warning).
 */
export async function findSchoolNightsShiftDoesNotCover(
  reader: HutLeaderNightCoverReader,
  shift: HutLeaderShift & { lodgeId: string },
): Promise<string[]> {
  const db = reader as unknown as HutLeaderNightCoverDb;
  const window = {
    scope: { kind: "lodge" as const, lodgeId: shift.lodgeId },
    from: shift.startDate,
    to: shift.endDate,
  };
  if ((await loadHutLeaderSchoolBookings(db, window)).length === 0) return [];
  const cover = await loadHutLeaderNightCover(reader, { ...window, memberIds: [shift.memberId] });
  return schoolNightsShiftDoesNotCover(cover, shift);
}

/**
 * The single-night form: is `night` covered at `lodgeId`? The auto-assign
 * cron's already-covered probe, asked once cheaply and once under the lodge
 * capacity lock with the transaction client.
 */
export async function isHutLeaderNightCovered(
  db: HutLeaderNightCoverReader,
  input: { lodgeId: string; night: Date },
): Promise<boolean> {
  const cover = await loadHutLeaderNightCover(db, {
    scope: { kind: "lodge", lodgeId: input.lodgeId },
    from: input.night,
    to: input.night,
  });
  return cover.isCovered(input.lodgeId, input.night);
}

/**
 * The leaders validly on duty for `night` at `lodgeId`, as the day-halves
 * derivation (`hut-leader-handover.ts`) reads them.
 */
export function hutLeadersOnNight(
  cover: HutLeaderNightCover,
  lodgeId: string | null,
  night: Date,
): HutLeaderOnNight[] {
  return cover.coveringShifts(lodgeId, night).map((shift) => ({
    memberId: shift.memberId,
    name: shift.member ? memberName(shift.member) : "",
  }));
}

/** The distinct lodges the cover holds assignments for, in first-seen order. */
function coverLodges(
  cover: HutLeaderNightCover,
): Array<{ lodgeId: string | null; lodgeName: string | null; lodgeActive: boolean | null }> {
  const seen = new Map<string, { lodgeId: string | null; lodgeName: string | null; lodgeActive: boolean | null }>();
  for (const shift of cover.shifts) {
    const key = shift.lodgeId ?? "";
    if (seen.has(key)) continue;
    seen.set(key, {
      lodgeId: shift.lodgeId,
      lodgeName: shift.lodge?.name ?? null,
      lodgeActive: shift.lodge?.active ?? null,
    });
  }
  return [...seen.values()];
}

/** A stored lodge night moved by whole calendar days (zone-free). */
function shiftNight(night: Date, days: number): Date {
  return dateOnlyInstantOf(addCalendarDays(calendarDateOfDateOnlyInstant(night), days));
}

function eachNight(from: Date, to: Date): Date[] {
  const nights: Date[] = [];
  for (let night = from; night.getTime() <= to.getTime(); night = shiftNight(night, 1)) {
    nights.push(night);
  }
  return nights;
}

/** One covered lodge night and who validly covers it (the calendar's input). */
export type HutLeaderNightLeaders = {
  date: string;
  lodgeId: string | null;
  leaders: HutLeaderOnNight[];
};

/** Every covered lodge night in `[from, to]`, date ascending. */
export function listHutLeaderNightLeaders(
  cover: HutLeaderNightCover,
  input: { from: Date; to: Date },
): HutLeaderNightLeaders[] {
  const rows: HutLeaderNightLeaders[] = [];
  const lodges = coverLodges(cover);
  for (const night of eachNight(input.from, input.to)) {
    for (const lodge of lodges) {
      const leaders = hutLeadersOnNight(cover, lodge.lodgeId, night);
      if (leaders.length > 0) {
        rows.push({ date: calendarDateOfDateOnlyInstant(night), lodgeId: lodge.lodgeId, leaders });
      }
    }
  }
  return rows;
}

/**
 * One changeover on day D: `from` are the leaders who finish at midday (on
 * night D − 1, not on night D); `to` are everyone on duty from midday (night D).
 */
export type HutLeaderHandover = {
  /** Calendar day D: the morning belongs to `from`, the afternoon to `to`. */
  date: string;
  lodgeId: string | null;
  lodgeName: string | null;
  lodgeActive: boolean | null;
  from: HutLeaderOnNight[];
  to: HutLeaderOnNight[];
};

/**
 * Every handover on a day in `[from, to]`: a day on which somebody finishes at
 * midday and somebody is on duty from midday (`deriveHutLeaderDayHalves`). The
 * cover must reach back to the night before `from`, because the morning of
 * `from` belongs to that night.
 */
export function listHutLeaderHandovers(
  cover: HutLeaderNightCover,
  input: { from: Date; to: Date },
): HutLeaderHandover[] {
  const handovers: HutLeaderHandover[] = [];
  const lodges = coverLodges(cover);
  for (const day of eachNight(input.from, input.to)) {
    for (const lodge of lodges) {
      const halves = deriveHutLeaderDayHalves(
        hutLeadersOnNight(cover, lodge.lodgeId, shiftNight(day, -1)),
        hutLeadersOnNight(cover, lodge.lodgeId, day),
      );
      if (!halves.isHandover) continue;
      handovers.push({
        date: calendarDateOfDateOnlyInstant(day),
        ...lodge,
        from: [...halves.leaving],
        to: [...halves.afternoon],
      });
    }
  }
  return handovers;
}
