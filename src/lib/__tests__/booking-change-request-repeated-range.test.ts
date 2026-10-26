import { describe, expect, it } from "vitest";

/**
 * #4157 (owner decision "Keep their nights"): a change request sent in
 * date-range mode carries each guest's Date In and Date Out, never their night
 * set, so a guest with gaps (#713) has their own dates sent back unchanged.
 * Applied as written, that range filled the gaps and charged for them. A range
 * that only repeats the guest's own dates now keeps the nights they hold; a
 * range that moves a bound re-spreads them as before, guest by guest.
 */

import { namesStayRangeChange, nightsKeptByRepeatedRange } from "@/lib/booking-change-request-guests";
import {
  describeRequestedGuestNights,
  keptNightsByGuest,
  lockedPeriodRequestToBatchInput,
  storedLockedPeriodRequestSchema,
  storedRequestNamesNoChange,
} from "@/lib/booking-change-request-stored";
import { resolveModificationStayRanges } from "@/lib/booking-modification-stay-ranges";
import { getGuestBedNightKeys } from "@/lib/booking-guest-stay-ranges";

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

// A 10-13 June stay: Gap holds 10 and 12 June (not the 11th); Mover holds the
// same two nights; Full holds all three.
const GAPPED = ["2026-06-10", "2026-06-12"];
const EVERY = ["2026-06-10", "2026-06-11", "2026-06-12"];

function liveGuest(id: string, nights: string[]) {
  return {
    id,
    stayStart: day("2026-06-10"),
    stayEnd: day("2026-06-13"),
    nights: nights.map((night) => ({ stayDate: day(night) })),
  };
}

const LIVE = {
  checkIn: day("2026-06-10"),
  checkOut: day("2026-06-13"),
  guests: [liveGuest("gap", GAPPED), liveGuest("mover", GAPPED), liveGuest("full", EVERY)],
};

function snapshotGuest(id: string, nights: string[] | undefined) {
  return {
    id,
    stayStart: "2026-06-10",
    stayEnd: "2026-06-13",
    ...(nights ? { nights } : {}),
  };
}

function stored(
  requested: Record<string, unknown>,
  options: { snapshotNights?: boolean } = {},
) {
  const withNights = options.snapshotNights !== false;
  return storedLockedPeriodRequestSchema.parse({
    original: {
      checkIn: "2026-06-10",
      checkOut: "2026-06-13",
      guests: [
        snapshotGuest("gap", withNights ? GAPPED : undefined),
        snapshotGuest("mover", withNights ? GAPPED : undefined),
        snapshotGuest("full", withNights ? EVERY : undefined),
      ],
    },
    requested,
  });
}

const REPEATED = { stayStart: "2026-06-10", stayEnd: "2026-06-13" };
const ADD_FRIEND = { firstName: "Late", lastName: "Friend", ageTier: "ADULT", isMember: false };

/** Every guest's nights, as the canonical planner resolves the batch input. */
function plannedNights(input: NonNullable<ReturnType<typeof lockedPeriodRequestToBatchInput>>) {
  const resolved = resolveModificationStayRanges({
    booking: { checkIn: LIVE.checkIn, checkOut: LIVE.checkOut },
    guests: LIVE.guests,
    input,
  });
  const envelope = { checkIn: resolved.checkIn, checkOut: resolved.checkOut };
  return Object.fromEntries(
    resolved.remaining.map(({ guest, ...range }) => [guest.id, getGuestBedNightKeys(range, envelope)]),
  );
}

describe("nightsKeptByRepeatedRange (#4157)", () => {
  const current = { stayStart: "2026-06-10", stayEnd: "2026-06-13", nights: GAPPED };

  it("keeps a gapped guest's nights when the range repeats their own dates", () => {
    expect(nightsKeptByRepeatedRange(REPEATED, current), "INV-REQ-012: a repeated range keeps the nights held").toEqual(GAPPED);
  });

  it("applies the range as written when either bound moves", () => {
    expect(nightsKeptByRepeatedRange({ stayStart: "2026-06-10", stayEnd: "2026-06-14" }, current)).toBeNull();
    expect(nightsKeptByRepeatedRange({ stayStart: "2026-06-11", stayEnd: "2026-06-13" }, current)).toBeNull();
  });

  it("leaves everything else to the range as written", () => {
    // A guest who holds every night of the range: the two bounds already say so.
    expect(nightsKeptByRepeatedRange(REPEATED, { ...current, nights: EVERY })).toBeNull();
    // No night rows to keep, an unknown guest, a one-bound range, a night set.
    expect(nightsKeptByRepeatedRange(REPEATED, { ...current, nights: [] })).toBeNull();
    expect(nightsKeptByRepeatedRange(REPEATED, { stayStart: "2026-06-10", stayEnd: "2026-06-13" })).toBeNull();
    expect(nightsKeptByRepeatedRange(REPEATED, undefined)).toBeNull();
    expect(nightsKeptByRepeatedRange({ stayStart: "2026-06-10" }, current)).toBeNull();
    expect(nightsKeptByRepeatedRange({ ...REPEATED, nights: EVERY }, current)).toBeNull();
  });
});

describe("approving a range-mode request keeps a gapped guest's nights (#4157)", () => {
  it("a gapped guest whose range is repeated keeps their gap, and is not put on the missing night", () => {
    const request = stored({
      addGuests: [ADD_FRIEND],
      guestStayRanges: [{ guestId: "gap", ...REPEATED }],
    });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges, "INV-REQ-012: approval passes the kept nights").toEqual([
      { guestId: "gap", ...REPEATED, nights: GAPPED },
    ]);
    expect(plannedNights(input!), "INV-REQ-012: the planner keeps the gap").toMatchObject({ gap: GAPPED });
  });

  it("a guest whose range really moves gets the new continuous stay", () => {
    const request = stored({
      guestStayRanges: [{ guestId: "mover", stayStart: "2026-06-11", stayEnd: "2026-06-13" }],
    });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges).toEqual([
      { guestId: "mover", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
    ]);
    expect(plannedNights(input!)).toMatchObject({ mover: ["2026-06-11", "2026-06-12"] });
  });

  it("a mixed party gets each outcome per guest", () => {
    const request = stored({
      addGuests: [ADD_FRIEND],
      guestStayRanges: [
        { guestId: "gap", ...REPEATED },
        { guestId: "mover", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
        { guestId: "full", ...REPEATED },
      ],
    });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges).toEqual([
      { guestId: "gap", ...REPEATED, nights: GAPPED },
      { guestId: "mover", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
      // Every night held: applied by its two bounds, exactly as before.
      { guestId: "full", ...REPEATED },
    ]);
    expect(plannedNights(input!)).toEqual({
      gap: GAPPED,
      mover: ["2026-06-11", "2026-06-12"],
      full: EVERY,
    });
  });

  it("keeps the nights the guest holds under the executor's locks, even where the snapshot recorded none", () => {
    // A row stored before #4088 kept the guest's range but no night rows.
    const request = stored(
      { addGuests: [ADD_FRIEND], guestStayRanges: [{ guestId: "gap", ...REPEATED }] },
      { snapshotNights: false },
    );
    expect(lockedPeriodRequestToBatchInput(request, LIVE)?.guestStayRanges).toEqual([
      { guestId: "gap", ...REPEATED, nights: GAPPED },
    ]);
    // Without the live rows (the admin list's question) the snapshot is all
    // there is, and it describes no gap: the range is passed as written.
    expect(
      lockedPeriodRequestToBatchInput(request, { checkIn: LIVE.checkIn, checkOut: LIVE.checkOut })
        ?.guestStayRanges,
    ).toEqual([{ guestId: "gap", ...REPEATED }]);
  });

  it("reads the snapshot's nights when no live rows are passed", () => {
    const request = stored({ addGuests: [ADD_FRIEND], guestStayRanges: [{ guestId: "gap", ...REPEATED }] });
    expect(
      lockedPeriodRequestToBatchInput(request, { checkIn: LIVE.checkIn, checkOut: LIVE.checkOut })
        ?.guestStayRanges,
    ).toEqual([{ guestId: "gap", ...REPEATED, nights: GAPPED }]);
  });

  it("keeps the gap when the request also moves the stay's own dates", () => {
    // Check-out a night later, and the gapped guest's own dates repeated: range
    // mode stays on, so the guest is neither stretched nor filled.
    const request = stored({
      checkOut: "2026-06-14",
      addGuests: [{ ...ADD_FRIEND, stayStart: "2026-06-13", stayEnd: "2026-06-14" }],
      guestStayRanges: [{ guestId: "gap", ...REPEATED }],
    });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input).toMatchObject({ checkOut: "2026-06-14" });
    expect(plannedNights(input!)).toMatchObject({ gap: GAPPED });
  });

  it("a request that only repeats every guest's own dates still names no change", () => {
    const repeatsOnly = {
      original: {
        checkIn: "2026-06-10",
        checkOut: "2026-06-13",
        guests: [snapshotGuest("gap", GAPPED), snapshotGuest("full", EVERY)],
      },
      requested: {
        guestStayRanges: [
          { guestId: "gap", ...REPEATED },
          { guestId: "full", ...REPEATED },
        ],
      },
    };
    expect(storedRequestNamesNoChange(repeatsOnly, LIVE)).toBe(true);
    expect(
      lockedPeriodRequestToBatchInput(storedLockedPeriodRequestSchema.parse(repeatsOnly), LIVE),
    ).toBeNull();
    // A row stored before #4088 snapshotted no night rows: the live gapped
    // nights kept for the guest are still not read as a change the member
    // asked for, so the request still names none.
    const olderRow = {
      ...repeatsOnly,
      original: {
        ...repeatsOnly.original,
        guests: [snapshotGuest("gap", undefined), snapshotGuest("full", undefined)],
      },
    };
    expect(
      lockedPeriodRequestToBatchInput(storedLockedPeriodRequestSchema.parse(olderRow), LIVE),
    ).toBeNull();
  });
});

describe("the officer's card reads a decided request without the live rows (#4157)", () => {
  // Snapshot: Gap held 10 and 12 June. Since the decision the guest's live
  // rows hold every night (a later edit, or an approval before this release
  // that filled the gap): reading them for a decided row would call the
  // range unchanged with no gap.
  const request = {
    original: {
      checkIn: "2026-06-10",
      checkOut: "2026-06-13",
      guests: [{ ...snapshotGuest("gap", GAPPED), firstName: "Gap", lastName: "Guest" }],
    },
    requested: { guestStayRanges: [{ guestId: "gap", ...REPEATED }] },
  };
  const live = [liveGuest("gap", EVERY)];
  const card = (status: string, requestedChanges: unknown = request) =>
    describeRequestedGuestNights(requestedChanges, { status, guests: live })[0];
  const KEPT = {
    runs: [
      { firstNight: "2026-06-10", lastNight: "2026-06-10" },
      { firstNight: "2026-06-12", lastNight: "2026-06-12" },
    ],
    nightCount: 2,
    unchanged: true,
    fillsGaps: false,
  };

  it("reads a pending request against the live rows it is given", () => {
    // Every night held now: the range is applied by its bounds, no change.
    expect(card("REQUESTED")).toMatchObject({ nightCount: 3, unchanged: true });
  });

  it("reads a declined request against its snapshot, never the live rows", () => {
    expect(card("REJECTED"), "INV-REQ-012: a declined row reads its snapshot").toMatchObject(KEPT);
  });

  it("reads an approval without a record as asked, never the live rows", () => {
    expect(card("APPROVED"), "INV-REQ-012: an unrecorded approval is not reread").toMatchObject({
      nightCount: 3,
      unchanged: false,
      fillsGaps: false,
    });
  });

  it("reads an approval with a record exactly as recorded", () => {
    const recorded = { ...request, keptNights: [{ guestId: "gap", nights: GAPPED }] };
    expect(card("APPROVED", recorded), "INV-REQ-012: a recorded approval kept them").toMatchObject(KEPT);
  });

  it("reads the record itself, not the snapshot, where the snapshot holds no nights", () => {
    // Sent before #4088: the snapshot has the guest's dates and no night rows,
    // so only the record can say the approval kept 10 and 12 June.
    const unsnapshotted = {
      ...request,
      original: { ...request.original, guests: [{ ...snapshotGuest("gap", undefined), firstName: "Gap", lastName: "Guest" }] },
      keptNights: [{ guestId: "gap", nights: GAPPED }],
    };
    expect(card("APPROVED", unsnapshotted), "INV-REQ-012: the record is what was kept").toMatchObject(KEPT);
  });
});

describe("a request that names one guest more than once (#4157)", () => {
  // The submission schema accepts duplicate guest ids, and the planner applies
  // the LAST entry for a guest. The kept nights belong to that entry alone: an
  // earlier repeat must never overwrite a later night set or moved range.
  const EXPLICIT = ["2026-06-11", "2026-06-12"];
  const repeatThen = (later: Record<string, unknown>) =>
    stored({
      addGuests: [ADD_FRIEND],
      guestStayRanges: [
        { guestId: "gap", ...REPEATED },
        { guestId: "gap", ...later },
      ],
    });

  it("repeat then night set: the night set is applied as sent, nothing kept", () => {
    const request = repeatThen({ nights: EXPLICIT });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges, "INV-REQ-012: only the applied entry may keep nights").toEqual([
      { guestId: "gap", ...REPEATED },
      { guestId: "gap", stayStart: null, stayEnd: null, nights: EXPLICIT },
    ]);
    expect(plannedNights(input!)).toMatchObject({ gap: EXPLICIT });
    expect(keptNightsByGuest(request, LIVE.guests)).toEqual(new Map());
  });

  it("repeat then moved range: the moved range is applied as sent, nothing kept", () => {
    const request = repeatThen({ stayStart: "2026-06-11", stayEnd: "2026-06-13" });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges, "INV-REQ-012: only the applied entry may keep nights").toEqual([
      { guestId: "gap", ...REPEATED },
      { guestId: "gap", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
    ]);
    expect(plannedNights(input!)).toMatchObject({ gap: ["2026-06-11", "2026-06-12"] });
    expect(keptNightsByGuest(request, LIVE.guests)).toEqual(new Map());
  });

  it("moved range then repeat: the repeat is applied, and keeps the nights on that entry only", () => {
    const request = stored({
      addGuests: [ADD_FRIEND],
      guestStayRanges: [
        { guestId: "gap", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
        { guestId: "gap", ...REPEATED },
      ],
    });
    const input = lockedPeriodRequestToBatchInput(request, LIVE);
    expect(input?.guestStayRanges).toEqual([
      { guestId: "gap", stayStart: "2026-06-11", stayEnd: "2026-06-13" },
      { guestId: "gap", ...REPEATED, nights: GAPPED },
    ]);
    expect(plannedNights(input!)).toMatchObject({ gap: GAPPED });
    expect(keptNightsByGuest(request, LIVE.guests)).toEqual(new Map([["gap", GAPPED]]));
  });

  it("the card lists the guest once, as the applied entry reads", () => {
    const card = (later: Record<string, unknown>) =>
      describeRequestedGuestNights(
        {
          original: {
            checkIn: "2026-06-10",
            checkOut: "2026-06-13",
            guests: [{ ...snapshotGuest("gap", GAPPED), firstName: "Gap", lastName: "Guest" }],
          },
          requested: { guestStayRanges: [{ guestId: "gap", ...REPEATED }, { guestId: "gap", ...later }] },
        },
        { status: "REQUESTED", guests: LIVE.guests },
      );
    expect(card({ nights: EXPLICIT }), "INV-REQ-012: the card reads the applied entry").toEqual([
      {
        name: "Gap Guest",
        runs: [{ firstNight: "2026-06-11", lastNight: "2026-06-12" }],
        nightCount: 2,
        added: false,
        unchanged: false,
        fillsGaps: false,
      },
    ]);
    // The moved range puts the guest on the 11th, inside their stored gap.
    expect(card({ stayStart: "2026-06-11", stayEnd: "2026-06-13" })).toEqual([
      {
        name: "Gap Guest",
        runs: [{ firstNight: "2026-06-11", lastNight: "2026-06-12" }],
        nightCount: 2,
        added: false,
        unchanged: false,
        fillsGaps: true,
      },
    ]);
  });
});

describe("whether a request names a change, judged on each guest's applied entry (#4157)", () => {
  // An earlier entry that moves the guest, then a last entry that only repeats
  // their dates: the planner applies the last, so the guest's dates do not
  // change, and the request names no change for them.
  const moved = { guestId: "full", stayStart: "2026-06-10", stayEnd: "2026-06-12" };
  const repeat = { guestId: "full", ...REPEATED };

  it("at submit: an earlier differing entry the planner ignores is not a change", () => {
    expect(
      namesStayRangeChange([moved, repeat], LIVE.guests),
      "INV-REQ-012: only the applied entry names a change",
    ).toBe(false);
    // The other way round the moved range is applied, and is a change.
    expect(namesStayRangeChange([repeat, moved], LIVE.guests)).toBe(true);
    // A last entry with no dates is not applied, so the moved one before it is.
    expect(namesStayRangeChange([moved, { guestId: "full" }], LIVE.guests)).toBe(true);
  });

  it("on approval: the stored request names no change, and approval has nothing to apply", () => {
    const repeatsOnly = {
      original: {
        checkIn: "2026-06-10",
        checkOut: "2026-06-13",
        guests: [snapshotGuest("full", EVERY)],
      },
      requested: { guestStayRanges: [moved, repeat] },
    };
    expect(storedRequestNamesNoChange(repeatsOnly, LIVE), "INV-REQ-012: only the applied entry names a change").toBe(
      true,
    );
    expect(lockedPeriodRequestToBatchInput(storedLockedPeriodRequestSchema.parse(repeatsOnly), LIVE)).toBeNull();
    const reversed = { ...repeatsOnly, requested: { guestStayRanges: [repeat, moved] } };
    expect(storedRequestNamesNoChange(reversed, LIVE)).toBe(false);
  });
});
