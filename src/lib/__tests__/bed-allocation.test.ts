import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { parseDateOnly } from "@/lib/date-only";
import {
  buildFirstFitBedAllocationPlan,
  replaceBedAllocationsForBooking,
  type BedAllocationAgeTier,
  type BedAllocationBooking,
  type BedAllocationRoom,
} from "@/lib/bed-allocation";

const rooms: BedAllocationRoom[] = [
  {
    id: "room-b",
    name: "Room B",
    sortOrder: 2,
    beds: [
      { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
    ],
  },
  {
    id: "room-a",
    name: "Room A",
    sortOrder: 1,
    beds: [
      { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
      { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
    ],
  },
];

function booking(
  id: string,
  createdAt: string,
  guestId: string,
  requestedRoomId: string | null = null,
): BedAllocationBooking {
  return {
    id,
    createdAt: new Date(createdAt),
    requestedRoomId,
    guests: [
      {
        id: guestId,
        bookingId: id,
        stayStart: parseDateOnly("2026-07-01"),
        stayEnd: parseDateOnly("2026-07-03"),
      },
    ],
  };
}

function multiGuestBooking(
  id: string,
  createdAt: string,
  guests: Array<{
    id: string;
    ageTier?: BedAllocationAgeTier;
    stayStart?: string;
    stayEnd?: string;
  }>,
  requestedRoomId: string | null = null,
): BedAllocationBooking {
  return {
    id,
    createdAt: new Date(createdAt),
    requestedRoomId,
    guests: guests.map((guest) => ({
      id: guest.id,
      bookingId: id,
      ageTier: guest.ageTier ?? "ADULT",
      stayStart: parseDateOnly(guest.stayStart ?? "2026-07-01"),
      stayEnd: parseDateOnly(guest.stayEnd ?? "2026-07-02"),
    })),
  };
}

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("bed allocation planner", () => {
  it("does nothing when the module is disabled", () => {
    expect(
      buildFirstFitBedAllocationPlan({
        enabled: false,
        rooms,
        bookings: [booking("booking-1", "2026-06-01", "guest-1")],
      }),
    ).toEqual({ allocations: [], unallocatedGuestNights: [] });
  });

  it("allocates guest nights to active beds in room and bed sort order", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [booking("booking-1", "2026-06-01", "guest-1")],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });

  it("allocates bookings FIFO and reports unallocated guest nights when beds are full", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1" }],
        },
      ],
      bookings: [
        booking("booking-newer", "2026-06-02", "guest-newer"),
        booking("booking-older", "2026-06-01", "guest-older"),
      ],
      occupiedBedNights: [{ bedId: "bed-a1", stayDate: "2026-07-02" }],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-older",
        bookingGuestId: "guest-older",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "booking-older",
        bookingGuestId: "guest-older",
        stayDate: "2026-07-02",
        reason: "NO_BED_AVAILABLE",
      },
      {
        bookingId: "booking-newer",
        bookingGuestId: "guest-newer",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
      {
        bookingId: "booking-newer",
        bookingGuestId: "guest-newer",
        stayDate: "2026-07-02",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("keeps booking guests together in one room when capacity allows", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
            { id: "bed-a3", roomId: "room-a", name: "A3", sortOrder: 3 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [
            { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
            { id: "bed-b3", roomId: "room-b", name: "B3", sortOrder: 3 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          { id: "adult-1", ageTier: "ADULT" },
          { id: "adult-2", ageTier: "ADULT" },
          { id: "child-1", ageTier: "CHILD" },
        ]),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-2",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-a",
        bedId: "bed-a3",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("splits adults with minors when no single room can fit the booking", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [
            { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          { id: "adult-1", ageTier: "ADULT" },
          { id: "adult-2", ageTier: "ADULT" },
          { id: "child-1", ageTier: "CHILD" },
          { id: "youth-1", ageTier: "YOUTH" },
        ]),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-2",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "youth-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // No single room fits the party of four, so the per-night split fallback
    // fired and the booking is reported for room-continuity visibility (#1677).
    expect(plan.roomContinuityFallbackBookingIds).toEqual(["booking-family"]);
  });

  it("does not allocate minors when no booking adult is staying that night", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking("booking-youth", "2026-06-01", [
          { id: "youth-1", ageTier: "YOUTH" },
        ]),
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "booking-youth",
        bookingGuestId: "youth-1",
        stayDate: "2026-07-01",
        reason: "NO_BOOKING_ADULT",
      },
    ]);
  });

  it("leaves minors unallocated rather than placing them without an adult", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1" }],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [{ id: "bed-b1", roomId: "room-b", name: "B1" }],
        },
      ],
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          { id: "adult-1", ageTier: "ADULT" },
          { id: "child-1", ageTier: "CHILD" },
        ]),
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("uses existing adult allocations when filling a missing minor guest-night", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          {
            id: "adult-1",
            ageTier: "ADULT",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-02",
          },
          {
            id: "child-1",
            ageTier: "CHILD",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-02",
          },
        ]),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "booking-family",
          bookingGuestId: "adult-1",
          ageTier: "ADULT",
          stayDate: "2026-07-01",
        },
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("keeps a booking in one room for the whole stay (issue #1677)", () => {
    // Room A can host the family on night 1 but not night 2 (A2 is taken).
    // The old per-night planner dropped the family into room A on night 1 and
    // forced a mid-stay move to room B on night 2. Whole-stay planning places
    // the family in room B for BOTH nights — no one changes rooms.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [
            { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          {
            id: "adult-1",
            ageTier: "ADULT",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-03",
          },
          {
            id: "child-1",
            ageTier: "CHILD",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-03",
          },
        ]),
      ],
      occupiedBedNights: [{ bedId: "bed-a2", stayDate: "2026-07-02" }],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.roomContinuityFallbackBookingIds).toBeUndefined();
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "adult-1",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });

  it("prefers a booking's requested room over default first-fit ordering", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking(
          "booking-1",
          "2026-06-01",
          [{ id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-02" }],
          "room-b",
        ),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("falls back silently to first-fit when the requested room is full", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking(
          "booking-1",
          "2026-06-01",
          [{ id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-02" }],
          "room-b",
        ),
      ],
      occupiedBedNights: [{ bedId: "bed-b1", stayDate: "2026-07-01" }],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("leaves bookings without a requested room unaffected by another booking's request", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking("booking-no-request", "2026-06-01", [
          { id: "guest-no-request", stayStart: "2026-07-01", stayEnd: "2026-07-02" },
        ]),
        multiGuestBooking(
          "booking-with-request",
          "2026-06-02",
          [{ id: "guest-with-request", stayStart: "2026-07-01", stayEnd: "2026-07-02" }],
          "room-b",
        ),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-no-request",
        bookingGuestId: "guest-no-request",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-with-request",
        bookingGuestId: "guest-with-request",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("treats a missing or inactive requested room as no preference without erroring", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms,
      bookings: [
        multiGuestBooking(
          "booking-1",
          "2026-06-01",
          [{ id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-02" }],
          "room-now-inactive",
        ),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
  });

  it("replaces persisted booking allocations with parsed date-only values", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });

    await expect(
      replaceBedAllocationsForBooking(
        { bedAllocation: { deleteMany, createMany } },
        "booking-1",
        [
          {
            bookingId: "booking-1",
            bookingGuestId: "guest-1",
            roomId: "room-a",
            bedId: "bed-a1",
            stayDate: "2026-07-01",
            source: "MANUAL",
          },
        ],
      ),
    ).resolves.toEqual({ count: 1 });

    expect(deleteMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: parseDateOnly("2026-07-01"),
          source: "MANUAL",
        },
      ],
    });
  });
});

// Issue #1677: booking-first, whole-stay-first planning. A booking party gets
// ONE room for the entire stay; per-night splitting is a reported last resort.
describe("bed allocation whole-stay room continuity (issue #1677)", () => {
  it("hosts staggered per-guest ranges in one room for the whole stay", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-staggered", "2026-06-01", [
          {
            id: "adult-1",
            ageTier: "ADULT",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-04",
          },
          {
            id: "adult-2",
            ageTier: "ADULT",
            stayStart: "2026-07-02",
            stayEnd: "2026-07-04",
          },
        ]),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.roomContinuityFallbackBookingIds).toBeUndefined();
    // Everyone in room A; each guest keeps ONE bed across its own range.
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-staggered",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-staggered",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
      {
        bookingId: "booking-staggered",
        bookingGuestId: "adult-2",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
      {
        bookingId: "booking-staggered",
        bookingGuestId: "adult-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-03",
        source: "AUTO",
      },
      {
        bookingId: "booking-staggered",
        bookingGuestId: "adult-2",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-03",
        source: "AUTO",
      },
    ]);
  });

  it("plans a non-contiguous stay (#713) on its included nights only, leaving the gap night free", () => {
    // The same guest id arrives as two per-night pseudo-entries (nights 07-01
    // and 07-03) — the callers' shape for a #713 night set with a gap.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [
        multiGuestBooking("booking-gap", "2026-06-01", [
          {
            id: "guest-1",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-02",
          },
          {
            id: "guest-1",
            stayStart: "2026-07-03",
            stayEnd: "2026-07-04",
          },
        ]),
        // A later booking takes the gap night — the bed really is free then.
        multiGuestBooking("booking-mid", "2026-06-02", [
          {
            id: "guest-2",
            stayStart: "2026-07-02",
            stayEnd: "2026-07-03",
          },
        ]),
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-gap",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-gap",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-03",
        source: "AUTO",
      },
      {
        bookingId: "booking-mid",
        bookingGuestId: "guest-2",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });

  it("switches beds within the room only when no single bed spans the stay", () => {
    // A1 is taken on night 2 and A2 on night 1: no bed is free for the whole
    // stay, but room A still hosts every night — the guest stays in ONE room
    // and switches beds, never rooms.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [{ id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 }],
        },
      ],
      bookings: [
        multiGuestBooking("booking-1", "2026-06-01", [
          { id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-03" },
        ]),
      ],
      occupiedBedNights: [
        { bedId: "bed-a1", stayDate: "2026-07-02" },
        { bedId: "bed-a2", stayDate: "2026-07-01" },
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.roomContinuityFallbackBookingIds).toBeUndefined();
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });

  it("pins a date-extension to the booking's existing room and keeps the guest's bed", () => {
    // guest-1 already holds B2 on night 1 (existing allocation). The added
    // night 2 must land in room B (not first-fit room A) and on the SAME bed
    // B2 (not room B's lower-sorted free B1).
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [
            { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-1", "2026-06-01", [
          { id: "guest-1", stayStart: "2026-07-01", stayEnd: "2026-07-03" },
        ]),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "booking-1",
          bookingGuestId: "guest-1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
        },
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-1",
        bookingGuestId: "guest-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });

  it("pins a minors-only stay to the one room holding the booking's existing adult, for the whole stay", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [
            { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        multiGuestBooking("booking-family", "2026-06-01", [
          {
            id: "child-1",
            ageTier: "CHILD",
            stayStart: "2026-07-01",
            stayEnd: "2026-07-03",
          },
        ]),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "booking-family",
          bookingGuestId: "adult-1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "booking-family",
          bookingGuestId: "adult-1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
        },
      ],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    // Room A sorts first and has space, but only room B holds the booking's
    // adult on every night — the child's whole stay pins there.
    expect(plan.allocations).toEqual([
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "booking-family",
        bookingGuestId: "child-1",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
  });
});

describe("bed allocation schema contract", () => {
  it("adds current allocation tables with one bed per guest-night and one guest per bed-night", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const migration = readRepoFile(
      "prisma/migrations/20260607133000_add_bed_allocation_inventory/migration.sql",
    );

    expect(schema).toContain("model LodgeRoom");
    expect(schema).toContain("model LodgeBed");
    expect(schema).toContain("model BedAllocation");
    expect(schema).toContain("@@unique([bedId, stayDate])");
    expect(schema).toContain("@@unique([bookingGuestId, stayDate])");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "LodgeRoom"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "BedAllocation_bedId_stayDate_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "BedAllocation_bookingGuestId_stayDate_key"',
    );
  });
});

describe("bed allocation lodge isolation", () => {
  // Two lodges' rooms pooled into one planner call — the shape the club-wide
  // board auto-allocation produces (no lodgeId scope on the query). The matcher
  // must keep each booking in its own lodge's beds regardless.
  const twoLodgeRooms: BedAllocationRoom[] = [
    {
      id: "room-a1",
      name: "Lodge A Room 1",
      sortOrder: 1,
      lodgeId: "lodge-a",
      beds: [{ id: "bed-a1", roomId: "room-a1", name: "A1", sortOrder: 1 }],
    },
    {
      id: "room-b1",
      name: "Lodge B Room 1",
      sortOrder: 2,
      lodgeId: "lodge-b",
      beds: [{ id: "bed-b1", roomId: "room-b1", name: "B1", sortOrder: 1 }],
    },
  ];

  function lodgeBooking(
    id: string,
    lodgeId: string | null,
    guestId: string,
  ): BedAllocationBooking {
    return {
      id,
      createdAt: new Date("2026-06-01"),
      lodgeId,
      requestedRoomId: null,
      guests: [
        {
          id: guestId,
          bookingId: id,
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-02"),
        },
      ],
    };
  }

  it("places a lodge-A booking only in lodge-A beds even when lodge-B rooms are pooled in", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: twoLodgeRooms,
      bookings: [lodgeBooking("booking-a", "lodge-a", "guest-a")],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations).toHaveLength(1);
    // The only allocation must be a lodge-A bed — never bed-b1.
    expect(plan.allocations[0]).toMatchObject({
      bookingId: "booking-a",
      roomId: "room-a1",
      bedId: "bed-a1",
    });
    expect(
      plan.allocations.some((a) => a.roomId === "room-b1" || a.bedId === "bed-b1"),
    ).toBe(false);
  });

  it("leaves a lodge-A booking unallocated rather than borrowing a lodge-B bed", () => {
    // Only lodge B has a free bed; a lodge-A booking must NOT take it.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: twoLodgeRooms,
      bookings: [lodgeBooking("booking-a", "lodge-a", "guest-a")],
      occupiedBedNights: [{ bedId: "bed-a1", stayDate: "2026-07-01" }],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "booking-a",
        bookingGuestId: "guest-a",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("keeps two same-date bookings in their own lodges from one pooled plan", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: twoLodgeRooms,
      bookings: [
        lodgeBooking("booking-a", "lodge-a", "guest-a"),
        lodgeBooking("booking-b", "lodge-b", "guest-b"),
      ],
    });

    const byBooking = Object.fromEntries(
      plan.allocations.map((a) => [a.bookingId, a]),
    );
    expect(byBooking["booking-a"]).toMatchObject({ bedId: "bed-a1" });
    expect(byBooking["booking-b"]).toMatchObject({ bedId: "bed-b1" });
  });

  it("treats a null-lodge booking as club-wide (expand-release tolerance)", () => {
    // Before the contract release enforces NOT NULL, a booking with a null
    // lodgeId must still be placeable in any lodge's bed.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [twoLodgeRooms[1]], // only lodge-B room available
      bookings: [lodgeBooking("booking-legacy", null, "guest-legacy")],
    });

    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.allocations[0]).toMatchObject({ bedId: "bed-b1" });
  });

  it("never relocates a blocking provisional across lodges under prioritizeCapacityHolding (#1387 × lodge isolation)", () => {
    // A held booking at lodge A is blocked by a provisional occupying lodge A's
    // only bed, while lodge B has a free bed pooled into the same planner call.
    // The #1387 displacement search must stay within lodge A: the provisional is
    // UNALLOCATED (no free lodge-A bed to move it to) and the held booking takes
    // the vacated lodge-A bed. The provisional must NEVER be moved onto lodge B's
    // bed — that cross-lodge relocation is the bug this guards.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: twoLodgeRooms,
      bookings: [
        {
          id: "held-a",
          createdAt: new Date("2026-06-01"),
          lodgeId: "lodge-a",
          holdsCapacity: true,
          requestedRoomId: null,
          guests: [
            {
              id: "held-a-g1",
              bookingId: "held-a",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-02"),
            },
          ],
        },
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a1",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    // The held booking claims the vacated lodge-A bed.
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-a",
        bookingGuestId: "held-a-g1",
        roomId: "room-a1",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // The provisional is unallocated, not moved — no free bed exists in ITS lodge.
    expect(plan.displacements).toHaveLength(1);
    expect(plan.displacements?.[0]).toMatchObject({
      type: "UNALLOCATE",
      bookingId: "prov",
      bookingGuestId: "prov-g1",
      fromBedId: "bed-a1",
    });
    // Hard guard against the cross-lodge leak: nothing lands on lodge B's bed.
    expect(
      (plan.displacements ?? []).some(
        (d) => d.type === "MOVE" && d.toBedId === "bed-b1",
      ),
    ).toBe(false);
    expect(plan.allocations.some((a) => a.bedId === "bed-b1")).toBe(false);
  });
});

// Issue #1387: capacity-holding bookings get first claim. Held bookings are
// allocated before provisional ones, and a held booking blocked only by a
// provisional allocation moves it aside (MOVE) or unallocates it (UNALLOCATE).
describe("bed allocation first-claim displacement (issue #1387)", () => {
  const twoRooms: BedAllocationRoom[] = [
    {
      id: "room-a",
      name: "Room A",
      sortOrder: 1,
      beds: [
        { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
        { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
      ],
    },
    {
      id: "room-b",
      name: "Room B",
      sortOrder: 2,
      beds: [
        { id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 },
        { id: "bed-b2", roomId: "room-b", name: "B2", sortOrder: 2 },
      ],
    },
  ];

  function heldBooking(
    id: string,
    createdAt: string,
    guests: Array<{ id: string; ageTier?: BedAllocationAgeTier }>,
    holdsCapacity: boolean,
  ): BedAllocationBooking {
    return {
      id,
      createdAt: new Date(createdAt),
      requestedRoomId: null,
      holdsCapacity,
      guests: guests.map((guest) => ({
        id: guest.id,
        bookingId: id,
        ageTier: guest.ageTier ?? "ADULT",
        stayStart: parseDateOnly("2026-07-01"),
        stayEnd: parseDateOnly("2026-07-02"),
      })),
    };
  }

  it("emits no displacements when the flag is off: a provisional-occupied bed still blocks a held booking", () => {
    // Planning is whole-stay-first for every caller (#1677), but displacement
    // stays exclusive to the prioritizeCapacityHolding lifecycle path: with
    // the flag off a held booking never evicts a provisional occupant and the
    // plan carries no displacements, so the admin board stays a pure preview.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [heldBooking("held", "2026-07-01", [{ id: "hn" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "held",
        bookingGuestId: "hn",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("relocates a blocking provisional to a free bed (MOVE) so a held family fits", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: twoRooms,
      bookings: [
        heldBooking(
          "held-new",
          "2026-07-01",
          [
            { id: "hn-adult", ageTier: "ADULT" },
            { id: "hn-child", ageTier: "CHILD" },
          ],
          true,
        ),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.displacements).toEqual([
      {
        type: "MOVE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        toBedId: "bed-b2",
        toRoomId: "room-b",
        displacedByBookingId: "held-new",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([]);
  });

  it("unallocates a blocking provisional (UNALLOCATE) when no free bed exists", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.displacements).toEqual([
      {
        type: "UNALLOCATE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        displacedByBookingId: "held-new",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([]);
  });

  it("never displaces a capacity-holding occupant", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("allocates the last free bed to the held booking over an earlier provisional one", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [
        // Provisional created earlier — would win under pure FIFO order.
        heldBooking("prov-new", "2026-06-01", [{ id: "pn-adult" }], false),
        heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true),
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "prov-new",
        bookingGuestId: "pn-adult",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
    expect(plan).not.toHaveProperty("displacements");
  });

  it("never displaces an admin-approved provisional allocation", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          // Admin-approved (#776 lock) — must not be displaced.
          approvedAt: "2026-07-05",
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("consolidates a displaced provisional family into ONE room, keeping its minor with its adult (#1677)", () => {
    // Rooms A(A1,A2) B(B1) C(C1,C2). Provisional family: child at A2, adult at
    // C1. A held family (adult+child) claims room A whole, evicting the
    // provisional BOOKING as one unit. Its whole-stay re-plan lands in room C
    // (the room already holding most of the family): the adult keeps C1
    // (unchanged, so no record) and the child MOVEs to C2 — never to room B,
    // which would strand it away from its adult.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [{ id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 }],
        },
        {
          id: "room-c",
          name: "Room C",
          sortOrder: 3,
          beds: [
            { id: "bed-c1", roomId: "room-c", name: "C1", sortOrder: 1 },
            { id: "bed-c2", roomId: "room-c", name: "C2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        heldBooking(
          "held-new",
          "2026-07-01",
          [
            { id: "hn-adult", ageTier: "ADULT" },
            { id: "hn-child", ageTier: "CHILD" },
          ],
          true,
        ),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-child",
          stayDate: "2026-07-01",
          ageTier: "CHILD",
          holdsCapacity: false,
        },
        {
          bedId: "bed-c1",
          roomId: "room-c",
          bookingId: "prov",
          bookingGuestId: "prov-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    // Held adult on A1, held child on the vacated A2.
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // Provisional child MOVED to C2 (the family's one destination room), NOT
    // to B1; the adult keeps C1, so it needs no record — the booking ends the
    // plan wholly in room C.
    expect(plan.displacements).toEqual([
      {
        type: "MOVE",
        bookingId: "prov",
        bookingGuestId: "prov-child",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        toBedId: "bed-c2",
        toRoomId: "room-c",
        displacedByBookingId: "held-new",
      },
    ]);
  });

  it("claims a whole room for a held family by evicting whole provisional stays, newest booking first (#1677 Phase 2)", () => {
    // Rooms A(A1,A2) B(B1,B2), all four beds held by distinct provisional
    // adults, no free bed. Whole-stay displacement (Phase 2) evicts BOTH
    // room-A provisionals (newest booking id first on equal createdAt) and
    // places the family together in room A, adults first, even though the
    // family lists the child before the adult.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: twoRooms,
      bookings: [
        heldBooking(
          "held-new",
          "2026-07-01",
          [
            { id: "hn-child", ageTier: "CHILD" },
            { id: "hn-adult", ageTier: "ADULT" },
          ],
          true,
        ),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov-1",
          bookingGuestId: "prov-1-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-2",
          bookingGuestId: "prov-2-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "prov-3",
          bookingGuestId: "prov-3-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "prov-4",
          bookingGuestId: "prov-4-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    // Both held guests are placed in room A (adult first, then child).
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // Two UNALLOCATEs (no free bed to relocate to): the two room-A
    // provisionals, evicted newest-first (prov-2 before prov-1 — equal
    // createdAt ties break on booking id, descending).
    expect(plan.displacements).toHaveLength(2);
    expect(
      plan.displacements?.map((displacement) => ({
        type: displacement.type,
        bookingGuestId: displacement.bookingGuestId,
      })),
    ).toEqual([
      { type: "UNALLOCATE", bookingGuestId: "prov-2-adult" },
      { type: "UNALLOCATE", bookingGuestId: "prov-1-adult" },
    ]);
    // Whole-room claim, no per-night fallback.
    expect(plan.roomContinuityFallbackBookingIds).toBeUndefined();
  });

  it("places a held family adults-first in the per-night fallback so a child ordered before its adult still fits (#1677 Phase 3)", () => {
    // Two nights. Night 1: every bed is taken (room A by two displaceable
    // single-night provisionals, room B by held bookings). Night 2: room A is
    // blocked by a held booking and an APPROVED provisional (pinned), room B is
    // free. No single room can host the whole stay even with displacement, so
    // the plan falls back to per-night logic. On night 1, adults-first
    // displacement seats the held ADULT first (establishing its room), then
    // the child — even though the family lists the child first. Each displaced
    // provisional is evicted as a whole booking (single-night stays here) and
    // unallocated because no free bed remains that night.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: twoRooms,
      bookings: [
        {
          id: "held-new",
          createdAt: new Date("2026-07-01"),
          requestedRoomId: null,
          holdsCapacity: true,
          guests: [
            {
              id: "hn-child",
              bookingId: "held-new",
              ageTier: "CHILD",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-03"),
            },
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-03"),
            },
          ],
        },
      ],
      occupiedBedNights: [
        // Night 1: all four beds taken.
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov-1",
          bookingGuestId: "prov-1-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-2",
          bookingGuestId: "prov-2-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-ex-1",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-b2",
          roomId: "room-b",
          bookingId: "held-ex-2",
          bookingGuestId: "he-g2",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        // Night 2: room A blocked (held + approved provisional), room B free.
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex-3",
          bookingGuestId: "he-g3",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-3",
          bookingGuestId: "prov-3-adult",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: false,
          approvedAt: "2026-06-20",
        },
      ],
    });

    // Night 1 in room A (adult displaced-in first, then the child beside it);
    // night 2 whole-night in room B (input order) — a mid-stay switch, but
    // only as the last resort, and the booking is reported as a
    // room-continuity fallback.
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-b",
        bedId: "bed-b1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-b",
        bedId: "bed-b2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
    expect(plan.roomContinuityFallbackBookingIds).toEqual(["held-new"]);
    // The two night-1 provisionals are unallocated whole (their entire visible
    // stay is that one night); the approved night-2 provisional is untouched.
    expect(
      plan.displacements?.map((displacement) => ({
        type: displacement.type,
        bookingGuestId: displacement.bookingGuestId,
      })),
    ).toEqual([
      { type: "UNALLOCATE", bookingGuestId: "prov-1-adult" },
      { type: "UNALLOCATE", bookingGuestId: "prov-2-adult" },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([]);
  });

  it("emits zero displacements when every guest-night is already allocated (idempotent)", () => {
    // The planner sees a held booking whose guest-night already has a bed and a
    // provisional occupant on another bed. Nothing is unallocated, so nothing is
    // placed and NO displacement is emitted — a second run cannot re-displace.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-new",
          bookingGuestId: "hn-adult",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
  });

  it("moves a multi-night provisional stay WHOLE to one destination room (#1677)", () => {
    // Prov holds A2 on both nights; a held family needs room A whole. The
    // provisional's entire stay MOVEs to room B (same bed both nights) — one
    // destination room, no night left behind, no mixing with UNALLOCATE.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: twoRooms,
      bookings: [
        {
          id: "held-new",
          createdAt: new Date("2026-07-01"),
          requestedRoomId: null,
          holdsCapacity: true,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-03"),
            },
            {
              id: "hn-child",
              bookingId: "held-new",
              ageTier: "CHILD",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-03"),
            },
          ],
        },
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a1",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-child",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
    expect(plan.displacements).toEqual([
      {
        type: "MOVE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        toBedId: "bed-b2",
        toRoomId: "room-b",
        displacedByBookingId: "held-new",
      },
      {
        type: "MOVE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-02",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        toBedId: "bed-b2",
        toRoomId: "room-b",
        displacedByBookingId: "held-new",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([]);
    expect(plan.roomContinuityFallbackBookingIds).toBeUndefined();
  });

  it("unallocates a multi-night provisional stay WHOLE when no single room can host it (#1677)", () => {
    // One room only. Prov holds A2 on both nights; a held adult books both
    // nights. With nowhere to move the provisional whole, its ENTIRE stay is
    // UNALLOCATED — all-MOVE or all-UNALLOCATE, never a mix, never a
    // night-split.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        {
          id: "held-new",
          createdAt: new Date("2026-07-01"),
          requestedRoomId: null,
          holdsCapacity: true,
          guests: [
            {
              id: "hn-adult",
              bookingId: "held-new",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-03"),
            },
          ],
        },
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-02",
        source: "AUTO",
      },
    ]);
    expect(plan.displacements).toEqual([
      {
        type: "UNALLOCATE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        displacedByBookingId: "held-new",
      },
      {
        type: "UNALLOCATE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-02",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        displacedByBookingId: "held-new",
      },
    ]);
    expect(plan.unallocatedGuestNights).toEqual([]);
  });

  it("one approved night ANYWHERE pins the provisional booking's whole stay against displacement (#1677)", () => {
    // Prov holds the only bed on both nights; only night 2 is admin-approved.
    // Displacement operates on whole stays, so the approval pins night 1 too —
    // the held booking stays awaiting.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-02",
          ageTier: "ADULT",
          holdsCapacity: false,
          approvedAt: "2026-06-20",
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("never displaces a provisional stay that extends beyond the loaded window (#1677)", () => {
    // The occupant's booking continues past the planner's window, so only part
    // of its stay is visible: a whole-stay move is impossible and the booking
    // is pinned.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [{ id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 }],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          stayExtendsBeyondWindow: true,
        },
      ],
    });

    expect(plan.allocations).toEqual([]);
    expect(plan).not.toHaveProperty("displacements");
    expect(plan.unallocatedGuestNights).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        stayDate: "2026-07-01",
        reason: "NO_BED_AVAILABLE",
      },
    ]);
  });

  it("evicts the NEWEST provisional booking first (bookingCreatedAt) and leaves older ones in place (#1677)", () => {
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-a",
          name: "Room A",
          sortOrder: 1,
          beds: [
            { id: "bed-a1", roomId: "room-a", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-b",
          name: "Room B",
          sortOrder: 2,
          beds: [{ id: "bed-b1", roomId: "room-b", name: "B1", sortOrder: 1 }],
        },
      ],
      bookings: [heldBooking("held-new", "2026-07-01", [{ id: "hn-adult" }], true)],
      occupiedBedNights: [
        {
          bedId: "bed-a1",
          roomId: "room-a",
          bookingId: "prov-old",
          bookingGuestId: "prov-old-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          bookingCreatedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          bedId: "bed-a2",
          roomId: "room-a",
          bookingId: "prov-new",
          bookingGuestId: "prov-new-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          bookingCreatedAt: "2026-06-05T00:00:00.000Z",
        },
        {
          bedId: "bed-b1",
          roomId: "room-b",
          bookingId: "held-ex",
          bookingGuestId: "he-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: true,
        },
      ],
    });

    // Only ONE bed is needed: the newest provisional (prov-new) is evicted;
    // the older one keeps its bed. With every other bed full, the evicted
    // booking is unallocated whole.
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-adult",
        roomId: "room-a",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    expect(plan.displacements).toEqual([
      {
        type: "UNALLOCATE",
        bookingId: "prov-new",
        bookingGuestId: "prov-new-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a",
        displacedByBookingId: "held-new",
      },
    ]);
  });

  it("never MOVEs a displaced booking onto a bed another displaced booking has not yet vacated (apply-order safety, #1677)", () => {
    // Rooms R(r1,r2) and Q(q1,q2). Night N: r1 = P1, r2 = P2-guest-A,
    // q1 = P2-guest-B, q2 free. A held pair claims room R whole, evicting P1
    // and P2. P1's re-plan must NOT target q1 — P2's row still occupies it in
    // the DATABASE, and the lifecycle applies displacements row by row against
    // @@unique([bedId, stayDate]), so a chained MOVE would conflict mid-apply.
    // P1 moves to the genuinely-free q2; P2 (needing two beds with only q1
    // left) is wholly unallocated.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-r",
          name: "Room R",
          sortOrder: 1,
          beds: [
            { id: "bed-r1", roomId: "room-r", name: "R1", sortOrder: 1 },
            { id: "bed-r2", roomId: "room-r", name: "R2", sortOrder: 2 },
          ],
        },
        {
          id: "room-q",
          name: "Room Q",
          sortOrder: 2,
          beds: [
            { id: "bed-q1", roomId: "room-q", name: "Q1", sortOrder: 1 },
            { id: "bed-q2", roomId: "room-q", name: "Q2", sortOrder: 2 },
          ],
        },
      ],
      bookings: [
        heldBooking(
          "held-new",
          "2026-07-01",
          [{ id: "hn-a1" }, { id: "hn-a2" }],
          true,
        ),
      ],
      occupiedBedNights: [
        {
          bedId: "bed-r1",
          roomId: "room-r",
          bookingId: "prov-1",
          bookingGuestId: "p1-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          bookingCreatedAt: "2026-06-05T00:00:00.000Z",
        },
        {
          bedId: "bed-r2",
          roomId: "room-r",
          bookingId: "prov-2",
          bookingGuestId: "p2-ga",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          bookingCreatedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          bedId: "bed-q1",
          roomId: "room-q",
          bookingId: "prov-2",
          bookingGuestId: "p2-gb",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
          bookingCreatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    });

    // Held pair takes room R whole.
    expect(plan.allocations).toEqual([
      {
        bookingId: "held-new",
        bookingGuestId: "hn-a1",
        roomId: "room-r",
        bedId: "bed-r1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-new",
        bookingGuestId: "hn-a2",
        roomId: "room-r",
        bedId: "bed-r2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // P1 (evicted first, newest) MOVEs to q2 — never q1, which P2's row still
    // holds in the database; P2 is unallocated whole.
    expect(plan.displacements).toEqual([
      {
        type: "MOVE",
        bookingId: "prov-1",
        bookingGuestId: "p1-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-r1",
        fromRoomId: "room-r",
        toBedId: "bed-q2",
        toRoomId: "room-q",
        displacedByBookingId: "held-new",
      },
      {
        type: "UNALLOCATE",
        bookingId: "prov-2",
        bookingGuestId: "p2-gb",
        stayDate: "2026-07-01",
        fromBedId: "bed-q1",
        fromRoomId: "room-q",
        displacedByBookingId: "held-new",
      },
      {
        type: "UNALLOCATE",
        bookingId: "prov-2",
        bookingGuestId: "p2-ga",
        stayDate: "2026-07-01",
        fromBedId: "bed-r2",
        fromRoomId: "room-r",
        displacedByBookingId: "held-new",
      },
    ]);
    // Global apply-order safety: no MOVE destination may equal any other
    // displaced row's original bed-night — otherwise the row-by-row apply
    // would trip the unique constraint.
    const vacated = new Set(
      (plan.displacements ?? []).map(
        (displacement) => `${displacement.fromBedId}:${displacement.stayDate}`,
      ),
    );
    for (const displacement of plan.displacements ?? []) {
      if (displacement.type !== "MOVE" || !displacement.toBedId) continue;
      expect(
        vacated.has(`${displacement.toBedId}:${displacement.stayDate}`),
      ).toBe(false);
    }
  });

  it("re-plans a displaced provisional only within its own lodge, even when another lodge's beds sort first (#1677)", () => {
    // Lodge B's room sorts FIRST and has free beds, but the displaced lodge-A
    // provisional must relocate within lodge A (room A2), never across lodges.
    const plan = buildFirstFitBedAllocationPlan({
      enabled: true,
      prioritizeCapacityHolding: true,
      rooms: [
        {
          id: "room-b1",
          name: "Lodge B Room 1",
          sortOrder: 0,
          lodgeId: "lodge-b",
          beds: [
            { id: "bed-b1", roomId: "room-b1", name: "B1", sortOrder: 1 },
            { id: "bed-b2", roomId: "room-b1", name: "B2", sortOrder: 2 },
          ],
        },
        {
          id: "room-a1",
          name: "Lodge A Room 1",
          sortOrder: 1,
          lodgeId: "lodge-a",
          beds: [
            { id: "bed-a1", roomId: "room-a1", name: "A1", sortOrder: 1 },
            { id: "bed-a2", roomId: "room-a1", name: "A2", sortOrder: 2 },
          ],
        },
        {
          id: "room-a2",
          name: "Lodge A Room 2",
          sortOrder: 2,
          lodgeId: "lodge-a",
          beds: [{ id: "bed-a3", roomId: "room-a2", name: "A3", sortOrder: 1 }],
        },
      ],
      bookings: [
        {
          id: "held-a",
          createdAt: new Date("2026-06-01"),
          lodgeId: "lodge-a",
          holdsCapacity: true,
          requestedRoomId: null,
          guests: [
            {
              id: "held-a-g1",
              bookingId: "held-a",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-02"),
            },
            {
              id: "held-a-g2",
              bookingId: "held-a",
              ageTier: "ADULT",
              stayStart: parseDateOnly("2026-07-01"),
              stayEnd: parseDateOnly("2026-07-02"),
            },
          ],
        },
      ],
      occupiedBedNights: [
        {
          bedId: "bed-a2",
          roomId: "room-a1",
          bookingId: "prov",
          bookingGuestId: "prov-g1",
          stayDate: "2026-07-01",
          ageTier: "ADULT",
          holdsCapacity: false,
        },
      ],
    });

    expect(plan.allocations).toEqual([
      {
        bookingId: "held-a",
        bookingGuestId: "held-a-g1",
        roomId: "room-a1",
        bedId: "bed-a1",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
      {
        bookingId: "held-a",
        bookingGuestId: "held-a-g2",
        roomId: "room-a1",
        bedId: "bed-a2",
        stayDate: "2026-07-01",
        source: "AUTO",
      },
    ]);
    // The provisional MOVEs within lodge A — never onto lodge B's free beds.
    expect(plan.displacements).toEqual([
      {
        type: "MOVE",
        bookingId: "prov",
        bookingGuestId: "prov-g1",
        stayDate: "2026-07-01",
        fromBedId: "bed-a2",
        fromRoomId: "room-a1",
        toBedId: "bed-a3",
        toRoomId: "room-a2",
        displacedByBookingId: "held-a",
      },
    ]);
    expect(
      plan.allocations.some((allocation) => allocation.roomId === "room-b1"),
    ).toBe(false);
  });
});
