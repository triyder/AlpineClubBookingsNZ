import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Cross-lodge waitlist opt-in, create side (ADR-004): the waitlist create
// path validates alternate lodges (active, distinct from the primary,
// member-eligible) and persists BookingWaitlistAlternateLodge rows inside
// the same transaction as the WAITLISTED booking.

const mocks = vi.hoisted(() => ({
  lodgeFindUnique: vi.fn(),
  lodgeCount: vi.fn(),
  memberLodgeAccessFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findUnique: mocks.lodgeFindUnique,
      count: mocks.lodgeCount,
    },
    memberLodgeAccess: {
      findMany: mocks.memberLodgeAccessFindMany,
    },
  },
}));

import {
  BookingLodgeError,
  createWaitlistedBooking,
  resolveWaitlistAlternateLodgeIds,
  type WaitlistedBookingInput,
} from "@/lib/booking-create";
import { LodgeBookingEligibilityError } from "@/lib/lodge-access";

const db = {
  lodge: { count: mocks.lodgeCount },
  memberLodgeAccess: { findMany: mocks.memberLodgeAccessFindMany },
} as never;

describe("resolveWaitlistAlternateLodgeIds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memberLodgeAccessFindMany.mockResolvedValue([]);
  });

  it("returns an empty list when nothing was requested", async () => {
    expect(
      await resolveWaitlistAlternateLodgeIds(db, {
        requestedAlternateLodgeIds: undefined,
        primaryLodgeId: "lodge-1",
        memberId: "member-1",
        isOnBehalf: false,
      }),
    ).toEqual([]);
    expect(
      await resolveWaitlistAlternateLodgeIds(db, {
        requestedAlternateLodgeIds: [],
        primaryLodgeId: "lodge-1",
        memberId: "member-1",
        isOnBehalf: false,
      }),
    ).toEqual([]);
    expect(mocks.lodgeCount).not.toHaveBeenCalled();
  });

  it("drops duplicates and the primary lodge before validating", async () => {
    mocks.lodgeCount.mockResolvedValue(1);

    const resolved = await resolveWaitlistAlternateLodgeIds(db, {
      requestedAlternateLodgeIds: ["lodge-2", "lodge-2", "lodge-1"],
      primaryLodgeId: "lodge-1",
      memberId: "member-1",
      isOnBehalf: false,
    });

    expect(resolved).toEqual(["lodge-2"]);
    expect(mocks.lodgeCount).toHaveBeenCalledWith({
      where: { id: { in: ["lodge-2"] }, active: true },
    });
  });

  it("collapses to empty when only the primary lodge was requested", async () => {
    const resolved = await resolveWaitlistAlternateLodgeIds(db, {
      requestedAlternateLodgeIds: ["lodge-1"],
      primaryLodgeId: "lodge-1",
      memberId: "member-1",
      isOnBehalf: false,
    });

    expect(resolved).toEqual([]);
    expect(mocks.lodgeCount).not.toHaveBeenCalled();
  });

  it("rejects an unknown or inactive alternate lodge", async () => {
    mocks.lodgeCount.mockResolvedValue(1);

    await expect(
      resolveWaitlistAlternateLodgeIds(db, {
        requestedAlternateLodgeIds: ["lodge-2", "lodge-gone"],
        primaryLodgeId: "lodge-1",
        memberId: "member-1",
        isOnBehalf: false,
      }),
    ).rejects.toThrow(BookingLodgeError);
  });

  it("rejects an alternate the member is restricted from booking", async () => {
    mocks.lodgeCount.mockResolvedValue(1);
    // Restriction rows exist and none names lodge-2, so lodge-2 is
    // ineligible (default-open only without restriction rows).
    mocks.memberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-1" },
    ]);

    await expect(
      resolveWaitlistAlternateLodgeIds(db, {
        requestedAlternateLodgeIds: ["lodge-2"],
        primaryLodgeId: "lodge-1",
        memberId: "member-1",
        isOnBehalf: false,
      }),
    ).rejects.toThrow(LodgeBookingEligibilityError);
  });

  it("bypasses the eligibility restriction for admin on-behalf entries", async () => {
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.memberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-1" },
    ]);

    const resolved = await resolveWaitlistAlternateLodgeIds(db, {
      requestedAlternateLodgeIds: ["lodge-2"],
      primaryLodgeId: "lodge-1",
      memberId: "member-1",
      isOnBehalf: true,
    });

    expect(resolved).toEqual(["lodge-2"]);
    // On-behalf must not even read the restriction rows (same contract as
    // assertMemberMayBookLodge).
    expect(mocks.memberLodgeAccessFindMany).not.toHaveBeenCalled();
  });
});

describe("createWaitlistedBooking alternate-lodge validation", () => {
  const baseInput = {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-12"),
    guests: [
      { firstName: "Alice", lastName: "Smith", ageTier: "ADULT", isMember: true },
    ],
  } as unknown as WaitlistedBookingInput;

  beforeEach(() => {
    vi.clearAllMocks();
    // Primary lodge resolves and the member has no restrictions.
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-1", active: true });
    mocks.memberLodgeAccessFindMany.mockResolvedValue([]);
  });

  it("rejects before writing anything when an alternate lodge is unknown", async () => {
    mocks.lodgeCount.mockResolvedValue(0);

    await expect(
      createWaitlistedBooking({
        ...baseInput,
        lodgeId: "lodge-1",
        alternateLodgeIds: ["lodge-gone"],
      }),
    ).rejects.toThrow("Unknown or inactive alternate lodgeId");
  });

  it("rejects before writing anything when the member is restricted from an alternate", async () => {
    mocks.lodgeCount.mockResolvedValue(1);
    mocks.memberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-1" },
    ]);

    await expect(
      createWaitlistedBooking({
        ...baseInput,
        lodgeId: "lodge-1",
        alternateLodgeIds: ["lodge-2"],
      }),
    ).rejects.toThrow(LodgeBookingEligibilityError);
  });
});

describe("cross-lodge waitlist create source contract", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/lib/booking-create.ts"),
    "utf8",
  );

  it("persists the alternate-lodge junction rows inside the waitlist transaction", () => {
    const fnStart = source.indexOf(
      "export async function createWaitlistedBooking",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const block = source.slice(fnStart);
    const txStart = block.indexOf("prisma.$transaction");
    const junctionWrite = block.indexOf(
      "tx.bookingWaitlistAlternateLodge.createMany",
    );
    expect(txStart).toBeGreaterThan(-1);
    // The junction write happens through the transaction client, after the
    // transaction opens — never via the base client outside it.
    expect(junctionWrite).toBeGreaterThan(txStart);
    expect(block).not.toContain(
      "prisma.bookingWaitlistAlternateLodge.createMany",
    );
  });

  it("validates alternates before the transaction begins", () => {
    const fnStart = source.indexOf(
      "export async function createWaitlistedBooking",
    );
    const block = source.slice(fnStart);
    const validation = block.indexOf("resolveWaitlistAlternateLodgeIds");
    const txStart = block.indexOf("prisma.$transaction");
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(txStart);
  });
});
