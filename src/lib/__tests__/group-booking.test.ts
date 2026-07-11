import { describe, expect, it } from "vitest";
import {
  AgeTier,
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";
import {
  generateGroupBookingCode,
  hasGroupStayFullyEnded,
  isGroupJoinable,
  isOrganiserBookingActive,
  normaliseJoinCode,
  parseNonMemberJoinGuests,
  toGroupBookingSummary,
  type GroupBookingRecordForSummary,
} from "@/lib/group-booking";

describe("generateGroupBookingCode", () => {
  it("generates an 8-character code from the unambiguous charset", () => {
    const code = generateGroupBookingCode();
    expect(code).toHaveLength(8);
    // Only uppercase letters/digits, and never the ambiguous I, L, O, 0, 1.
    expect(code).toMatch(/^[A-Z2-9]+$/);
    expect(code).not.toMatch(/[ILO01]/);
  });

  it("generates distinct codes across many calls", () => {
    const codes = new Set(
      Array.from({ length: 1000 }, () => generateGroupBookingCode())
    );
    // Collisions across 1000 draws from ~8.5e11 codes are vanishingly unlikely.
    expect(codes.size).toBe(1000);
  });
});

describe("normaliseJoinCode", () => {
  it("trims, uppercases, and strips spaces and dashes", () => {
    expect(normaliseJoinCode("  ab cd-23  ")).toBe("ABCD23");
    expect(normaliseJoinCode("abcd2345")).toBe("ABCD2345");
    expect(normaliseJoinCode("AB-CD-23-45")).toBe("ABCD2345");
  });

  it("returns an empty string for blank input", () => {
    expect(normaliseJoinCode("   ")).toBe("");
  });
});

describe("isGroupJoinable", () => {
  const now = new Date("2026-06-16T00:00:00Z");

  it("is joinable when OPEN with no deadline", () => {
    expect(
      isGroupJoinable({ status: GroupBookingStatus.OPEN, joinDeadline: null }, now)
    ).toBe(true);
  });

  it("is joinable when OPEN with a future deadline", () => {
    expect(
      isGroupJoinable(
        {
          status: GroupBookingStatus.OPEN,
          joinDeadline: new Date("2026-06-20T00:00:00Z"),
        },
        now
      )
    ).toBe(true);
  });

  it("is not joinable when OPEN but the deadline has passed", () => {
    expect(
      isGroupJoinable(
        {
          status: GroupBookingStatus.OPEN,
          joinDeadline: new Date("2026-06-10T00:00:00Z"),
        },
        now
      )
    ).toBe(false);
  });

  it("is not joinable when CLOSED or CANCELLED", () => {
    expect(
      isGroupJoinable(
        { status: GroupBookingStatus.CLOSED, joinDeadline: null },
        now
      )
    ).toBe(false);
    expect(
      isGroupJoinable(
        { status: GroupBookingStatus.CANCELLED, joinDeadline: null },
        now
      )
    ).toBe(false);
  });
});

describe("isOrganiserBookingActive", () => {
  it("is active for live host statuses", () => {
    for (const status of [
      BookingStatus.PAID,
      BookingStatus.CONFIRMED,
      BookingStatus.PAYMENT_PENDING,
    ]) {
      expect(isOrganiserBookingActive({ status, deletedAt: null })).toBe(true);
    }
  });

  it("is inactive when cancelled, bumped or soft-deleted", () => {
    expect(
      isOrganiserBookingActive({ status: BookingStatus.CANCELLED, deletedAt: null })
    ).toBe(false);
    expect(
      isOrganiserBookingActive({ status: BookingStatus.BUMPED, deletedAt: null })
    ).toBe(false);
    expect(
      isOrganiserBookingActive({
        status: BookingStatus.PAID,
        deletedAt: new Date("2026-06-01T00:00:00Z"),
      })
    ).toBe(false);
  });
});

describe("hasGroupStayFullyEnded", () => {
  // Booking dates are NZ date-only lodge nights stored as UTC midnights; the
  // helper derives "today" from `now` in the NZ time zone. All instants here
  // are fixed — never real-now-dependent fixtures.
  const checkOut = new Date("2026-06-17T00:00:00Z");

  it("has ended when the stay checks out today (matches the unpaid-finished-stays cutoff)", () => {
    // Midday NZST on the check-out day itself.
    expect(
      hasGroupStayFullyEnded({ checkOut }, new Date("2026-06-17T00:00:00Z"))
    ).toBe(true);
  });

  it("has ended once the check-out day is in the past", () => {
    expect(
      hasGroupStayFullyEnded({ checkOut }, new Date("2026-06-20T00:00:00Z"))
    ).toBe(true);
  });

  it("has not ended while the stay checks out tomorrow", () => {
    expect(
      hasGroupStayFullyEnded({ checkOut }, new Date("2026-06-16T00:00:00Z"))
    ).toBe(false);
  });

  it("uses the NZ calendar day, not the UTC day, of `now`", () => {
    // 2026-06-16T13:00Z is 01:00 NZST on the 17th: still the 16th in UTC, but
    // the NZ day has rolled over, so a stay checking out on the 17th has ended.
    expect(
      hasGroupStayFullyEnded({ checkOut }, new Date("2026-06-16T13:00:00Z"))
    ).toBe(true);
    // 2026-06-16T11:00Z is 23:00 NZST on the 16th: not yet the check-out day.
    expect(
      hasGroupStayFullyEnded({ checkOut }, new Date("2026-06-16T11:00:00Z"))
    ).toBe(false);
  });
});

describe("toGroupBookingSummary", () => {
  // Fixed evaluation instant well before the fixture's check-out, so the
  // ended-stay exclusion (#1723 path 3) never depends on the real clock.
  const now = new Date("2026-06-16T00:00:00Z");
  const baseRecord: GroupBookingRecordForSummary = {
    joinCode: "ABCD2345",
    status: GroupBookingStatus.OPEN,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    joinDeadline: null,
    organiserBooking: {
      checkIn: new Date("2026-07-01T00:00:00Z"),
      checkOut: new Date("2026-07-03T00:00:00Z"),
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
      lodge: { name: "West Ridge Hut" },
    },
    organiserMember: { firstName: "Andy" },
  };

  it("exposes only public-safe fields", () => {
    const summary = toGroupBookingSummary(baseRecord, now);
    expect(summary).toEqual({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserFirstName: "Andy",
      // The group's actual lodge (organiser booking's lodge), so public join
      // copy names the right property in a multi-lodge club (#11).
      lodgeName: "West Ridge Hut",
      checkIn: baseRecord.organiserBooking.checkIn,
      checkOut: baseRecord.organiserBooking.checkOut,
      joinDeadline: null,
      isJoinable: true,
    });
    // No leaking of internal identifiers or member contact details.
    expect(summary).not.toHaveProperty("organiserBookingId");
    expect(summary).not.toHaveProperty("organiserMemberId");
    // The lodge id (internal) is never exposed — only the display name.
    expect(summary).not.toHaveProperty("lodgeId");
  });

  it("reflects joinability for a closed group", () => {
    const summary = toGroupBookingSummary(
      {
        ...baseRecord,
        status: GroupBookingStatus.CLOSED,
      },
      now,
    );
    expect(summary.isJoinable).toBe(false);
  });

  it("is not joinable when the host booking is no longer active", () => {
    const cancelledHost = toGroupBookingSummary(
      {
        ...baseRecord,
        organiserBooking: { ...baseRecord.organiserBooking, status: BookingStatus.CANCELLED },
      },
      now,
    );
    expect(cancelledHost.isJoinable).toBe(false);

    const deletedHost = toGroupBookingSummary(
      {
        ...baseRecord,
        organiserBooking: {
          ...baseRecord.organiserBooking,
          deletedAt: new Date("2026-06-01T00:00:00Z"),
        },
      },
      now,
    );
    expect(deletedHost.isJoinable).toBe(false);
  });

  it("is not joinable once the group's stay has fully ended (#1723 path 3)", () => {
    // The fixture checks out on 2026-07-03; from that NZ day onward the group
    // leaves the joinable set even while OPEN with an active host booking.
    const onCheckOutDay = toGroupBookingSummary(
      baseRecord,
      new Date("2026-07-03T00:00:00Z"),
    );
    expect(onCheckOutDay.isJoinable).toBe(false);

    const wellAfter = toGroupBookingSummary(
      baseRecord,
      new Date("2026-08-01T00:00:00Z"),
    );
    expect(wellAfter.isJoinable).toBe(false);
  });
});

describe("parseNonMemberJoinGuests", () => {
  it("parses a valid guest snapshot and trims names", () => {
    const guests = parseNonMemberJoinGuests([
      { firstName: " Sam ", lastName: " Tane ", ageTier: AgeTier.ADULT },
      { firstName: "Kit", lastName: "Rua", ageTier: AgeTier.CHILD },
    ]);
    expect(guests).toEqual([
      { firstName: "Sam", lastName: "Tane", ageTier: AgeTier.ADULT },
      { firstName: "Kit", lastName: "Rua", ageTier: AgeTier.CHILD },
    ]);
  });

  it("rejects the whole snapshot if any entry is malformed", () => {
    // Unknown age tier.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "Tane", ageTier: "SENIOR_WIZARD" },
      ])
    ).toEqual([]);
    // Missing required name.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "", ageTier: AgeTier.ADULT },
      ])
    ).toEqual([]);
    // A non-object entry poisons the batch.
    expect(
      parseNonMemberJoinGuests([
        { firstName: "Sam", lastName: "Tane", ageTier: AgeTier.ADULT },
        "not-an-object",
      ])
    ).toEqual([]);
  });

  it("returns an empty array for non-array or null input", () => {
    expect(parseNonMemberJoinGuests(null)).toEqual([]);
    expect(parseNonMemberJoinGuests(undefined)).toEqual([]);
    expect(parseNonMemberJoinGuests({ firstName: "Sam" })).toEqual([]);
    expect(parseNonMemberJoinGuests([])).toEqual([]);
  });
});
