import { BookingStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  findBookingMemberNightConflicts,
  MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES,
} from "@/lib/booking-member-night-conflicts";

function existingGuest(overrides: Record<string, unknown> = {}) {
  return {
    id: "guest-1",
    memberId: "member-1",
    firstName: "Alice",
    lastName: "Smith",
    stayStart: null,
    stayEnd: null,
    nights: [],
    member: { firstName: "Alice", lastName: "Smith" },
    booking: {
      id: "booking-1",
      memberId: "member-1",
      status: BookingStatus.DRAFT,
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      member: { firstName: "Alice", lastName: "Smith" },
      guests: [
        { id: "guest-1", memberId: "member-1" },
        { id: "guest-2", memberId: "member-2" },
      ],
    },
    ...overrides,
  };
}

function conflictDb(rows: unknown[]) {
  return {
    bookingGuest: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  };
}

describe("findBookingMemberNightConflicts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks a member from being added twice on the same lodge night", async () => {
    const db = conflictDb([existingGuest()]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(conflicts).toEqual([
      expect.objectContaining({
        memberId: "member-1",
        memberName: "Alice Smith",
        bookingId: "booking-1",
        bookingStatus: BookingStatus.DRAFT,
        conflictingNights: ["2026-06-01", "2026-06-02"],
        isOwnBooking: true,
        canOpenBooking: true,
        canSelfRemove: false,
      }),
    ]);
  });

  it("marks a future booking self-guest conflict as self-removable", async () => {
    const db = conflictDb([
      existingGuest({
        id: "guest-2",
        memberId: "member-2",
        firstName: "Bob",
        lastName: "Jones",
        member: { firstName: "Bob", lastName: "Jones" },
        booking: {
          id: "booking-2",
          memberId: "member-1",
          status: BookingStatus.PAYMENT_PENDING,
          checkIn: parseDateOnly("2026-06-10"),
          checkOut: parseDateOnly("2026-06-13"),
          member: { firstName: "Alice", lastName: "Smith" },
          guests: [
            { id: "guest-1", memberId: "member-1" },
            { id: "guest-2", memberId: "member-2" },
          ],
        },
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-2",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-11"),
      checkOut: parseDateOnly("2026-06-12"),
      guests: [{ memberId: "member-2" }],
    });

    expect(conflicts[0]).toMatchObject({
      memberId: "member-2",
      memberName: "Bob Jones",
      bookingId: "booking-2",
      bookingOwnerName: "Alice Smith",
      conflictingNights: ["2026-06-11"],
      isOwnBooking: false,
      canOpenBooking: true,
      canSelfRemove: true,
    });
  });

  it("honors sparse explicit nights before reporting a conflict", async () => {
    const db = conflictDb([
      existingGuest({
        nights: [{ stayDate: parseDateOnly("2026-06-01") }],
      }),
    ]);

    const conflicts = await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [
        {
          memberId: "member-1",
          nights: ["2026-06-02"],
        },
      ],
    });

    expect(conflicts).toEqual([]);
  });

  it("queries only live booking statuses without changing capacity semantics", async () => {
    const db = conflictDb([]);

    await findBookingMemberNightConflicts(db as any, {
      actorMemberId: "member-1",
      actorRole: "USER",
      checkIn: parseDateOnly("2026-06-01"),
      checkOut: parseDateOnly("2026-06-03"),
      guests: [{ memberId: "member-1" }],
    });

    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.DRAFT);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).toContain(BookingStatus.PAYMENT_PENDING);
    expect(MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES).not.toContain(BookingStatus.CANCELLED);
    expect(db.bookingGuest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({
            deletedAt: null,
            status: { in: [...MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES] },
            OR: expect.arrayContaining([
              { status: { not: BookingStatus.DRAFT } },
              { draftExpiresAt: null },
              expect.objectContaining({ draftExpiresAt: expect.any(Object) }),
            ]),
          }),
        }),
      }),
    );
  });
});
