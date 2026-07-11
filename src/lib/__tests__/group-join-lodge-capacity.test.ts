import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BookingStatus,
  GroupBookingPaymentMode,
  GroupBookingStatus,
} from "@prisma/client";

// Regression coverage for the production-readiness review §1.4: the group-join
// guest-cap checks in joinGroupBookingAsMember + createNonMemberJoinRequest now
// size the cap against the GROUP'S lodge capacity, not the club default lodge.
// The real availability check later is lodge-scoped either way (so there was
// never an overbooking risk), but the cap threshold and its error message were
// wrong for non-default lodges. These tests pin that getLodgeCapacity is called
// with the group's own lodgeId and that the default-lodge lookup is skipped
// when the group already carries a lodge.

const mocks = vi.hoisted(() => ({
  groupFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  joinFindFirst: vi.fn(),
  joinCount: vi.fn(),
  getLodgeCapacity: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    groupBooking: { findUnique: mocks.groupFindUnique },
    groupBookingJoin: {
      findFirst: mocks.joinFindFirst,
      count: mocks.joinCount,
    },
    member: {
      findUnique: mocks.memberFindUnique,
      findFirst: mocks.memberFindFirst,
    },
  },
}));

// Partial mock: only override getLodgeCapacity; keep FALLBACK_LODGE_CAPACITY
// et al so other importers (email registry) still resolve.
vi.mock("@/lib/lodge-capacity", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodge-capacity")>(
    "@/lib/lodge-capacity"
  );
  return { ...actual, getLodgeCapacity: mocks.getLodgeCapacity };
});

// Partial mock: keep lodgeNullTolerantScope et al intact; only spy on the
// default-lodge fallback so we can assert the group's lodge is used instead.
vi.mock("@/lib/lodges", async () => {
  const actual = await vi.importActual<typeof import("@/lib/lodges")>(
    "@/lib/lodges"
  );
  return { ...actual, getDefaultLodgeId: mocks.getDefaultLodgeId };
});

vi.mock("@/lib/booking-guests", async () => {
  const actual = await vi.importActual<typeof import("@/lib/booking-guests")>(
    "@/lib/booking-guests"
  );
  return {
    ...actual,
    resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
    assertLinkedBookingMembersCanBeBooked:
      mocks.assertLinkedBookingMembersCanBeBooked,
    normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
  };
});

import {
  createNonMemberJoinRequest,
  joinGroupBookingAsMember,
  GroupBookingError,
} from "@/lib/group-booking";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

// Kept relative to the real clock: the ended-stay gate (#1723 path 3) rejects
// joins once the organiser booking's check-out reaches NZ today, so a
// hardcoded calendar date would rot into "This group's stay has ended"
// failures before these tests ever reach the capacity cap they pin.
const checkIn = addDaysDateOnly(getTodayDateOnly(), 30);
const checkOut = addDaysDateOnly(getTodayDateOnly(), 32);

// The group's booking belongs to lodge-b, whose capacity (4) is smaller than
// the default lodge's, so a 5-guest join must fail against 4 — not against the
// default lodge's number.
const LODGE_B = "lodge-b";
const LODGE_B_CAPACITY = 4;

function activeGroup(lodgeId: string | null) {
  return {
    id: "group-1",
    status: GroupBookingStatus.OPEN,
    joinDeadline: null,
    paymentMode: GroupBookingPaymentMode.EACH_PAYS_OWN,
    maxJoiners: null,
    organiserMemberId: "organiser-1",
    organiserBooking: {
      id: "booking-1",
      lodgeId,
      checkIn,
      checkOut,
      status: BookingStatus.CONFIRMED,
      deletedAt: null,
    },
  };
}

function makeGuests(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    firstName: `Guest${i}`,
    lastName: "Test",
    ageTier: "ADULT" as const,
  }));
}

describe("createNonMemberJoinRequest caps against the group's lodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLodgeCapacity.mockResolvedValue(LODGE_B_CAPACITY);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
  });

  it("sizes the cap with the group's lodge, not the default lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));

    await expect(
      createNonMemberJoinRequest({
        code: "ABCD2345",
        contactFirstName: "Non",
        contactLastName: "Member",
        contactEmail: "non@example.com",
        guests: makeGuests(LODGE_B_CAPACITY + 1),
      })
    ).rejects.toMatchObject({
      message: `A booking cannot exceed ${LODGE_B_CAPACITY} guests`,
    });

    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith(LODGE_B);
    // Group carries its own lodge, so the default-lodge fallback is not used.
    expect(mocks.getDefaultLodgeId).not.toHaveBeenCalled();
  });

  it("falls back to the default lodge only when the group has no lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(null));

    await expect(
      createNonMemberJoinRequest({
        code: "ABCD2345",
        contactFirstName: "Non",
        contactLastName: "Member",
        contactEmail: "non@example.com",
        guests: makeGuests(LODGE_B_CAPACITY + 1),
      })
    ).rejects.toBeInstanceOf(GroupBookingError);

    expect(mocks.getDefaultLodgeId).toHaveBeenCalled();
    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith("lodge-default");
  });
});

describe("joinGroupBookingAsMember caps against the group's lodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getLodgeCapacity.mockResolvedValue(LODGE_B_CAPACITY);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-default");
    mocks.joinFindFirst.mockResolvedValue(null); // no existing join
    mocks.memberFindUnique.mockResolvedValue({ ageTier: "ADULT" });
    // The booking-guests collaborators are exercised only to reach the cap; the
    // cap runs on the normalised guests, so echo them straight through.
    mocks.resolveLinkedBookingMembers.mockResolvedValue([]);
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests: unknown[]) =>
      guests.map((g) => ({ ...(g as object), isMember: true }))
    );
  });

  it("sizes the member-join cap with the group's lodge, not the default lodge", async () => {
    mocks.groupFindUnique.mockResolvedValue(activeGroup(LODGE_B));

    await expect(
      joinGroupBookingAsMember(
        {
          code: "ABCD2345",
          guests: makeGuests(LODGE_B_CAPACITY + 1).map((g) => ({
            ...g,
            memberId: "m-x",
            isMember: true,
          })),
        },
        "joiner-1",
        "MEMBER"
      )
    ).rejects.toMatchObject({
      message: `A booking cannot exceed ${LODGE_B_CAPACITY} guests`,
    });

    expect(mocks.getLodgeCapacity).toHaveBeenCalledWith(LODGE_B);
    expect(mocks.getDefaultLodgeId).not.toHaveBeenCalled();
  });
});
