import { readFileSync } from "fs";
import path from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 29,
    source: "club_config",
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 29,
  }),
}));

import {
  BedAllocationAdminError,
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  buildBedAllocationWarnings,
  createBedAllocationBed,
  createBedAllocationRoom,
  createBedAllocationRoomsBulk,
  deleteBedAllocationRoom,
  approveBedAllocations,
  getBedAllocationDashboard,
  getRoomsAndBedsConfiguration,
  listBedAllocationRooms,
  manuallyAllocateBedForNights,
  parseBedAllocationDateRange,
  updateBedAllocationBed,
} from "@/lib/admin-bed-allocation";
import { getLodgeCapacityStatus } from "@/lib/lodge-capacity";
import { parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("admin bed allocation", () => {
  it("validates date-only allocation ranges", () => {
    expect(
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-07-08",
      }),
    ).toMatchObject({
      fromDate: "2026-07-01",
      toDate: "2026-07-08",
    });

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-08",
        to: "2026-07-01",
      }),
    ).toThrow(BedAllocationAdminError);

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-08-15",
      }),
    ).toThrow(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
    );
  });

  it("warns when bookings are split or minors are without a booking adult", () => {
    const warnings = buildBedAllocationWarnings({
      allocations: [
        {
          id: "allocation-1",
          bookingId: "booking-1",
          bookingGuestId: "adult-1",
          guestName: "Adult One",
          guestAgeTier: "ADULT",
          roomId: "room-a",
          roomName: "Room A",
          bedId: "bed-a1",
          bedName: "A1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
          bookingStatus: "CONFIRMED",
          holdsCapacity: true,
        },
        {
          id: "allocation-2",
          bookingId: "booking-1",
          bookingGuestId: "child-1",
          guestName: "Child One",
          guestAgeTier: "CHILD",
          roomId: "room-b",
          roomName: "Room B",
          bedId: "bed-b1",
          bedName: "B1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
          bookingStatus: "CONFIRMED",
          holdsCapacity: true,
        },
      ],
    });

    expect(warnings.map((warning) => warning.type)).toEqual([
      "BOOKING_SPLIT",
      "MINOR_WITHOUT_BOOKING_ADULT",
    ]);
  });

  it("warns once, stay-level, when a booking's rooms change between nights (ROOM_SWITCH, #1677)", () => {
    const allocation = (overrides: {
      bookingId: string;
      bookingGuestId: string;
      roomId: string;
      bedId: string;
      stayDate: string;
    }) => ({
      id: `${overrides.bookingGuestId}:${overrides.stayDate}`,
      guestName: "Guest",
      guestAgeTier: "ADULT" as const,
      roomName: overrides.roomId,
      bedName: overrides.bedId,
      source: "MANUAL" as const,
      approvedAt: null,
      approvedByName: null,
      bookingStatus: "CONFIRMED",
      holdsCapacity: true,
      ...overrides,
    });

    const warnings = buildBedAllocationWarnings({
      allocations: [
        // booking-switch: room A night 1, room B night 2 → ROOM_SWITCH.
        allocation({
          bookingId: "booking-switch",
          bookingGuestId: "guest-1",
          roomId: "room-a",
          bedId: "bed-a1",
          stayDate: "2026-07-01",
        }),
        allocation({
          bookingId: "booking-switch",
          bookingGuestId: "guest-1",
          roomId: "room-b",
          bedId: "bed-b1",
          stayDate: "2026-07-02",
        }),
        // booking-stable: same room both nights → no ROOM_SWITCH.
        allocation({
          bookingId: "booking-stable",
          bookingGuestId: "guest-2",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: "2026-07-01",
        }),
        allocation({
          bookingId: "booking-stable",
          bookingGuestId: "guest-2",
          roomId: "room-a",
          bedId: "bed-a2",
          stayDate: "2026-07-02",
        }),
      ],
    });

    const roomSwitchWarnings = warnings.filter(
      (warning) => warning.type === "ROOM_SWITCH",
    );
    expect(roomSwitchWarnings).toHaveLength(1);
    expect(roomSwitchWarnings[0]).toMatchObject({
      id: "ROOM_SWITCH:booking-switch",
      bookingId: "booking-switch",
      stayDate: "2026-07-02",
    });
    // No same-night split here, so BOOKING_SPLIT stays quiet.
    expect(
      warnings.filter((warning) => warning.type === "BOOKING_SPLIT"),
    ).toHaveLength(0);
  });

  it("keeps bed allocation routes feature gated", () => {
    const featureRoutes = readRepoFile("src/config/feature-routes.ts");
    const sidebar = readRepoFile("src/components/admin-sidebar.tsx");
    const bookingsSetupHub = readRepoFile(
      "src/app/(admin)/admin/bookings-setup/page.tsx"
    );

    expect(featureRoutes).toContain('flag: "bedAllocation"');
    expect(featureRoutes).toContain('"/admin/bed-allocation"');
    expect(featureRoutes).toContain('"/admin/rooms-beds"');
    expect(featureRoutes).toContain('"/api/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/bed-allocation"');
    expect(bookingsSetupHub).toContain('href: "/admin/rooms-beds"');
  });

  it("blocks deactivating a bed with future allocations", async () => {
    const update = vi.fn();
    const db = {
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([
          { stayDate: parseDateOnly("2026-07-01") },
          { stayDate: parseDateOnly("2026-07-03") },
        ]),
      },
      lodgeBed: {
        update,
      },
    };

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        active: false,
        db: db as never,
      }),
    ).rejects.toThrow(
      "Cannot deactivate this bed while future allocations exist on 2026-07-01, 2026-07-03.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("adds persistent admin-only mode settings", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const migration = readRepoFile(
      "prisma/migrations/20260607142000_add_bed_allocation_settings/migration.sql",
    );

    expect(schema).toContain("model BedAllocationSettings");
    expect(schema).toContain("autoAllocationEnabled Boolean");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "BedAllocationSettings"');
    expect(migration).toContain(
      'INSERT INTO "BedAllocationSettings" ("id")',
    );
  });
});

describe("manuallyAllocateBedForNights", () => {
  function buildGuest(overrides: Partial<{
    id: string;
    bookingId: string;
    stayStart: Date;
    stayEnd: Date;
    bookingStatus: string;
    bookingDeletedAt: Date | null;
  }> = {}) {
    return {
      id: overrides.id ?? "guest-1",
      bookingId: overrides.bookingId ?? "booking-1",
      stayStart: overrides.stayStart ?? parseDateOnly("2026-07-01"),
      stayEnd: overrides.stayEnd ?? parseDateOnly("2026-07-04"),
      booking: {
        id: overrides.bookingId ?? "booking-1",
        status: overrides.bookingStatus ?? "CONFIRMED",
        deletedAt: overrides.bookingDeletedAt ?? null,
      },
    };
  }

  function buildBed(overrides: Partial<{
    id: string;
    roomId: string;
    active: boolean;
    roomActive: boolean;
  }> = {}) {
    return {
      id: overrides.id ?? "bed-1",
      roomId: overrides.roomId ?? "room-1",
      active: overrides.active ?? true,
      room: { id: overrides.roomId ?? "room-1", active: overrides.roomActive ?? true },
    };
  }

  function buildDb(input: {
    guest: ReturnType<typeof buildGuest> | null;
    bed: ReturnType<typeof buildBed> | null;
    upsert: ReturnType<typeof vi.fn>;
  }) {
    return {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue(input.guest),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue(input.bed),
      },
      bedAllocation: {
        upsert: input.upsert,
      },
    };
  }

  it("allocates every requested night to the same bed", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      id: `allocation-${create.stayDate.toISOString().slice(0, 10)}`,
      ...create,
    }));
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-02", "2026-07-01", "2026-07-03"],
      db: db as never,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.allocations).toHaveLength(3);
    expect(upsert).toHaveBeenCalledTimes(3);
    // Processed in date order despite unsorted input.
    expect(upsert.mock.calls.map((call) => call[0].create.stayDate)).toEqual([
      parseDateOnly("2026-07-01"),
      parseDateOnly("2026-07-02"),
      parseDateOnly("2026-07-03"),
    ]);
  });

  it("reports a conflict for nights where the bed is already taken, without aborting other nights", async () => {
    const conflictError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ id: "allocation-1", stayDate: parseDateOnly("2026-07-01") })
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ id: "allocation-3", stayDate: parseDateOnly("2026-07-03") });
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-01", "2026-07-02", "2026-07-03"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.conflicts).toEqual([{ stayDate: "2026-07-02", reason: "BED_TAKEN" }]);
    expect(result.skipped).toEqual([]);
  });

  it("skips nights outside the guest's stay without treating them as conflicts", async () => {
    const upsert = vi.fn().mockImplementation(({ create }) => ({
      id: "allocation",
      ...create,
    }));
    // Guest only stays 2026-07-01 to 2026-07-03 (2 nights).
    const db = buildDb({
      guest: buildGuest({ stayStart: parseDateOnly("2026-07-01"), stayEnd: parseDateOnly("2026-07-03") }),
      bed: buildBed(),
      upsert,
    });

    const result = await manuallyAllocateBedForNights({
      bookingGuestId: "guest-1",
      bedId: "bed-1",
      stayDates: ["2026-07-01", "2026-07-02", "2026-07-03"],
      db: db as never,
    });

    expect(result.allocations).toHaveLength(2);
    expect(result.skipped).toEqual(["2026-07-03"]);
    expect(result.conflicts).toEqual([]);
  });

  it("rejects an empty stay date list", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: [],
        db: db as never,
      }),
    ).rejects.toThrow(BedAllocationAdminError);
  });

  it("rejects more nights than the allocation range cap", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed(), upsert: vi.fn() });
    const stayDates = Array.from({ length: MAX_BED_ALLOCATION_RANGE_NIGHTS + 1 }, (_, index) =>
      `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
    );

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates,
        db: db as never,
      }),
    ).rejects.toThrow(`Cannot allocate more than ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights at once`);
  });

  it("rejects when the guest does not exist", async () => {
    const db = buildDb({ guest: null, bed: buildBed(), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "missing-guest",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Guest not found");
  });

  it("rejects when the bed is inactive", async () => {
    const db = buildDb({ guest: buildGuest(), bed: buildBed({ active: false }), upsert: vi.fn() });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Active bed not found");
  });

  it("rejects when the booking status is not allocatable", async () => {
    const db = buildDb({
      guest: buildGuest({ bookingStatus: "CANCELLED" }),
      bed: buildBed(),
      upsert: vi.fn(),
    });

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Booking status is not allocatable");
  });
});

describe("bed type + bunk pairing (#1675)", () => {
  function buildBunkDb(
    overrides: {
      groupMembers?: Array<{ id: string; bedType: string }>;
      existingBed?: {
        roomId: string;
        bedType: string;
        bunkGroup: string | null;
      } | null;
    } = {},
  ) {
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "new-bed", ...data }));
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "bed-1", ...data }));
    const findMany = vi
      .fn()
      .mockResolvedValue(overrides.groupMembers ?? []);
    const findUnique = vi
      .fn()
      .mockResolvedValue(overrides.existingBed ?? null);
    // The room-row lock is a tagged-template $queryRaw; a plain mock suffices.
    const queryRaw = vi.fn().mockResolvedValue([]);
    return {
      db: {
        $queryRaw: queryRaw,
        lodgeBed: { create, update, findMany, findUnique },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
      },
      create,
      update,
      findMany,
      findUnique,
      queryRaw,
    };
  }

  it("creates each bed type; ungrouped beds skip the room lock", async () => {
    for (const bedType of ["SINGLE", "DOUBLE", "BUNK_TOP", "BUNK_BOTTOM"] as const) {
      const { db, create, findMany, queryRaw } = buildBunkDb();
      const bed = await createBedAllocationBed({
        roomId: "room-1",
        name: "Bed",
        bedType,
        db: db as never,
      });
      expect(bed).toMatchObject({ bedType, bunkGroup: null });
      // No bunkGroup => no membership check and no serialising lock.
      expect(findMany).not.toHaveBeenCalled();
      expect(queryRaw).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ bedType, bunkGroup: null }),
      });
    }
  });

  it("pairs a bunk-bottom into a group that already holds a bunk-top", async () => {
    const { db, create, findMany, queryRaw } = buildBunkDb({
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await createBedAllocationBed({
      roomId: "room-1",
      name: "Lower",
      bedType: "BUNK_BOTTOM",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    // Serialised under the room lock, scoped to this room + group.
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
        }),
      }),
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      }),
    });
  });

  it("rejects a third bed in a bunk group", async () => {
    const { db, create } = buildBunkDb({
      groupMembers: [
        { id: "top", bedType: "BUNK_TOP" },
        { id: "bottom", bedType: "BUNK_BOTTOM" },
      ],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Extra",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow('Bunk group "Bunk A" already has two beds');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects two tops in the same group", async () => {
    const { db, create } = buildBunkDb({
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Another top",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow('already has a bunk-top bed');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a bunk group on a non-bunk bed type", async () => {
    const { db, create, findMany } = buildBunkDb();

    await expect(
      createBedAllocationBed({
        roomId: "room-1",
        name: "Single with group",
        bedType: "SINGLE",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toMatchObject({
      message: "A bunk group needs a bunk-top or bunk-bottom bed type.",
      status: 400,
    });
    // Consistency is checked before any DB work.
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("allows an unpaired bunk (bunk type, no group) without a soft error", async () => {
    const { db, create, findMany } = buildBunkDb();

    await createBedAllocationBed({
      roomId: "room-1",
      name: "Lonely bunk",
      bedType: "BUNK_TOP",
      bunkGroup: null,
      db: db as never,
    });

    expect(findMany).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ bedType: "BUNK_TOP", bunkGroup: null }),
    });
  });

  it("isolates groups by room — same group name in another room does not clash", async () => {
    // findMany is scoped to the requested room, so a full "Bunk A" in room-1
    // is invisible when adding "Bunk A" in room-2.
    const { db, create, findMany } = buildBunkDb({ groupMembers: [] });

    await createBedAllocationBed({
      roomId: "room-2",
      name: "New bunk",
      bedType: "BUNK_TOP",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ roomId: "room-2", bunkGroup: "Bunk A" }),
      }),
    );
    expect(create).toHaveBeenCalled();
  });

  it("re-validates pairing on update and excludes the bed being edited", async () => {
    const { db, update, findMany, findUnique } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "SINGLE", bunkGroup: null },
      groupMembers: [{ id: "top", bedType: "BUNK_TOP" }],
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bedType: "BUNK_BOTTOM",
      bunkGroup: "Bunk A",
      db: db as never,
    });

    expect(findUnique).toHaveBeenCalled();
    // The edited bed must not conflict with itself in the membership check.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
          id: { not: "bed-1" },
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      }),
    });
  });

  it("rejects an update that leaves a group on a non-bunk type", async () => {
    // Existing single bed; caller adds a group but keeps the single type.
    const { db, update } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "SINGLE", bunkGroup: null },
    });

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        bunkGroup: "Bunk A",
        db: db as never,
      }),
    ).rejects.toThrow(
      "A bunk group needs a bunk-top or bunk-bottom bed type.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("clears a group when updating with an empty bunkGroup string", async () => {
    const { db, update, findMany } = buildBunkDb({
      existingBed: {
        roomId: "room-1",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
      },
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bunkGroup: "   ",
      db: db as never,
    });

    // No group => no membership check; the column is nulled.
    expect(findMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({ bunkGroup: null }),
    });
  });

  it("re-validates under the stored group when a bedType-only update omits bunkGroup", async () => {
    // A PATCH that changes only the bedType (no bunkGroup key) must layer the
    // change over the bed's *stored* group, not treat the group as null — so it
    // still takes the room lock and runs the membership check against "Bunk A".
    // If the existing.bunkGroup fallback regressed to null, nextBunkGroup would
    // be null and neither the lock nor findMany would run, failing this test.
    const { db, update, findMany, queryRaw } = buildBunkDb({
      existingBed: { roomId: "room-1", bedType: "BUNK_TOP", bunkGroup: "Bunk A" },
      // The bed being edited is excluded from the membership query, so an empty
      // result means "no other bed in this group yet".
      groupMembers: [],
    });

    await updateBedAllocationBed({
      id: "bed-1",
      bedType: "BUNK_BOTTOM",
      db: db as never,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          roomId: "room-1",
          bunkGroup: "Bunk A",
          id: { not: "bed-1" },
        }),
      }),
    );
    // bunkGroup was not in the patch, so the column is left untouched.
    expect(update).toHaveBeenCalledWith({
      where: { id: "bed-1" },
      data: expect.objectContaining({ bedType: "BUNK_BOTTOM" }),
    });
    expect(update.mock.calls[0][0].data.bunkGroup).toBeUndefined();
  });
});

describe("bunk write transaction self-wrap (#1675)", () => {
  // These exercise the branches that self-wrap in prisma.$transaction when no
  // db is injected — the room-row FOR UPDATE lock is only a real serialisation
  // point inside a transaction, so dropping the wrap (leaving the lock as a
  // statement-scoped no-op) must fail a test. The mocked prisma singleton is
  // otherwise `{}`, so any path that skips the wrap and reaches for
  // prisma.lodgeBed would throw here rather than silently pass.
  const prismaMock = prisma as unknown as {
    $transaction?: unknown;
    lodgeBed?: unknown;
  };

  it("self-wraps a grouped create and runs the lock, membership check, and write on the tx client", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      lodgeBed: {
        findMany: vi.fn().mockResolvedValue([{ id: "top", bedType: "BUNK_TOP" }]),
        create: vi
          .fn()
          .mockImplementation(({ data }) => ({ id: "new-bed", ...data })),
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await createBedAllocationBed({
        roomId: "room-1",
        name: "Lower",
        bedType: "BUNK_BOTTOM",
        bunkGroup: "Bunk A",
      });

      expect(txnMock).toHaveBeenCalledTimes(1);
      // Lock, membership check, and write all ran on the tx client.
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.lodgeBed.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: "room-1",
            bunkGroup: "Bunk A",
          }),
        }),
      );
      expect(tx.lodgeBed.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bedType: "BUNK_BOTTOM",
          bunkGroup: "Bunk A",
        }),
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("self-wraps a bunk-affecting update and runs the lock, membership check, and write on the tx client", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      lodgeBed: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ roomId: "room-1", bedType: "SINGLE", bunkGroup: null }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi
          .fn()
          .mockImplementation(({ data }) => ({ id: "bed-1", ...data })),
      },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    prismaMock.$transaction = txnMock;
    try {
      await updateBedAllocationBed({
        id: "bed-1",
        bedType: "BUNK_TOP",
        bunkGroup: "Bunk A",
      });

      expect(txnMock).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.lodgeBed.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: "room-1",
            bunkGroup: "Bunk A",
            id: { not: "bed-1" },
          }),
        }),
      );
      expect(tx.lodgeBed.update).toHaveBeenCalledWith({
        where: { id: "bed-1" },
        data: expect.objectContaining({
          bedType: "BUNK_TOP",
          bunkGroup: "Bunk A",
        }),
      });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("does NOT open a transaction for an ungrouped create without a db", async () => {
    // No bunkGroup => nothing to serialise, so the create runs directly on the
    // prisma singleton and never touches $transaction.
    const create = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "new-bed", ...data }));
    const txnMock = vi.fn();
    prismaMock.$transaction = txnMock;
    prismaMock.lodgeBed = { create };
    try {
      await createBedAllocationBed({
        roomId: "room-1",
        name: "Solo",
        bedType: "SINGLE",
      });

      expect(txnMock).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({ bedType: "SINGLE", bunkGroup: null }),
      });
    } finally {
      delete prismaMock.$transaction;
      delete prismaMock.lodgeBed;
    }
  });

  it("does NOT open a transaction for an update that touches neither bed type nor group", async () => {
    // A name-only PATCH is not bunk-affecting, so it skips the transaction and
    // updates on the prisma singleton directly.
    const update = vi
      .fn()
      .mockImplementation(({ data }) => ({ id: "bed-1", ...data }));
    const txnMock = vi.fn();
    prismaMock.$transaction = txnMock;
    prismaMock.lodgeBed = { update };
    try {
      await updateBedAllocationBed({ id: "bed-1", name: "Renamed" });

      expect(txnMock).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith({
        where: { id: "bed-1" },
        data: { name: "Renamed" },
      });
    } finally {
      delete prismaMock.$transaction;
      delete prismaMock.lodgeBed;
    }
  });
});

describe("multi-lodge room scoping (phase 7)", () => {
  it("filters rooms strictly to a lodge", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lodgeRoom: { findMany } };

    await listBedAllocationRooms(db as never, "lodge-2");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
  });

  it("lists every room when no lodge filter is given", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { lodgeRoom: { findMany } };

    await listBedAllocationRooms(db as never);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("creates rooms at the requested lodge without consulting the default", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    const findFirst = vi.fn();
    const db = {
      // Per-lodge name pre-check: no clash in these fixtures.
      lodgeRoom: { create, findFirst: vi.fn().mockResolvedValue(null) },
      lodge: { findFirst },
    };

    await createBedAllocationRoom({
      name: "Bunkroom 1",
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-2" }),
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("stamps the default lodge when no lodge is requested", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    const findFirst = vi.fn().mockResolvedValue({ id: "lodge-default" });
    const db = {
      lodgeRoom: { create, findFirst: vi.fn().mockResolvedValue(null) },
      lodge: { findFirst },
    };

    await createBedAllocationRoom({ name: "Bunkroom 1", db: db as never });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ lodgeId: "lodge-default" }),
    });
  });

  it("reports capacity for the requested lodge and keeps the import offer global", async () => {
    const db = {
      lodgeRoom: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(3),
      },
      lodgeBed: {
        count: vi.fn().mockResolvedValue(12),
      },
      lodge: { findFirst: vi.fn() },
    };

    const payload = await getRoomsAndBedsConfiguration(db as never, "lodge-2");

    expect(getLodgeCapacityStatus).toHaveBeenCalledWith("lodge-2", db);
    // Rooms exist elsewhere in the club, so the empty selected lodge must
    // not offer the config import (it only seeds the first lodge).
    expect(payload.canImportFromConfig).toBe(false);
    expect(db.lodge.findFirst).not.toHaveBeenCalled();
  });
});

describe("createBedAllocationRoomsBulk (ADR-003 bulk seeding)", () => {
  function buildBulkDb(overrides: {
    clashName?: string | null;
    existingRoomCount?: number;
  } = {}) {
    const roomCreate = vi
      .fn()
      .mockImplementation(({ data }) =>
        Promise.resolve({ id: `room-${data.name}`, ...data }),
      );
    const bedCreateMany = vi.fn().mockResolvedValue({ count: 0 });
    return {
      db: {
        lodgeRoom: {
          create: roomCreate,
          count: vi.fn().mockResolvedValue(overrides.existingRoomCount ?? 0),
          findFirst: vi
            .fn()
            .mockResolvedValue(
              overrides.clashName ? { name: overrides.clashName } : null,
            ),
        },
        lodgeBed: { createMany: bedCreateMany },
        lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
      },
      roomCreate,
      bedCreateMany,
    };
  }

  it("creates N rooms of M beds with sequential names at the given lodge", async () => {
    const { db, roomCreate, bedCreateMany } = buildBulkDb();

    const result = await createBedAllocationRoomsBulk({
      roomCount: 3,
      bedsPerRoom: 4,
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(result).toEqual({ createdRoomCount: 3, createdBedCount: 12 });
    expect(roomCreate).toHaveBeenCalledTimes(3);
    expect(roomCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        name: "Room 1",
        sortOrder: 1,
        lodgeId: "lodge-2",
      }),
    });
    expect(bedCreateMany).toHaveBeenCalledTimes(3);
    expect(bedCreateMany.mock.calls[0][0].data).toHaveLength(4);
    expect(bedCreateMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ name: "Bed 1", sortOrder: 1, active: true }),
    );
  });

  it("continues sort order after the lodge's existing rooms and honours the prefix", async () => {
    const { db, roomCreate } = buildBulkDb({ existingRoomCount: 5 });

    await createBedAllocationRoomsBulk({
      roomCount: 1,
      bedsPerRoom: 0,
      namePrefix: "Bunkroom",
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(roomCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: "Bunkroom 1", sortOrder: 6 }),
    });
  });

  it("rejects the whole batch when a generated name already exists", async () => {
    const { db, roomCreate } = buildBulkDb({ clashName: "Room 2" });

    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 3,
        bedsPerRoom: 2,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow('A room named "Room 2" already exists');
    expect(roomCreate).not.toHaveBeenCalled();
  });

  it("allows the same room name at a different lodge", async () => {
    const create = vi.fn().mockResolvedValue({ id: "room-1" });
    // The pre-check runs strictly against the lodge's own partition — a
    // "Room 1" at another lodge must not match.
    const roomFindFirst = vi.fn(async ({ where }: { where: { lodgeId?: unknown } }) => {
      expect(where).toMatchObject({
        name: "Room 1",
        lodgeId: "lodge-2",
      });
      return null;
    });
    const db = { lodgeRoom: { create, findFirst: roomFindFirst }, lodge: { findFirst: vi.fn() } };

    await createBedAllocationRoom({
      name: "Room 1",
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(roomFindFirst).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalled();
  });

  it("rejects a duplicate room name within the same lodge", async () => {
    const create = vi.fn();
    const db = {
      lodgeRoom: {
        create,
        findFirst: vi.fn().mockResolvedValue({ id: "existing" }),
      },
      lodge: { findFirst: vi.fn() },
    };

    await expect(
      createBedAllocationRoom({
        name: "Room 1",
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow('A room named "Room 1" already exists at this lodge.');
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects out-of-range counts", async () => {
    const { db } = buildBulkDb();

    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 0,
        bedsPerRoom: 2,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow("Room count must be between");
    await expect(
      createBedAllocationRoomsBulk({
        roomCount: 1,
        bedsPerRoom: 99,
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toThrow("Beds per room must be between");
  });
});

describe("bed allocation board lodge scope (ADR-003)", () => {
  function buildDashboardDb() {
    const bookingFindMany = vi.fn().mockResolvedValue([]);
    const allocationFindMany = vi.fn().mockResolvedValue([]);
    const roomFindMany = vi.fn().mockResolvedValue([]);
    return {
      db: {
        bedAllocationSettings: {
          findUnique: vi.fn().mockResolvedValue({
            autoAllocationEnabled: false,
            updatedByMemberId: null,
            updatedAt: parseDateOnly("2026-07-01"),
          }),
        },
        lodgeRoom: { findMany: roomFindMany },
        booking: { findMany: bookingFindMany },
        bedAllocation: { findMany: allocationFindMany },
      },
      bookingFindMany,
      allocationFindMany,
      roomFindMany,
    };
  }

  const range = parseBedAllocationDateRange({
    from: "2026-07-01",
    to: "2026-07-08",
  });

  it("scopes rooms, bookings, and allocations strictly to the lodge", async () => {
    const { db, bookingFindMany, allocationFindMany, roomFindMany } =
      buildDashboardDb();

    await getBedAllocationDashboard({ range, lodgeId: "lodge-2", db: db as never });

    expect(roomFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { lodgeId: "lodge-2" },
      }),
    );
    expect(bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lodgeId: "lodge-2",
        }),
      }),
    );
    expect(allocationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          room: { lodgeId: "lodge-2" },
        }),
      }),
    );
  });

  it("stays club-wide when no lodge is given", async () => {
    const { db, bookingFindMany, allocationFindMany, roomFindMany } =
      buildDashboardDb();

    await getBedAllocationDashboard({ range, db: db as never });

    expect(roomFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
    expect(bookingFindMany.mock.calls[0][0].where.OR).toBeUndefined();
    expect(allocationFindMany.mock.calls[0][0].where.room).toBeUndefined();
  });

  it("scopes range approval to the lodge's rooms", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const db = { bedAllocation: { updateMany } };

    await approveBedAllocations({
      approvedByMemberId: "admin-1",
      range,
      lodgeId: "lodge-2",
      db: db as never,
    });

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          room: { lodgeId: "lodge-2" },
        }),
      }),
    );
  });

  it("rejects allocating a guest to another lodge's bed", async () => {
    const upsert = vi.fn();
    const db = {
      bookingGuest: {
        findUnique: vi.fn().mockResolvedValue({
          id: "guest-1",
          bookingId: "booking-1",
          stayStart: parseDateOnly("2026-07-01"),
          stayEnd: parseDateOnly("2026-07-04"),
          booking: {
            id: "booking-1",
            status: "CONFIRMED",
            deletedAt: null,
            lodgeId: "lodge-1",
          },
        }),
      },
      lodgeBed: {
        findUnique: vi.fn().mockResolvedValue({
          id: "bed-1",
          roomId: "room-1",
          active: true,
          room: { id: "room-1", active: true, lodgeId: "lodge-2" },
        }),
      },
      bedAllocation: { upsert },
    };

    await expect(
      manuallyAllocateBedForNights({
        bookingGuestId: "guest-1",
        bedId: "bed-1",
        stayDates: ["2026-07-01"],
        db: db as never,
      }),
    ).rejects.toThrow("Bed belongs to a different lodge than the booking");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("getBedAllocationDashboard focused booking (#1302)", () => {
  function buildDashboardDb(overrides: {
    bookingFindMany?: unknown[];
    focusedBooking?: {
      id: string;
      checkIn: Date;
      checkOut: Date;
    } | null;
  }) {
    const findFirst = vi
      .fn()
      .mockResolvedValue(overrides.focusedBooking ?? null);
    return {
      db: {
        bedAllocationSettings: { findUnique: vi.fn().mockResolvedValue(null) },
        lodgeRoom: { findMany: vi.fn().mockResolvedValue([]) },
        bedAllocation: { findMany: vi.fn().mockResolvedValue([]) },
        booking: {
          findMany: vi
            .fn()
            .mockResolvedValue(overrides.bookingFindMany ?? []),
          findFirst,
        },
      },
      findFirst,
    };
  }

  const range = {
    from: parseDateOnly("2026-07-01"),
    to: parseDateOnly("2026-07-08"),
    fromDate: "2026-07-01",
    toDate: "2026-07-08",
  };

  it("returns the stay window when the focused booking is out of range", async () => {
    const { db, findFirst } = buildDashboardDb({
      focusedBooking: {
        id: "booking-past",
        checkIn: new Date("2026-06-10"),
        checkOut: new Date("2026-06-12"),
      },
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-past",
      db: db as never,
    });

    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(dashboard.focusedBooking).toEqual({
      id: "booking-past",
      checkIn: "2026-06-10",
      checkOut: "2026-06-12",
    });
  });

  it("skips the lookup and returns null when the focused booking is already in range", async () => {
    const { db, findFirst } = buildDashboardDb({
      bookingFindMany: [
        {
          id: "booking-in-range",
          status: "CONFIRMED",
          createdAt: new Date("2026-06-01"),
          checkIn: new Date("2026-07-02"),
          checkOut: new Date("2026-07-04"),
          requestedRoomId: null,
          parentBookingId: null,
          originBookingRequest: null,
          requestedRoom: null,
          member: { firstName: "Ada", lastName: "Lovelace", email: null },
          guests: [],
        },
      ],
    });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-in-range",
      db: db as never,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(dashboard.focusedBooking).toBeNull();
  });

  it("returns null when the focused booking is not an allocatable booking", async () => {
    const { db } = buildDashboardDb({ focusedBooking: null });

    const dashboard = await getBedAllocationDashboard({
      range,
      bookingId: "booking-cancelled",
      db: db as never,
    });

    expect(dashboard.focusedBooking).toBeNull();
  });

  it("returns null when no booking is focused", async () => {
    const { db, findFirst } = buildDashboardDb({});

    const dashboard = await getBedAllocationDashboard({
      range,
      db: db as never,
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(dashboard.focusedBooking).toBeNull();
  });
});

describe("deleteBedAllocationRoom (#1674 guarded hard delete)", () => {
  function buildDeleteDb(overrides: {
    room?: { id: string; lodgeId?: string } | null;
    allocation?: { id: string } | null;
    deleteRejects?: unknown;
  } = {}) {
    const roomFindFirst = vi
      .fn()
      .mockResolvedValue(
        overrides.room === undefined ? { id: "room-1" } : overrides.room,
      );
    const allocationFindFirst = vi
      .fn()
      .mockResolvedValue(overrides.allocation ?? null);
    const bedDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const roomDelete =
      overrides.deleteRejects !== undefined
        ? vi.fn().mockRejectedValue(overrides.deleteRejects)
        : vi.fn().mockResolvedValue({ id: "room-1", name: "Bunkroom" });
    return {
      db: {
        lodgeRoom: { findFirst: roomFindFirst, delete: roomDelete },
        bedAllocation: { findFirst: allocationFindFirst },
        lodgeBed: { deleteMany: bedDeleteMany },
      },
      roomFindFirst,
      allocationFindFirst,
      bedDeleteMany,
      roomDelete,
    };
  }

  it("deletes the room and its beds when there is no allocation history", async () => {
    const { db, allocationFindFirst, bedDeleteMany, roomDelete } =
      buildDeleteDb();

    const result = await deleteBedAllocationRoom({
      id: "room-1",
      db: db as never,
    });

    // Guard checks any allocation for the room, with no date filter, so any
    // history (past or future) blocks the delete.
    expect(allocationFindFirst).toHaveBeenCalledWith({
      where: { roomId: "room-1" },
      select: { id: true },
    });
    expect(bedDeleteMany).toHaveBeenCalledWith({
      where: { roomId: "room-1" },
    });
    expect(roomDelete).toHaveBeenCalledWith({ where: { id: "room-1" } });
    expect(result).toEqual({ id: "room-1", name: "Bunkroom" });
  });

  it("blocks deletion when the room has past allocation history", async () => {
    const { db, bedDeleteMany, roomDelete } = buildDeleteDb({
      allocation: { id: "allocation-past" },
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
    expect(bedDeleteMany).not.toHaveBeenCalled();
    expect(roomDelete).not.toHaveBeenCalled();
  });

  it("blocks deletion when the room has only future allocations", async () => {
    // Same guard as the past-only case: the history check is date-agnostic, so
    // a future-dated allocation blocks a hard delete just the same.
    const { db, roomDelete } = buildDeleteDb({
      allocation: { id: "allocation-future" },
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(BedAllocationAdminError);
    expect(roomDelete).not.toHaveBeenCalled();
  });

  it("throws a 404 for an unknown room", async () => {
    const { db, allocationFindFirst } = buildDeleteDb({ room: null });

    await expect(
      deleteBedAllocationRoom({ id: "missing", db: db as never }),
    ).rejects.toMatchObject({ message: "Room not found", status: 404 });
    expect(allocationFindFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the given lodge and 404s on a mismatch", async () => {
    const { db, roomFindFirst } = buildDeleteDb({ room: null });

    await expect(
      deleteBedAllocationRoom({
        id: "room-1",
        lodgeId: "lodge-2",
        db: db as never,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(roomFindFirst).toHaveBeenCalledWith({
      where: { id: "room-1", lodgeId: "lodge-2" },
      select: { id: true },
    });
  });

  it("wraps in a transaction and runs the guard + deletes on the tx client when no db is passed", async () => {
    // Without an injected db the function must self-wrap in prisma.$transaction
    // and run the guard AND deletes on the tx client the callback receives, so
    // the guard cannot be hoisted out of the transaction (or the wrap dropped)
    // without failing this test. The tx client is a distinct object from the
    // top-level prisma singleton, which has no room/bed methods here.
    const tx = {
      lodgeRoom: {
        findFirst: vi.fn().mockResolvedValue({ id: "room-1" }),
        delete: vi.fn().mockResolvedValue({ id: "room-1", name: "Bunkroom" }),
      },
      bedAllocation: { findFirst: vi.fn().mockResolvedValue(null) },
      lodgeBed: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    const txnMock = vi.fn(async (cb: (client: typeof tx) => unknown) => cb(tx));
    const prismaMock = prisma as unknown as { $transaction?: unknown };
    prismaMock.$transaction = txnMock;
    try {
      const result = await deleteBedAllocationRoom({ id: "room-1" });

      expect(txnMock).toHaveBeenCalledTimes(1);
      expect(tx.bedAllocation.findFirst).toHaveBeenCalledWith({
        where: { roomId: "room-1" },
        select: { id: true },
      });
      expect(tx.lodgeBed.deleteMany).toHaveBeenCalledWith({
        where: { roomId: "room-1" },
      });
      expect(tx.lodgeRoom.delete).toHaveBeenCalledWith({
        where: { id: "room-1" },
      });
      expect(result).toEqual({ id: "room-1", name: "Bunkroom" });
    } finally {
      delete prismaMock.$transaction;
    }
  });

  it("maps an ambiguous P2003 (no constraint metadata) to the allocation-history message", async () => {
    // The pg adapter can drop the constraint field; with nothing to classify
    // on, fall back to the allocation-history steer (the common case).
    const { db, roomDelete } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError("FK", {
        code: "P2003",
        clientVersion: "test",
      }),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
    expect(roomDelete).toHaveBeenCalled();
  });

  it("maps a BedAllocation FK violation to the allocation-history message", async () => {
    const { db } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated",
        {
          code: "P2003",
          clientVersion: "test",
          meta: { field_name: "BedAllocation_bedId_roomId_fkey (index)" },
        },
      ),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "This room has allocation history and cannot be deleted. Deactivate it instead.",
    );
  });

  it("maps a concurrent bed-creation FK (LodgeBed->room) to a retry message, not history", async () => {
    // A bed added by another admin between the guard and the room delete trips
    // the LodgeBed->room Restrict FK — not allocation history, so steer to a
    // retry rather than to Deactivate.
    const { db, roomDelete } = buildDeleteDb({
      deleteRejects: new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint violated",
        {
          code: "P2003",
          clientVersion: "test",
          meta: { field_name: "LodgeBed_roomId_fkey (index)" },
        },
      ),
    });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toThrow(
      "Room changed while deleting (a bed was just added). Refresh and try again.",
    );
    expect(roomDelete).toHaveBeenCalled();
  });

  it("rethrows a non-FK Prisma error (P2025) unmapped", async () => {
    const notFound = new Prisma.PrismaClientKnownRequestError("Record not found", {
      code: "P2025",
      clientVersion: "test",
    });
    const { db } = buildDeleteDb({ deleteRejects: notFound });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toBe(notFound);
  });

  it("rethrows a non-Prisma error unmapped", async () => {
    const boom = new Error("boom");
    const { db } = buildDeleteDb({ deleteRejects: boom });

    await expect(
      deleteBedAllocationRoom({ id: "room-1", db: db as never }),
    ).rejects.toBe(boom);
  });
});
