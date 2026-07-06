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

  it("allocates each booking night independently", () => {
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

  it("leaves the pre-existing (buggy) behaviour untouched when the flag is off", () => {
    // A provisional-occupied bed still blocks a held booking, and no
    // displacements are emitted, so every existing caller is unaffected.
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

  it("relocates a provisional minor only to a room that keeps its own booking's adult", () => {
    // Rooms A(A1,A2) B(B1) C(C1,C2). Provisional family: child at A2, adult at
    // C1. A held family (adult+child) forces the held child into room A, whose
    // A2 is the provisional child. A free bed exists in room B (no provisional
    // adult) AND room C (the provisional adult's room). The provisional child
    // must be MOVED to room C — never to room B, which would strand it.
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
    // Provisional child MOVED to C2 (room C has its adult), NOT to B1.
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

  it("places a held family adults-first so a child ordered before its adult still fits when both need displacement", () => {
    // Rooms A(A1,A2) B(B1,B2), all four beds held by distinct provisional
    // adults, no free bed. The held family lists the CHILD before the ADULT.
    // Adults-first ordering displaces-in the held adult (establishing its room)
    // before the child, so both fit; visiting the child first would drop it.
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
    // Two UNALLOCATEs (no free bed to relocate to): the two room-A provisionals.
    expect(plan.displacements).toHaveLength(2);
    expect(
      plan.displacements?.map((displacement) => ({
        type: displacement.type,
        bookingGuestId: displacement.bookingGuestId,
      })),
    ).toEqual([
      { type: "UNALLOCATE", bookingGuestId: "prov-1-adult" },
      { type: "UNALLOCATE", bookingGuestId: "prov-2-adult" },
    ]);
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
});
