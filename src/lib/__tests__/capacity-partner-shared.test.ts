import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import { checkCapacityForPartnerSharedAdmission } from "@/lib/capacity";
import { getLodgePartnerSharedCapacityStatus } from "@/lib/lodge-capacity";

// Everything runs through an explicit fake transaction client, so no module
// mock is needed: getLodgePartnerSharedCapacityStatus, mayShareDoubleBed and
// the occupancy/coverage queries all receive this db.
const LODGE = "lodge-a";
const SHARER = "member-sharer";
const PARTNER = "member-partner";

const CHECK_IN = parseDateOnly("2026-08-10");
const CHECK_OUT = parseDateOnly("2026-08-12"); // two nights: 10th + 11th

type FakeDbOptions = {
  beds?: number;
  doubles?: number;
  capacityOverride?: number | null;
  // Existing occupancy: bookings with per-guest envelopes.
  bookings?: Array<{
    checkIn: Date;
    checkOut: Date;
    guests: Array<{ stayStart: Date; stayEnd: Date }>;
  }>;
  // Partner coverage rows returned for the bookingGuest query.
  partnerGuestRows?: Array<{
    stayStart: Date;
    stayEnd: Date;
    nights: never[];
    booking: { checkIn: Date; checkOut: Date };
  }>;
  partnerLinkStatus?: string | null;
  membersActive?: boolean;
};

function fakeDb(options: FakeDbOptions = {}) {
  const {
    beds = 4,
    doubles = 1,
    capacityOverride = null,
    bookings = [],
    partnerGuestRows = [],
    partnerLinkStatus = "CONFIRMED",
    membersActive = true,
  } = options;

  return {
    clubModuleSettings: {
      findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
    },
    lodgeBed: {
      count: vi.fn(
        async (args: { where: { bedType?: string } }) =>
          args.where.bedType === "DOUBLE" ? doubles : beds,
      ),
    },
    ...(capacityOverride === null
      ? {}
      : {
          lodgeSettings: {
            findUnique: vi.fn(async (args: { where: { id: string } }) =>
              args.where.id === LODGE ? { capacity: capacityOverride } : null,
            ),
          },
        }),
    booking: {
      findMany: vi.fn().mockResolvedValue(bookings),
    },
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(partnerGuestRows),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        { id: SHARER, ageTier: "ADULT", active: membersActive },
        { id: PARTNER, ageTier: "ADULT", active: membersActive },
      ]),
    },
    memberPartnerLink: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          partnerLinkStatus ? { status: partnerLinkStatus } : null,
        ),
    },
  } as never;
}

function nightGuests(count: number) {
  return Array.from({ length: count }, () => ({
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
  }));
}

function fullStayBooking(guestCount: number) {
  return {
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    guests: nightGuests(guestCount),
  };
}

const sharerFullStay = {
  range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
  memberId: SHARER,
  partnerMemberId: PARTNER,
};

const partnerCoverageFullStay = [
  {
    stayStart: CHECK_IN,
    stayEnd: CHECK_OUT,
    nights: [] as never[],
    booking: { checkIn: CHECK_IN, checkOut: CHECK_OUT },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getLodgePartnerSharedCapacityStatus", () => {
  it("grants one slot per active DOUBLE with no explicit capacity", async () => {
    const db = fakeDb({ beds: 10, doubles: 2 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 10,
      source: "configured_beds",
      activeDoubleBedCount: 2,
      partnerSharedHeadroom: 2,
    });
  });

  it("bounds headroom by an explicit capacity between beds and beds+doubles", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 11 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 10,
      source: "configured_beds",
      partnerSharedHeadroom: 1,
    });
  });

  it("grants no headroom when the explicit capacity equals the bed count", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 10 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status.partnerSharedHeadroom).toBe(0);
  });

  it("grants no headroom on a capped lodge (people ceiling binds, #1653)", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 8 });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      capacity: 8,
      source: "capped_beds",
      activeDoubleBedCount: 0,
      partnerSharedHeadroom: 0,
    });
  });

  it("grants no headroom when the bed allocation module is off", async () => {
    const db = fakeDb({ beds: 10, doubles: 2, capacityOverride: 30 });
    (db as { clubModuleSettings: { findUnique: ReturnType<typeof vi.fn> } })
      .clubModuleSettings.findUnique.mockResolvedValue({ bedAllocation: false });
    const status = await getLodgePartnerSharedCapacityStatus(LODGE, db);
    expect(status).toMatchObject({
      source: "capacity_override",
      activeDoubleBedCount: 0,
      partnerSharedHeadroom: 0,
    });
  });
});

describe("checkCapacityForPartnerSharedAdmission", () => {
  it("admits a partner-sharer when the lodge is full by beds", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.partnerSharedHeadroom).toBe(1);
    expect(result.nightDetails.every((n) => n.sharedSlotsNeeded === 1)).toBe(
      true,
    );
  });

  it("rejects a partner-sharer once every shared slot is taken", async () => {
    // 5 existing guests over a base of 4: one shared slot already consumed.
    const db = fakeDb({
      bookings: [fullStayBooking(5)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/partner-shared double-bed slots are taken/i);
    expect(result.nightDetails[0]).toMatchObject({
      sharedSlotsUsed: 1,
      sharedSlotsNeeded: 1,
    });
  });

  it("rejects a pair without a confirmed partner link outright", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(3)],
      partnerGuestRows: partnerCoverageFullStay,
      partnerLinkStatus: "PENDING",
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/confirmed partner relationship/i);
  });

  it("never admits an ordinary guest into partner headroom", async () => {
    const db = fakeDb({ bookings: [fullStayBooking(4)] });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT }],
      [],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/fully booked/i);
  });

  it("lets a sharer take a free base slot before consuming shared slots", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(3)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.every((n) => n.sharedSlotsNeeded === 0)).toBe(
      true,
    );
  });

  it("handles nights that are only partially full", async () => {
    // Night 1 full (4), night 2 has a free bed (3).
    const db = fakeDb({
      bookings: [
        fullStayBooking(3),
        {
          checkIn: CHECK_IN,
          checkOut: parseDateOnly("2026-08-11"),
          guests: [
            { stayStart: CHECK_IN, stayEnd: parseDateOnly("2026-08-11") },
          ],
        },
      ],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.map((n) => n.sharedSlotsNeeded)).toEqual([1, 0]);
  });

  it("rejects when the partner is not staying every requested night", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: [
        {
          stayStart: CHECK_IN,
          stayEnd: parseDateOnly("2026-08-11"),
          nights: [],
          booking: { checkIn: CHECK_IN, checkOut: parseDateOnly("2026-08-11") },
        },
      ],
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/not staying on every night/i);
  });

  it("anchors same-proposal coverage to a proposed guest carrying the partner's memberId", async () => {
    // The sharer joins the partner's own booking: the booking is excluded
    // from occupancy and its guests re-proposed, the partner row tagged with
    // their memberId. 3 occupied + the partner = base full; sharer shares.
    const db = fakeDb({ bookings: [fullStayBooking(3)] });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [{ stayStart: CHECK_IN, stayEnd: CHECK_OUT, memberId: PARTNER }],
      [sharerFullStay],
      "booking-being-modified",
      db,
    );

    expect(result.available).toBe(true);
    expect(
      (db as { bookingGuest: { findMany: ReturnType<typeof vi.fn> } })
        .bookingGuest.findMany,
    ).not.toHaveBeenCalled();
  });

  it("rejects a couple encoded as two mutual sharers (no base-backed anchor)", async () => {
    const db = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [
        sharerFullStay,
        {
          range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
          memberId: PARTNER,
          partnerMemberId: SHARER,
        },
      ],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/must hold an ordinary place/i);
  });

  it("rejects the same sharer proposed twice", async () => {
    const db = fakeDb({
      bookings: [],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay, { ...sharerFullStay }],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/more than once/i);
  });

  it("admits sharers up to the double count, then rejects the next", async () => {
    // 2 doubles → headroom 2. Base full at 4. Coverage rows satisfy every
    // partner (the coverage mock is per-query, not per-member).
    const makeSharer = (index: number) => ({
      range: { stayStart: CHECK_IN, stayEnd: CHECK_OUT },
      memberId: `sharer-${index}`,
      partnerMemberId: `partner-${index}`,
    });

    const two = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [makeSharer(1), makeSharer(2)],
      undefined,
      fakeDb({
        doubles: 2,
        bookings: [fullStayBooking(4)],
        partnerGuestRows: partnerCoverageFullStay,
      }),
    );
    expect(two.available).toBe(true);
    expect(two.nightDetails.every((n) => n.sharedSlotsNeeded === 2)).toBe(true);

    const three = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [makeSharer(1), makeSharer(2), makeSharer(3)],
      undefined,
      fakeDb({
        doubles: 2,
        bookings: [fullStayBooking(4)],
        partnerGuestRows: partnerCoverageFullStay,
      }),
    );
    expect(three.available).toBe(false);
    expect(three.reason).toMatch(/slots are taken/i);
  });

  it("keeps reserved-slot accounting correct after a #1756 stale-pair sweep", async () => {
    // The sweep deletes the pair's BedAllocation placement but deliberately
    // NOT the second occupant's BookingGuest row, and shared-slot accounting
    // is occupancy-derived (guest-nights above base) — never allocation-
    // derived. So post-sweep, while the swept guest still sits on their
    // booking in the awaiting-allocation queue, the slot they mis-held stays
    // visibly consumed: a NEW couple must be refused (no phantom double-grant
    // of the reserved slot), exactly the conservative #1668-style treatment.
    // Base 4 + 1 double; 5 guest-nights = base full + the swept guest still
    // occupying the lodge's only shared slot.
    const occupiedPostSweep = fakeDb({
      bookings: [fullStayBooking(5)],
      partnerGuestRows: partnerCoverageFullStay,
    });
    const refused = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      occupiedPostSweep,
    );
    expect(refused.available).toBe(false);
    expect(refused.nightDetails[0]).toMatchObject({ sharedSlotsUsed: 1 });
    // The headroom resolver reads bed inventory + ceiling only — untouched by
    // any BedAllocation delete, so the sweep cannot corrupt it.
    expect(refused.partnerSharedHeadroom).toBe(1);

    // Once the admin resolves the queue entry (removes the swept guest from
    // the booking), the occupancy drops back to base and the reserved slot
    // frees for the next couple.
    const resolvedPostSweep = fakeDb({
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });
    const admitted = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      resolvedPostSweep,
    );
    expect(admitted.available).toBe(true);
    expect(
      admitted.nightDetails.every(
        (night) => night.sharedSlotsUsed === 0 && night.sharedSlotsNeeded === 1,
      ),
    ).toBe(true);
  });

  it("rejects a sharer when the lodge has no shareable doubles", async () => {
    const db = fakeDb({
      doubles: 0,
      bookings: [fullStayBooking(4)],
      partnerGuestRows: partnerCoverageFullStay,
    });

    const result = await checkCapacityForPartnerSharedAdmission(
      LODGE,
      CHECK_IN,
      CHECK_OUT,
      [],
      [sharerFullStay],
      undefined,
      db,
    );

    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/no shareable double beds/i);
  });
});
