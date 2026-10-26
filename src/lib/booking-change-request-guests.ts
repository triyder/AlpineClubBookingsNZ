import type { AgeTier } from "@prisma/client";
import { z } from "zod";

import { bookableAgeTierEnum } from "@/lib/age-tier-schema";
import {
  calendarDateOfDateOnlyInstant,
  dateOnlyInstantOf,
  requireCalendarDate,
} from "@/lib/club-time";
import {
  GUEST_CHANGE_LIST_BOUND, BOOKING_PARTY_GUESTS_MAX,
  BookingGuestStayRangeValidationError,
  GUEST_REQUEST_MEMBER_WORDED_MESSAGES,
  guestRequestSchemaError,
  guestStayFieldsSchema,
  normalizeGuestStayRange,
  type BookingGuestStayRangeInput,
  type NormalizedBookingGuestStayRange,
} from "@/lib/booking-guest-stay-range-input";
import { parseDateOnly } from "@/lib/date-only";
import {
  getExplicitGuestBedNightKeys,
  getGuestBedNightKeys,
  sameNightKeys,
} from "@/lib/booking-guest-stay-ranges";
import {
  effectiveStayRangeByGuest,
  resolveModificationStayRanges,
  type LiveGuestStayRow,
  type StayRangeDeltaInput,
} from "@/lib/booking-modification-stay-ranges";
import { nameField } from "@/lib/zod-helpers";
import { guestName } from "@/lib/bed-allocation-display-names";

/**
 * The guests a LOCKED_PERIOD change request adds (#4030), in the one shape every
 * writer of one uses: the member's request (`POST /api/bookings/[id]/change-requests`),
 * its price estimate, and the officer entering them on the member's behalf on a
 * finished stay's approval (`PATCH /api/admin/booking-change-requests/[id]`).
 *
 * WHY #4030 EXISTS. A member whose stay was under way could only send a free-text
 * note ("can we add these three grandchildren"), which named nobody, so the
 * finished-stay approval (#3750) had nothing to charge. A request now has to
 * carry at least one structured change, and both ends of the queue can say who
 * is being added, with the same fields and nights inside the stay.
 */

/**
 * One added guest, as the request carries it. Nights are `[stayStart, stayEnd)`,
 * or, from the editor's per-night grid, the explicit night set `nights` (#713),
 * which wins over the two bounds exactly as it does on an edit (#4088).
 */
export const changeRequestAddGuestSchema = z.object({
  firstName: nameField(),
  lastName: nameField(),
  ageTier: bookableAgeTierEnum,
  isMember: z.boolean(),
  memberId: z.string().trim().min(1).optional(),
  ...guestStayFieldsSchema.shape,
});

/**
 * One existing guest's requested nights (#4088): both bounds, or the editor
 * grid's explicit night set. Without `nights` declared here zod stripped it, so
 * a grid-mode request lost every guest's chosen nights.
 */
export const changeRequestGuestStayRangeSchema = z.object({
  guestId: z.string().trim().min(1),
  ...guestStayFieldsSchema.shape,
});

export type ChangeRequestAddGuest = z.infer<typeof changeRequestAddGuestSchema>;

/** The list form, capped as the request route always capped it. */
export const changeRequestAddGuestsSchema = z.array(changeRequestAddGuestSchema).max(...GUEST_CHANGE_LIST_BOUND);

/**
 * The officer's entry (#4030 Part B): at least one guest, every one with its
 * nights stated, because the officer is entering what the member described and a
 * silent "whole stay" default is a guess about nights nobody wrote down.
 */
export const officerEnteredGuestsSchema = z
  .array(
    // The officer states two bounds; the per-night grid is the member's editor.
    changeRequestAddGuestSchema.omit({ nights: true }).extend({
      stayStart: z.string(),
      stayEnd: z.string(),
    }),
  )
  .min(1)
  .max(...GUEST_CHANGE_LIST_BOUND);

export type OfficerEnteredGuest = z.infer<typeof officerEnteredGuestsSchema>[number];

/** What a member is told when one request names the same guest's nights twice (#4157). */
export const CHANGE_REQUEST_DUPLICATE_GUEST_RANGE_MESSAGE =
  "Each guest's dates can only be given once in a request. Please check the guests' dates and send it again.";

/**
 * The existing guests' requested nights, each guest at most once (#4157).
 * Approval applies one entry per guest — the last — so a request naming a
 * guest twice says two things and applies one. New requests are refused; a
 * row stored before this rule is still read by its last applied entry
 * (`effectiveStayRangeByGuest` after `isAppliedChangeRequestRange`).
 */
export const changeRequestGuestStayRangesSchema = z
  .array(changeRequestGuestStayRangeSchema)
  .max(BOOKING_PARTY_GUESTS_MAX)
  .refine((ranges) => new Set(ranges.map((range) => range.guestId)).size === ranges.length, {
    message: CHANGE_REQUEST_DUPLICATE_GUEST_RANGE_MESSAGE,
  });

/** The member-worded refusals the request's schema carries. */
const MEMBER_WORDED_SCHEMA_MESSAGES = [...GUEST_REQUEST_MEMBER_WORDED_MESSAGES, CHANGE_REQUEST_DUPLICATE_GUEST_RANGE_MESSAGE];

/**
 * The `error` a request the schema refuses is answered with (#4088): a bad
 * night, a guest named twice (#4157) or too many changes (#4199) is said in the member's terms;
 * anything else stays "Validation failed" with the details beside it.
 */
export function changeRequestValidationMessage(error: z.ZodError): string {
  // Matched on the exact message: a `nights` that is not a list at all is not a
  // bad date and stays "Validation failed"; a list of changes too long is worded.
  return guestRequestSchemaError(error, "Validation failed", MEMBER_WORDED_SCHEMA_MESSAGES);
}

/**
 * The refusal a request with no structured change gets. A note alone cannot be
 * applied to the booking, so it is no longer a request (owner decision on #4030:
 * "a structured delta is required"). Said in the member's terms, pointing at the
 * controls that make one.
 */
export const CHANGE_REQUEST_NEEDS_STRUCTURED_CHANGE_MESSAGE =
  "Add the guests (or change the dates) you are asking for, then send the request. A note on its own can't be applied to your booking; use it to tell the booking officer anything else they should know.";

/**
 * #4030 review M4 (`INV-GUEST-019`): a typed-in guest whose name matches one of
 * the booking owner's own dependants is refused when the request is sent, by
 * the same `checkOwnDependantIdentityForParty` every booking door runs, rather
 * than reaching the officer as a request the approval would then refuse. Said
 * to the member, and to the officer entering guests for them.
 *
 * Each message answers both readings of the name (#4030 re-review of
 * 72c933ffc), because neither surface takes the "different person, same name"
 * declaration the booking wizard and editor do: if it is the dependant, the
 * member path; if it is somebody else who shares the name, this surface cannot
 * add them, so they come off it.
 */
export const CHANGE_REQUEST_DEPENDANT_TYPED_MESSAGE =
  "Someone you are adding has the same name as one of your dependants. If it is your dependant, add them with their own button above (your family), so they are booked as the member they are. If it is a different person who shares the name, this request can't add them: take them off it and contact the club about them.";
export const OFFICER_ENTRY_DEPENDANT_TYPED_MESSAGE =
  "A guest you entered has the same name as one of the member's dependants. If it is that dependant, add them with + Add a member (the member finder) instead, so they are booked as the member they are. If it is a different person who shares the name, this entry can't add them: leave them off it and say so in your explanation to the member. Nothing has been changed; the request is still pending.";

/**
 * The stay a request's added guests must fall inside. `checkIn` / `checkOut` are
 * calendar days (`yyyy-MM-dd`), the booking's own or, on a request that also
 * moves them, the proposed ones.
 */
export interface ChangeRequestStay {
  checkIn: string;
  checkOut: string;
}

/**
 * One guest's nights read by the canonical `normalizeGuestStayRange`, or its
 * refusal said with the guest's name in place of the position label ("Guest
 * 2") the shared rule writes (#4088), as the within-stay refusal below does.
 */
function readNamedStayRange(
  entry: BookingGuestStayRangeInput,
  bounds: { checkIn: Date; checkOut: Date },
  index: number,
  name: string | null,
): NormalizedBookingGuestStayRange | { refusal: string } {
  try {
    return normalizeGuestStayRange(entry, bounds, index);
  } catch (error) {
    if (!(error instanceof BookingGuestStayRangeValidationError)) throw error;
    const label = `Guest ${index + 1}`;
    return {
      refusal: name && error.message.startsWith(label) ? `${name}${error.message.slice(label.length)}` : error.message,
    };
  }
}

/**
 * Why an added guest's nights cannot be requested, or `null` when every one is
 * a run of nights inside the stay.
 *
 * The range itself is read by the canonical `normalizeGuestStayRange`
 * (`INV-SSOT`) — the rule every booking door uses: no bounds is the whole stay,
 * one bound alone is refused, Date Out must follow Date In. This adds only the
 * request's own rule, that the nights fall inside the stay (#4030 review M3).
 */
export function addedGuestNightsRefusal(
  guests: ReadonlyArray<
    Pick<ChangeRequestAddGuest, "firstName" | "lastName" | "stayStart" | "stayEnd"> & {
      nights?: ReadonlyArray<string> | null;
    }
  >,
  stay: ChangeRequestStay,
): string | null {
  const bounds = {
    checkIn: dateOnlyInstantOf(requireCalendarDate(stay.checkIn)),
    checkOut: dateOnlyInstantOf(requireCalendarDate(stay.checkOut)),
  };
  for (const [index, guest] of guests.entries()) {
    const name = guestName(guest) || null;
    const range = readNamedStayRange(guest, bounds, index, name);
    if ("refusal" in range) return range.refusal;
    if (range.stayStart < bounds.checkIn || range.stayEnd > bounds.checkOut) {
      return `${name ?? `Guest ${index + 1}`}'s nights must fall within the stay (${stay.checkIn} to ${stay.checkOut}).`;
    }
  }
  return null;
}

/**
 * Each added guest's first night (#4088), by the canonical range rule: a grid
 * night set's earliest night, else Date In, else the stay's check-in. For the
 * route's locked-period test, after `addedGuestNightsRefusal` accepted them.
 */
export function addedGuestFirstNights(
  guests: ReadonlyArray<{
    stayStart?: string | null;
    stayEnd?: string | null;
    nights?: ReadonlyArray<string> | null;
  }>,
  stay: { checkIn: Date; checkOut: Date },
): Date[] {
  return guests.map((guest, index) => normalizeGuestStayRange(guest, stay, index).stayStart);
}

/**
 * #4030 re-review of 72c933ffc: an existing guest's requested nights are read
 * by the same canonical range rule the added guests' are
 * (`normalizeGuestStayRange`): real `yyyy-mm-dd` days, both bounds or neither,
 * Date Out after Date In. The refusal message, naming the guest from `guests`
 * (#4088), or `null`. A range or night set may still reach outside the stay:
 * the planner widens the stay to cover it, as an edit does (#713), and a moved
 * date it does not reach is refused by `requestedDatesIgnoredByNightsRefusal`.
 */
export function guestStayRangesRefusal(
  ranges: ReadonlyArray<{
    guestId?: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    nights?: ReadonlyArray<string> | null;
  }>,
  stay: ChangeRequestStay,
  guests: ReadonlyArray<{ id: string; firstName: string; lastName: string }> = [],
): string | null {
  const bounds = {
    checkIn: dateOnlyInstantOf(requireCalendarDate(stay.checkIn)),
    checkOut: dateOnlyInstantOf(requireCalendarDate(stay.checkOut)),
  };
  for (const [index, range] of ranges.entries()) {
    const named = guests.find((guest) => guest.id === range.guestId);
    const name = named ? guestName(named) || null : null;
    const read = readNamedStayRange(range, bounds, index, name);
    if ("refusal" in read) return read.refusal;
  }
  return null;
}

export const CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE =
  "The new check-in or check-out date doesn't match the nights your guests are staying. Set each guest's nights to the dates you want, or, if you can't change their nights here, send the date change on its own and add the guests in a second request once the club has dealt with it.";

/**
 * #4030 round 7 (F2): a request that moves check-in or check-out while also
 * naming guests' nights. With nights named, the planner sets the stay's dates
 * from them (`resolveModificationStayRanges`, range mode) and ignores the
 * requested ones, so a moved date the nights do not reach would be dropped
 * without a word. Refused instead, with `null` when the dates are where the
 * nights put them, or the request moves no date. The message names both ways
 * forward: a stay in progress shows no editable nights for existing guests, and
 * its added-guest card caps nights at the original check-out (#4030 round 8).
 */
export function requestedDatesIgnoredByNightsRefusal(args: {
  booking: { checkIn: Date; checkOut: Date };
  guests: ReadonlyArray<LiveGuestStayRow>;
  input: StayRangeDeltaInput;
  /** Whether the request moves check-in / check-out at all. */
  movesCheckIn: boolean;
  movesCheckOut: boolean;
}): string | null {
  if (!args.movesCheckIn && !args.movesCheckOut) return null;
  let resolved;
  try {
    resolved = resolveModificationStayRanges(args);
  } catch (error) {
    if (error instanceof BookingGuestStayRangeValidationError) return error.message;
    throw error;
  }
  if (!resolved.hasRangeInputs) return null;
  const ignored =
    (args.movesCheckIn && resolved.checkIn.getTime() !== resolved.requestedCheckIn.getTime()) ||
    (args.movesCheckOut && resolved.checkOut.getTime() !== resolved.requestedCheckOut.getTime());
  return ignored ? CHANGE_REQUEST_DATES_OUTSIDE_NIGHTS_MESSAGE : null;
}

/** A guest's range and, when it has one, its explicit night set, as calendar days. */
export interface GuestNightsAsDays {
  stayStart: string;
  stayEnd: string;
  nights?: ReadonlyArray<string> | null;
}

/**
 * A guest's nights as sorted, distinct `yyyy-mm-dd` keys (#4088): the canonical
 * `getGuestBedNightKeys` (INV-DATE-020) over calendar days. Read only from
 * STORED values (the booking's own rows, or the request's snapshot of them).
 */
export function guestNightKeys(guest: GuestNightsAsDays): string[] {
  const stayStart = parseDateOnly(guest.stayStart);
  const stayEnd = parseDateOnly(guest.stayEnd);
  return getGuestBedNightKeys({ stayStart, stayEnd, nights: guest.nights }, { checkIn: stayStart, checkOut: stayEnd });
}

/** A live guest's stored range and night rows, as {@link GuestNightsAsDays}. */
export function storedGuestNightsAsDays(guest: {
  stayStart: Date;
  stayEnd: Date;
  nights?: ReadonlyArray<{ stayDate: Date }> | null;
}): GuestNightsAsDays & { nights: string[] } {
  return {
    stayStart: calendarDateOfDateOnlyInstant(guest.stayStart),
    stayEnd: calendarDateOfDateOnlyInstant(guest.stayEnd),
    nights: (guest.nights ?? []).map((night) => calendarDateOfDateOnlyInstant(night.stayDate)).sort(),
  };
}

/**
 * Whether a requested guest stay range actually changes anything (#4030 review
 * M2): both bounds given, and different from the guest's own stored range. A
 * range missing a bound, or repeating the guest's current nights, is not a
 * structured change — it must not let a note through as one, nor stop the
 * officer entering guests for what is really a free-text request.
 *
 * A grid night set (#4088) counts when it differs from the guest's current
 * nights. A two-bound range is compared on its bounds alone, as before.
 *
 * `current` is the guest's stored range as calendar days, or `undefined` when
 * it is not known (a range for a guest the request does not describe), in which
 * case a two-bound range or a night set counts.
 */
export function isEffectiveStayRangeChange(
  range: { stayStart?: string | null; stayEnd?: string | null; nights?: ReadonlyArray<string> | null },
  current: GuestNightsAsDays | undefined,
): boolean {
  const requested = getExplicitGuestBedNightKeys({ nights: range.nights });
  if (requested) return !current || !sameNightKeys(requested, guestNightKeys(current));
  if (!range.stayStart || !range.stayEnd) return false;
  if (!current) return true;
  return range.stayStart !== current.stayStart || range.stayEnd !== current.stayEnd;
}

/**
 * The nights a guest keeps when their requested range only repeats their own
 * Date In and Date Out (#4157, owner decision "Keep their nights"), as sorted
 * `yyyy-mm-dd` keys, or `null` when the range is applied as it is written.
 *
 * A two-bound range carries no night set, so applied as written it puts the
 * guest on every night inside it and fills (and charges) the gaps in a stay
 * like nights {10, 12}. Range mode cannot express gaps, so the member's form
 * sends a gapped guest's own bounds back unchanged; that is no change to their
 * dates, and their nights stand. Only a moved bound re-spreads them.
 *
 * `null` for a grid night set, a one-bound range, a moved bound, an unknown
 * guest, a guest with no night rows, and a guest who already holds every night
 * of the range (applied by its two bounds, exactly as before).
 */
export function nightsKeptByRepeatedRange(
  range: { stayStart?: string | null; stayEnd?: string | null; nights?: ReadonlyArray<string> | null },
  current: GuestNightsAsDays | undefined,
): string[] | null {
  if (range.nights?.length || !range.stayStart || !range.stayEnd || !current) return null;
  if (range.stayStart !== current.stayStart || range.stayEnd !== current.stayEnd) return null;
  const held = getExplicitGuestBedNightKeys({ nights: current.nights });
  if (!held) return null;
  const everyNight = guestNightKeys({ stayStart: current.stayStart, stayEnd: current.stayEnd });
  return sameNightKeys(held, everyNight) ? null : held;
}

/**
 * Whether a change request's guest range is one approval applies (#4030): both
 * bounds, or a grid night set. Anything else — no dates, or one bound, which a
 * row stored before #4030 refused them may still hold — is dropped, as it has
 * always been. Not `entryHasStayRange`, which admits a one-bound range.
 */
export function isAppliedChangeRequestRange(range: {
  stayStart?: string | null;
  stayEnd?: string | null;
  nights?: ReadonlyArray<string> | null;
}): boolean {
  return Boolean(range.stayStart && range.stayEnd) || Boolean(range.nights?.length);
}

/**
 * #4030 review M2: whether any of a request's stay ranges changes a guest's
 * nights, against the guests' stored `@db.Date` ranges. Each guest is judged
 * on the entry approval applies for them: the last one left by
 * `isAppliedChangeRequestRange` (`effectiveStayRangeByGuest`), so an earlier
 * entry approval ignores cannot make a request count as a change (#4157).
 */
export function namesStayRangeChange(
  ranges: ReadonlyArray<{
    guestId: string;
    stayStart?: string | null;
    stayEnd?: string | null;
    nights?: ReadonlyArray<string> | null;
  }>,
  guests: ReadonlyArray<{
    id: string;
    stayStart: Date;
    stayEnd: Date;
    nights?: ReadonlyArray<{ stayDate: Date }> | null;
  }>,
): boolean {
  return [...effectiveStayRangeByGuest(ranges.filter(isAppliedChangeRequestRange)).values()].some((range) => {
    const guest = guests.find((candidate) => candidate.id === range.guestId);
    return isEffectiveStayRangeChange(range, guest ? storedGuestNightsAsDays(guest) : undefined);
  });
}

/**
 * The one-line summary a request is listed and emailed under. Moved here from
 * the member route (#4030) so the officer's entry on an existing request is
 * summarised by the same words a member's own request is.
 */
export function buildChangeRequestSummary({
  checkIn,
  checkOut,
  addGuests,
  removedGuests,
  guestStayRanges,
  requestedEffectiveDate,
}: {
  checkIn?: string | null;
  checkOut?: string | null;
  addGuests?: ReadonlyArray<{ firstName: string; lastName: string; ageTier: AgeTier; isMember: boolean }>;
  removedGuests: ReadonlyArray<{ firstName: string; lastName: string }>;
  guestStayRanges?: ReadonlyArray<unknown>;
  requestedEffectiveDate?: string | null;
}): string {
  const parts: string[] = [];
  if (checkIn) parts.push(`check-in to ${checkIn}`);
  if (checkOut) parts.push(`check-out to ${checkOut}`);
  if (addGuests?.length) {
    parts.push(
      `add ${addGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (removedGuests.length) {
    parts.push(
      `remove ${removedGuests.map((guest) => `${guest.firstName} ${guest.lastName}`).join(", ")}`
    );
  }
  if (guestStayRanges?.length) {
    parts.push(`update ${guestStayRanges.length} guest stay range${guestStayRanges.length === 1 ? "" : "s"}`);
  }
  if (requestedEffectiveDate) {
    parts.push(`effective ${requestedEffectiveDate}`);
  }
  return parts.length ? parts.join("; ") : "Locked-period booking change";
}

/**
 * Appended to the summary of a request whose guests the officer entered, so
 * the queue, the member's booking page and the audit trail all say whose list
 * it is.
 */
export const OFFICER_ENTERED_SUMMARY_SUFFIX = "(entered by a booking officer on the member's behalf)";

/**
 * The stamp written into `requestedChanges.requested.officerEntry` beside the
 * guests an officer entered (#4030 Part B). It names the officer and keeps the
 * member's own summary, because the request now says something the member did
 * not write and the record has to show both.
 */
export interface OfficerEntryStamp {
  onMemberBehalf: true;
  officerMemberId: string;
  enteredAt: string;
  memberSummary: string | null;
}

/**
 * The member's estimate for the guests a request adds (#4030 Part A), as
 * `estimateChangeRequestAddedGuests` answers and the request card reads it.
 */
export type ChangeRequestEstimate =
  | {
      outcome: "priced";
      /** One per added guest, in order; `null` for a member guest (not priced). */
      guests: Array<{ priceCents: number | null; nights: number }>;
      /** The non-member guests' total. */
      totalCents: number;
      /** True when a member guest is in the list and so not in the total. */
      excludesMemberGuests: boolean;
    }
  | { outcome: "unpriced"; message: string };

/**
 * The request's stored `requestedChanges` with an officer's entry written in
 * (#4030 Part B): the guests become the request's `addGuests`, the summary says
 * whose list it is, and `officerEntry` names the officer and keeps the member's
 * own summary. Everything else — `original`, the member's dates, the payment
 * snapshot, the locked-period facts — is kept exactly.
 *
 * Only ever called on a request that names no structured change (the executor
 * checks), so there is nothing of the member's own delta to merge with.
 */
export function withOfficerEnteredGuests(
  requestedChanges: unknown,
  guests: ReadonlyArray<OfficerEnteredGuest>,
  stamp: { officerMemberId: string; enteredAt: Date },
): Record<string, unknown> {
  const stored = isRecord(requestedChanges) ? requestedChanges : {};
  const requested = isRecord(stored.requested) ? stored.requested : {};
  const memberSummary = typeof requested.summary === "string" ? requested.summary : null;
  const officerEntry: OfficerEntryStamp = {
    onMemberBehalf: true,
    officerMemberId: stamp.officerMemberId,
    enteredAt: stamp.enteredAt.toISOString(),
    memberSummary,
  };
  return {
    ...stored,
    requested: {
      ...requested,
      addGuests: guests.map((guest) => ({
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember: guest.isMember,
        ...(guest.isMember && guest.memberId ? { memberId: guest.memberId } : {}),
        stayStart: guest.stayStart,
        stayEnd: guest.stayEnd,
      })),
      summary: `${buildChangeRequestSummary({ addGuests: guests, removedGuests: [] })} ${OFFICER_ENTERED_SUMMARY_SUFFIX}`,
      officerEntry,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
