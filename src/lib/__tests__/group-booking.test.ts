import { describe, expect, it } from "vitest";
import { AgeTier, GroupBookingPaymentMode, GroupBookingStatus } from "@prisma/client";
import {
  generateGroupBookingCode,
  isGroupJoinable,
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

describe("toGroupBookingSummary", () => {
  const baseRecord: GroupBookingRecordForSummary = {
    joinCode: "ABCD2345",
    status: GroupBookingStatus.OPEN,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    joinDeadline: null,
    organiserBooking: {
      checkIn: new Date("2026-07-01T00:00:00Z"),
      checkOut: new Date("2026-07-03T00:00:00Z"),
    },
    organiserMember: { firstName: "Andy" },
  };

  it("exposes only public-safe fields", () => {
    const summary = toGroupBookingSummary(baseRecord);
    expect(summary).toEqual({
      code: "ABCD2345",
      status: GroupBookingStatus.OPEN,
      paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
      organiserFirstName: "Andy",
      checkIn: baseRecord.organiserBooking.checkIn,
      checkOut: baseRecord.organiserBooking.checkOut,
      joinDeadline: null,
      isJoinable: true,
    });
    // No leaking of internal identifiers or member contact details.
    expect(summary).not.toHaveProperty("organiserBookingId");
    expect(summary).not.toHaveProperty("organiserMemberId");
  });

  it("reflects joinability for a closed group", () => {
    const summary = toGroupBookingSummary({
      ...baseRecord,
      status: GroupBookingStatus.CLOSED,
    });
    expect(summary.isJoinable).toBe(false);
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
