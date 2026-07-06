import { BookingStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  BED_ALLOCATABLE_BOOKING_STATUSES,
  reconcileBedAllocationsForBooking,
} from "@/lib/bed-allocation-lifecycle";
import { parseDateOnly } from "@/lib/date-only";

function makeDb(overrides: Record<string, unknown> = {}) {
  const db: any = {
    clubModuleSettings: {
      findUnique: vi.fn().mockResolvedValue({ bedAllocation: true }),
    },
    booking: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    bedAllocation: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      // #1387 displacement side effects: MOVE updates a provisional row's
      // bed/room; UNALLOCATE deletes it. updateMany/deleteMany are idempotent.
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    bedAllocationSettings: {
      findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: false }),
    },
    lodgeRoom: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    // #1387 displacement audit trail.
    auditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  // #1387 atomic apply: the lifecycle opens a transaction when the client
  // exposes `$transaction`. Run the callback against this same mock so its
  // updateMany/deleteMany/createMany spies are exercised.
  db.$transaction = vi.fn((cb: (client: unknown) => unknown) => cb(db));
  return db;
}

// Two rooms of two beds each, in sort order Room A (A1, A2), Room B (B1, B2).
// Shared by the #1387 first-claim displacement tests.
const TWO_ROOMS_TWO_BEDS = [
  {
    id: "room-a",
    name: "Room A",
    sortOrder: 1,
    active: true,
    beds: [
      { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
      { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
    ],
  },
  {
    id: "room-b",
    name: "Room B",
    sortOrder: 2,
    active: true,
    beds: [
      { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1, active: true },
      { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2, active: true },
    ],
  },
];

const NIGHT = parseDateOnly("2026-08-01");
const NIGHT_END = parseDateOnly("2026-08-02");
const NIGHT_UTC = new Date("2026-08-01T00:00:00.000Z");

/** An existing BedAllocation row as returned by the lifecycle's findMany. */
function existingAllocation(opts: {
  bedId: string;
  roomId: string;
  bookingId: string;
  bookingGuestId: string;
  status: BookingStatus;
  isRequestConverted?: boolean;
  ageTier?: string;
  approvedAt?: Date | null;
}) {
  return {
    bedId: opts.bedId,
    bookingId: opts.bookingId,
    bookingGuestId: opts.bookingGuestId,
    roomId: opts.roomId,
    stayDate: NIGHT,
    approvedAt: opts.approvedAt ?? null,
    booking: {
      status: opts.status,
      originBookingRequest: opts.isRequestConverted ? { id: "req-1" } : null,
    },
    bookingGuest: { ageTier: opts.ageTier ?? "ADULT" },
  };
}

describe("bed allocation lifecycle", () => {
  it("does not touch allocations when the bed allocation module is disabled", async () => {
    const db = makeDb({
      clubModuleSettings: {
        findUnique: vi.fn().mockResolvedValue({ bedAllocation: false }),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(result).toEqual({
      enabled: false,
      deletedCount: 0,
      createdCount: 0,
    });
    expect(db.booking.findUnique).not.toHaveBeenCalled();
    expect(db.bedAllocation.deleteMany).not.toHaveBeenCalled();
  });

  it("treats completed bookings as allocatable operational stays", () => {
    expect(BED_ALLOCATABLE_BOOKING_STATUSES).toContain(BookingStatus.COMPLETED);
  });

  it("releases all allocations when a booking is no longer allocatable", async () => {
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.CANCELLED,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
    });
  });

  it("prunes stale guest-night allocations and auto-allocates missing valid nights", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              {
                id: "bed-a1",
                roomId: "room-a",
                name: "A1",
                sortOrder: 1,
                active: true,
              },
            ],
          },
        ]),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-02"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.booking.findMany.mockResolvedValue([
      {
        id: "booking-1",
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        guests: [
          {
            id: "guest-1",
            bookingId: "booking-1",
            ageTier: "ADULT",
            stayStart: parseDateOnly("2026-07-02"),
            stayEnd: parseDateOnly("2026-07-03"),
          },
        ],
      },
    ]);
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-03"),
      },
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        OR: [
          { bookingGuestId: { notIn: ["guest-1"] } },
          {
            bookingGuestId: "guest-1",
            stayDate: { lt: parseDateOnly("2026-07-02") },
          },
          {
            bookingGuestId: "guest-1",
            stayDate: { gte: parseDateOnly("2026-07-03") },
          },
        ],
      },
    });
    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: parseDateOnly("2026-07-02"),
          source: "AUTO",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 1,
      createdCount: 1,
    });
  });

  it("uses existing adult allocations when auto-filling a missing family minor", async () => {
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              {
                id: "bed-a1",
                roomId: "room-a",
                name: "A1",
                sortOrder: 1,
                active: true,
              },
              {
                id: "bed-a2",
                roomId: "room-a",
                name: "A2",
                sortOrder: 2,
                active: true,
              },
            ],
          },
        ]),
      },
    });
    const bookingRecord = {
      id: "booking-family",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-02"),
      guests: [
        {
          id: "adult-1",
          bookingId: "booking-family",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
        {
          id: "child-1",
          bookingId: "booking-family",
          ageTier: "CHILD",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
      ],
    };
    db.booking.findUnique.mockResolvedValue(bookingRecord);
    db.booking.findMany.mockResolvedValue([
      {
        id: bookingRecord.id,
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        guests: bookingRecord.guests,
      },
    ]);
    db.bedAllocation.findMany.mockResolvedValue([
      {
        bedId: "bed-a1",
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        stayDate: parseDateOnly("2026-07-01"),
        bookingGuest: { ageTier: "ADULT" },
      },
    ]);
    db.bedAllocation.createMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-family",
      db: db as any,
    });

    expect(db.bedAllocation.createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-family",
          bookingGuestId: "child-1",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: parseDateOnly("2026-07-01"),
          source: "AUTO",
        },
      ],
      skipDuplicates: true,
    });
    expect(result).toEqual({
      enabled: true,
      deletedCount: 0,
      createdCount: 1,
    });
  });

  it("prunes nights dropped by a booking date change without re-allocating when auto-allocation is off (issue #816)", async () => {
    // Booking moved from 07-01..07-06 to 07-03..07-06: the first two nights are
    // no longer part of the stay and their allocations must be pruned. Auto
    // allocation is off (default), so the reconcile is prune-only.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-03"),
      checkOut: parseDateOnly("2026-07-06"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-03"),
          stayEnd: parseDateOnly("2026-07-06"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-06"),
      },
    });

    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: {
        bookingId: "booking-1",
        OR: [
          { bookingGuestId: { notIn: ["guest-1"] } },
          {
            bookingGuestId: "guest-1",
            stayDate: { lt: parseDateOnly("2026-07-03") },
          },
          {
            bookingGuestId: "guest-1",
            stayDate: { gte: parseDateOnly("2026-07-06") },
          },
        ],
      },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
    });
  });

  it("prunes a removed guest's allocations via the notIn clause (issue #816)", async () => {
    // guest-2 was removed from the booking; only guest-1 remains. The notIn
    // clause must drop every allocation that no longer belongs to a current
    // guest of the booking.
    const db = makeDb();
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 1 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-03"),
      },
    });

    const pruneCall = db.bedAllocation.deleteMany.mock.calls[0][0];
    expect(pruneCall.where.bookingId).toBe("booking-1");
    expect(pruneCall.where.OR).toContainEqual({
      bookingGuestId: { notIn: ["guest-1"] },
    });
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(result.deletedCount).toBe(1);
    expect(result.createdCount).toBe(0);
  });

  it("re-checks the merged (union) range when a booking date range shrinks (issue #816)", async () => {
    // Booking shrank from 07-01..07-05 to 07-01..07-03. Reconciliation must
    // re-evaluate auto allocation across the union of the old and new ranges so
    // beds freed on the dropped nights can be re-filled (e.g. for another
    // booking). No other booking needs the freed nights here, so nothing is
    // created, but the scan must cover the old wider range.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
    });
    db.booking.findUnique.mockResolvedValue({
      id: "booking-1",
      status: BookingStatus.PAID,
      deletedAt: null,
      checkIn: parseDateOnly("2026-07-01"),
      checkOut: parseDateOnly("2026-07-03"),
      guests: [
        {
          id: "guest-1",
          bookingId: "booking-1",
          ageTier: "ADULT",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-03"),
        },
      ],
    });
    db.bedAllocation.deleteMany.mockResolvedValue({ count: 2 });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "booking-1",
      db: db as any,
      previousRange: {
        checkIn: parseDateOnly("2026-07-01"),
        checkOut: parseDateOnly("2026-07-05"),
      },
    });

    // The existing-allocation scan and the overlapping-booking scan both use the
    // union range 07-01..07-05, not just the new narrower 07-01..07-03.
    expect(db.bedAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          stayDate: {
            gte: parseDateOnly("2026-07-01"),
            lt: parseDateOnly("2026-07-05"),
          },
        }),
      }),
    );
    expect(db.booking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkIn: { lt: parseDateOnly("2026-07-05") },
          checkOut: { gt: parseDateOnly("2026-07-01") },
        }),
      }),
    );
    expect(result).toEqual({
      enabled: true,
      deletedCount: 2,
      createdCount: 0,
    });
  });
});

// Issue #1387: capacity-holding bookings get first claim on beds. When only a
// PROVISIONAL allocation blocks a held booking's guest-night, auto-allocation
// moves the provisional aside (to a free bed) or unallocates it, then places the
// held guest. A held allocation is NEVER displaced.
describe("bed allocation first-claim displacement (issue #1387)", () => {
  function heldFamilyDb(
    existing: ReturnType<typeof existingAllocation>[],
    plannerGuests: Array<{ id: string; ageTier: string }>,
  ) {
    const guests = plannerGuests.map((guest) => ({
      id: guest.id,
      bookingId: "held-new",
      ageTier: guest.ageTier,
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    }));

    return makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests,
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests,
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue(existing),
        createMany: vi.fn().mockResolvedValue({ count: plannerGuests.length }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        delete: vi.fn().mockResolvedValue({}),
        update: vi.fn().mockResolvedValue({}),
      },
    });
  }

  it("case 1 — relocates a blocking provisional to a free bed (MOVE) so a held booking gets its bed", async () => {
    // Rooms A(A1,A2) B(B1,B2). Existing: A2 provisional, B1 held. Free: A1, B2.
    // New HELD family (adult + child): the adult takes the free A1; the child
    // must share the adult's room A, whose only other bed A2 is provisional.
    // A free bed (B2) exists, so the provisional is MOVED to B2 and the child
    // takes A2 — no held allocation is displaced.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
      ],
      [
        { id: "hn-adult", ageTier: "ADULT" },
        { id: "hn-child", ageTier: "CHILD" },
      ],
    );

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional MOVED to the free bed B2 (not deleted).
    expect(db.bedAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bedAllocation.updateMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
      data: { bedId: "bed-b2", roomId: "room-b" },
    });
    // No UNALLOCATE: no displacement-shaped deleteMany (prune's is by bookingId).
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);

    // Held guests placed: adult on A1, child on the vacated A2.
    expect(db.bedAllocation.createMany).toHaveBeenCalledTimes(1);
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);

    // Audit row on the displaced provisional booking.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("bed_allocation.provisional_displaced");
    expect(audit.entityId).toBe("prov-booking");
    expect(audit.metadata.displacementType).toBe("MOVE");
    expect(audit.metadata.stayDate).toBe("2026-08-01");
    expect(audit.metadata.toBedId).toBe("bed-b2");
    expect(audit.metadata.displacedByBookingId).toBe("held-new");

    expect(result.createdCount).toBe(2);
  });

  it("case 2 — unallocates a blocking provisional (UNALLOCATE) when no free bed exists, returning it to the awaiting queue", async () => {
    // Room A(A1,A2) only. Existing: A1 held, A2 provisional. No free bed
    // anywhere. A new HELD adult must claim A2: the provisional is UNALLOCATED
    // (row deleted) and returns to the awaiting queue.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
              { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional row DELETED (unallocated), not moved.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
    });
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();

    // Held adult claims the freed A2.
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);

    // Audit row records the unallocation.
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.entityId).toBe("prov-booking");
    expect(audit.metadata.displacementType).toBe("UNALLOCATE");
    expect(audit.metadata.toBedId).toBeNull();

    expect(result.createdCount).toBe(1);
  });

  it("case 3 — never displaces a held allocation: a new held booking stays awaiting when the lodge is full of held bookings", async () => {
    // Room A(A1) only, occupied by a HELD booking. A new HELD adult finds no
    // free bed and no PROVISIONAL to displace, so it stays unallocated —
    // nothing is moved or deleted.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("case 4 — idempotent: re-running after a MOVE is a no-op (held stays put, provisional stays at its moved bed)", async () => {
    // Post-case-1 state: A1 held-new adult, A2 held-new child, B1 held-existing,
    // B2 the relocated provisional. Every guest-night is allocated, so a second
    // reconcile plans nothing: no moves, deletes, creates, or audit rows.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-new",
          bookingGuestId: "hn-adult",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "held-new",
          bookingGuestId: "hn-child",
          status: BookingStatus.PAID,
          ageTier: "CHILD",
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
      ],
      [
        { id: "hn-adult", ageTier: "ADULT" },
        { id: "hn-child", ageTier: "CHILD" },
      ],
    );

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("case 5 — held-first ordering: a held and a provisional booking compete for the last free bed and the held booking wins it", async () => {
    // Room A(A1) only, empty. A PROVISIONAL booking (created EARLIER) and a
    // HELD booking (created LATER) both want the single free bed. Held-first
    // ordering gives A1 to the held booking; the provisional stays awaiting and
    // nothing is displaced.
    const heldGuest = {
      id: "hn-adult",
      bookingId: "held-new",
      ageTier: "ADULT",
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    };
    const provGuest = {
      id: "pn-adult",
      bookingId: "prov-new",
      ageTier: "ADULT",
      stayStart: NIGHT,
      stayEnd: NIGHT_END,
      nights: [] as { stayDate: Date }[],
    };

    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [heldGuest],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            // Provisional created EARLIER — would win under pure FIFO.
            id: "prov-new",
            createdAt: new Date("2026-06-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PENDING,
            originBookingRequest: null,
            guests: [provGuest],
          },
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [heldGuest],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The HELD booking gets the only bed; the provisional does not, and nothing
    // is displaced (no existing allocations to displace).
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    expect(created).toHaveLength(1);
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(1);
  });

  it("never displaces an admin-APPROVED provisional allocation (the #776 lock stays intact)", async () => {
    // Room A(A1,A2). A1 Held, A2 Provisional but ADMIN-APPROVED. A new Held
    // adult finds no free bed and the only provisional is approved (locked), so
    // it stays awaiting — the approved row is neither moved nor deleted.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "room-a",
            name: "Room A",
            sortOrder: 1,
            active: true,
            beds: [
              { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1, active: true },
              { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2, active: true },
            ],
          },
        ]),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-g1",
            status: BookingStatus.PENDING,
            approvedAt: new Date("2026-07-05T00:00:00.000Z"),
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The approved provisional is untouched; the held booking stays awaiting.
    expect(db.bedAllocation.updateMany).not.toHaveBeenCalled();
    const unallocateCalls = db.bedAllocation.deleteMany.mock.calls.filter(
      (call: any[]) => "bookingGuestId" in call[0].where,
    );
    expect(unallocateCalls).toHaveLength(0);
    expect(db.bedAllocation.createMany).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(result.createdCount).toBe(0);
  });

  it("never strands a displaced provisional booking's minor: unallocates the minor rather than its supervising adult", async () => {
    // Rooms A(A1,A2) B(B1,B2), all occupied (no free bed). Room A holds a
    // Provisional family — adult A1, child A2. A new Held adult needs a bed.
    // Displacing the provisional ADULT would strand its child, so displacement
    // takes the provisional CHILD (UNALLOCATE) and leaves the adult in place.
    const db = makeDb({
      bedAllocationSettings: {
        findUnique: vi.fn().mockResolvedValue({ autoAllocationEnabled: true }),
      },
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue(TWO_ROOMS_TWO_BEDS),
      },
      booking: {
        findUnique: vi.fn().mockResolvedValue({
          id: "held-new",
          status: BookingStatus.PAID,
          deletedAt: null,
          checkIn: NIGHT,
          checkOut: NIGHT_END,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: NIGHT,
              stayEnd: NIGHT_END,
              nights: [],
            },
          ],
        }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "held-new",
            createdAt: new Date("2026-07-01T00:00:00.000Z"),
            requestedRoomId: null,
            status: BookingStatus.PAID,
            originBookingRequest: null,
            guests: [
              {
                id: "hn-adult",
                bookingId: "held-new",
                ageTier: "ADULT",
                stayStart: NIGHT,
                stayEnd: NIGHT_END,
                nights: [],
              },
            ],
          },
        ]),
      },
      bedAllocation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          existingAllocation({
            bedId: "bed-a1",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-adult",
            status: BookingStatus.PENDING,
            ageTier: "ADULT",
          }),
          existingAllocation({
            bedId: "bed-a2",
            roomId: "room-a",
            bookingId: "prov-booking",
            bookingGuestId: "prov-child",
            status: BookingStatus.PENDING,
            ageTier: "CHILD",
          }),
          existingAllocation({
            bedId: "bed-b1",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g1",
            status: BookingStatus.PAID,
          }),
          existingAllocation({
            bedId: "bed-b2",
            roomId: "room-b",
            bookingId: "held-existing",
            bookingGuestId: "he-g2",
            status: BookingStatus.PAID,
          }),
        ]),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    });

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // The provisional CHILD is unallocated (its bed A2 goes to the held adult);
    // the provisional ADULT is never touched, so no room is left with an
    // unsupervised minor.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-child", stayDate: NIGHT_UTC },
    });
    const displacementTargets = [
      ...db.bedAllocation.updateMany.mock.calls,
      ...db.bedAllocation.deleteMany.mock.calls.filter(
        (call: any[]) => "bookingGuestId" in call[0].where,
      ),
    ].map((call: any[]) => call[0].where.bookingGuestId);
    expect(displacementTargets).not.toContain("prov-adult");

    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    const audit = db.auditLog.create.mock.calls[0][0].data;
    expect(audit.entityId).toBe("prov-booking");
    expect(audit.metadata.displacedBookingGuestId).toBe("prov-child");
    expect(audit.metadata.displacementType).toBe("UNALLOCATE");
    expect(result.createdCount).toBe(1);
  });

  it("applies displacement inline when the caller already provides a transaction (no nested $transaction)", async () => {
    // Same UNALLOCATE setup as case 2, but the client exposes no `$transaction`
    // (it is already a TransactionClient): the lifecycle must apply the
    // deleteMany + createMany inline on that client, not open a nested one.
    const db = heldFamilyDb(
      [
        existingAllocation({
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-existing",
          bookingGuestId: "he-g1",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-booking",
          bookingGuestId: "prov-g1",
          status: BookingStatus.PENDING,
        }),
        existingAllocation({
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g2",
          status: BookingStatus.PAID,
        }),
        existingAllocation({
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "held-existing",
          bookingGuestId: "he-g3",
          status: BookingStatus.PAID,
        }),
      ],
      [{ id: "hn-adult", ageTier: "ADULT" }],
    );
    // Simulate an already-open caller transaction: no `$transaction` method.
    db.$transaction = undefined;

    const result = await reconcileBedAllocationsForBooking({
      bookingId: "held-new",
      db: db as any,
    });

    // Provisional at A2 unallocated; held adult takes the freed A2 — applied
    // inline on the same client.
    expect(db.bedAllocation.deleteMany).toHaveBeenCalledWith({
      where: { bookingGuestId: "prov-g1", stayDate: NIGHT_UTC },
    });
    const created = db.bedAllocation.createMany.mock.calls[0][0].data;
    expect(created).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: NIGHT_UTC,
        source: "AUTO",
      },
    ]);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(1);
  });
});
