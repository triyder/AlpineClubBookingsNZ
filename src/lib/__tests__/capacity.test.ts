import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { BookingStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";
import { capacityHoldingBookingFilter } from "@/lib/booking-status";

const mocks = vi.hoisted(() => ({
  bookingFindMany: vi.fn(),
  clubModuleSettingsFindUnique: vi.fn(),
  lodgeBedCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mocks.bookingFindMany,
    },
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: {
      count: mocks.lodgeBedCount,
    },
  },
}));

import {
  acquireLodgeCapacityLock,
  checkCapacity,
  checkCapacityForGuestRanges,
  getMonthAvailability,
} from "@/lib/capacity";
import {
  overCapacityNights,
  OverCapacityConfirmationRequiredError,
} from "@/lib/over-capacity-confirmation";
import {
  FALLBACK_LODGE_CAPACITY,
  getLodgeCapacityStatus,
} from "@/lib/lodge-capacity";

const TEST_LODGE_CAPACITY = FALLBACK_LODGE_CAPACITY;
const LODGE_A = "lodge-a";
const LODGE_B = "lodge-b";

// db without a lodge delegate: the requested lodge is treated as the default
// lodge, preserving legacy single-lodge behaviour (club-config fallback).
function singleLodgeDb(overrides: Record<string, unknown> = {}) {
  return {
    clubModuleSettings: {
      findUnique: mocks.clubModuleSettingsFindUnique,
    },
    lodgeBed: {
      count: mocks.lodgeBedCount,
    },
    ...overrides,
  } as never;
}

// db where LODGE_A is the default (oldest active) lodge.
function twoLodgeDb(overrides: Record<string, unknown> = {}) {
  return singleLodgeDb({
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: LODGE_A }),
    },
    ...overrides,
  });
}

describe("capacity calendar availability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  it("uses club config capacity when the bed allocation module is off", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: false,
      activeBedCount: 0,
    });
    expect(mocks.lodgeBedCount).not.toHaveBeenCalled();
  });

  it("uses active configured beds when the bed allocation module is on with beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(17);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: 17,
      source: "configured_beds",
      bedAllocationEnabled: true,
      activeBedCount: 17,
    });
  });

  it("scopes the active bed count to the requested lodge's rooms", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(6);

    await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(mocks.lodgeBedCount).toHaveBeenCalledWith({
      where: { active: true, room: { lodgeId: LODGE_A } },
    });
  });

  it("falls back to club config when the bed allocation module is on with zero active beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "club_config",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
  });

  it("uses the admin lodge capacity override as the fallback", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 42,
      source: "capacity_override",
      bedAllocationEnabled: false,
      activeBedCount: 0,
      fallbackCapacity: 42,
    });
  });

  it("prefers active configured beds over the capacity override", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(20);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 20,
      source: "configured_beds",
      bedAllocationEnabled: true,
      activeBedCount: 20,
      fallbackCapacity: 42,
    });
  });

  it("caps configured beds at a lower capacity ceiling (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(40);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 30,
      source: "capped_beds",
      bedAllocationEnabled: true,
      activeBedCount: 40,
      fallbackCapacity: 30,
    });
  });

  it("does not cap when the capacity equals the bed count (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(30);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 30,
      source: "configured_beds",
      activeBedCount: 30,
    });
  });

  it("uses the per-lodge capacity when the module is on but no beds exist yet (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 25 }),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 25,
      source: "capacity_override",
      bedAllocationEnabled: true,
      activeBedCount: 0,
    });
  });

  it("does not cap the bed count with the club-config fallback — only an explicit capacity caps (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    // More active beds than the club-config total, and NO per-lodge capacity.
    mocks.lodgeBedCount.mockResolvedValue(TEST_LODGE_CAPACITY + 10);

    const status = await getLodgeCapacityStatus(LODGE_A, singleLodgeDb());

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY + 10,
      source: "configured_beds",
      activeBedCount: TEST_LODGE_CAPACITY + 10,
    });
  });

  it("checkCapacity enforces the capped capacity, not the raw bed count (#1653)", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(40);
    mocks.bookingFindMany.mockResolvedValue([]);

    const db = singleLodgeDb({
      lodgeSettings: {
        findUnique: vi.fn().mockResolvedValue({ capacity: 30 }),
      },
      booking: { findMany: mocks.bookingFindMany },
    });

    // 35 guests fit the 40 installed beds but exceed the 30 sleeping cap.
    const rejected = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      35,
      undefined,
      db,
    );
    expect(rejected.available).toBe(false);
    expect(rejected.minAvailable).toBe(30);

    // 30 guests sit exactly on the cap and are allowed.
    const allowed = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      30,
      undefined,
      db,
    );
    expect(allowed.available).toBe(true);
  });

  it("emits one key for each date-only day in the requested month", async () => {
    const availability = await getMonthAvailability(LODGE_A, 2026, 3);
    const keys = [...availability.keys()];

    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe("2026-04-01");
    expect(keys.at(-1)).toBe("2026-04-30");
    expect(availability.get("2026-04-30")).toBe(0);
    expect(availability.has("2026-03-31")).toBe(false);
  });

  it("queries the full month using date-only exclusive end boundaries", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.checkIn.lt).toEqual(parseDateOnly("2026-05-01"));
    expect(call.where.checkOut.gt).toEqual(parseDateOnly("2026-04-01"));
  });

  it("counts bookings that start on the final day of the month", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-04-30"),
        checkOut: parseDateOnly("2026-05-02"),
        guests: [{ id: "g1" }, { id: "g2" }],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-29")).toBe(0);
    expect(availability.get("2026-04-30")).toBe(2);
  });

  it("queries completed bookings as capacity-holding bookings", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    // Capacity-holding is now an OR of the holding-status set plus
    // request-converted PENDING holds (issue #1254, refining #737).
    const call = mocks.bookingFindMany.mock.calls[0][0];
    const holdingStatusClause = call.where.OR.find(
      (clause: { status?: { in?: BookingStatus[] } }) =>
        Array.isArray(clause.status?.in)
    );
    expect(holdingStatusClause.status.in).toEqual(
      expect.arrayContaining([BookingStatus.COMPLETED])
    );
    expect(call.where.OR).toContainEqual({
      status: BookingStatus.PENDING,
      originBookingRequest: { isNot: null },
    });
  });

  it("counts completed bookings in monthly occupied beds", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(4);
    expect(availability.get("2026-04-11")).toBe(4);
    expect(availability.get("2026-04-12")).toBe(0);
  });

  it("counts completed bookings when checking capacity", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.COMPLETED,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: [{ id: "g1" }, { id: "g2" }, { id: "g3" }, { id: "g4" }],
      },
    ]);

    const result = await checkCapacity(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      TEST_LODGE_CAPACITY - 4
    );

    expect(mocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              status: { in: expect.arrayContaining([BookingStatus.COMPLETED]) },
            }),
          ]),
        }),
      })
    );
    expect(result.available).toBe(true);
    expect(result.minAvailable).toBe(TEST_LODGE_CAPACITY - 4);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([
      TEST_LODGE_CAPACITY - 4,
      TEST_LODGE_CAPACITY - 4,
    ]);
  });

  it("counts guests only on nights inside their individual stay ranges", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-15"),
        guests: [
          {
            id: "full-stay",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-15"),
          },
          {
            id: "cut-short",
            stayStart: parseDateOnly("2026-04-10"),
            stayEnd: parseDateOnly("2026-04-13"),
          },
        ],
      },
    ]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 3);

    expect(availability.get("2026-04-09")).toBe(0);
    expect(availability.get("2026-04-10")).toBe(2);
    expect(availability.get("2026-04-11")).toBe(2);
    expect(availability.get("2026-04-12")).toBe(2);
    expect(availability.get("2026-04-13")).toBe(1);
    expect(availability.get("2026-04-14")).toBe(1);
    expect(availability.get("2026-04-15")).toBe(0);
  });

  it("allows proposed staggered guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [
        {
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-11"),
        },
        {
          stayStart: parseDateOnly("2026-04-11"),
          stayEnd: parseDateOnly("2026-04-12"),
        },
      ]
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([0, 0]);
  });

  it("still rejects full-span proposed guests when only one bed is available per night", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: parseDateOnly("2026-04-10"),
        checkOut: parseDateOnly("2026-04-12"),
        guests: Array.from({ length: TEST_LODGE_CAPACITY - 1 }, (_, index) => ({
          id: `existing-${index}`,
          stayStart: parseDateOnly("2026-04-10"),
          stayEnd: parseDateOnly("2026-04-12"),
        })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      [{}, {}]
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((night) => night.availableBeds)).toEqual([-1, -1]);
  });
});

describe("multi-lodge capacity scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  it("filters capacity queries strictly to the requested lodge", async () => {
    await checkCapacity(
      LODGE_B,
      parseDateOnly("2026-04-10"),
      parseDateOnly("2026-04-12"),
      2
    );

    const call = mocks.bookingFindMany.mock.calls[0][0];
    // lodgeId is NOT NULL on Booking, so the scope is a strict per-lodge
    // match at the top level; the only where.OR is the capacity-holding filter.
    expect(call.where.lodgeId).toBe(LODGE_B);
    expect(call.where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("applies the same lodge filter to month availability queries", async () => {
    await getMonthAvailability(LODGE_A, 2026, 3);

    const call = mocks.bookingFindMany.mock.calls[0][0];
    expect(call.where.lodgeId).toBe(LODGE_A);
    expect(call.where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("resolves zero capacity for an unconfigured additional lodge", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(LODGE_B, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
      activeBedCount: 0,
      fallbackCapacity: 0,
    });
  });

  it("keeps the club-config fallback for the default lodge", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(0);

    const status = await getLodgeCapacityStatus(LODGE_A, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: TEST_LODGE_CAPACITY,
      source: "club_config",
    });
  });

  it("uses configured beds for an additional lodge once its rooms have beds", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: true });
    mocks.lodgeBedCount.mockResolvedValue(8);

    const status = await getLodgeCapacityStatus(LODGE_B, twoLodgeDb());

    expect(status).toMatchObject({
      capacity: 8,
      source: "configured_beds",
      activeBedCount: 8,
    });
    expect(mocks.lodgeBedCount).toHaveBeenCalledWith({
      where: { active: true, room: { lodgeId: LODGE_B } },
    });
  });

  it("does not apply another lodge's capacity override", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_B,
      twoLodgeDb({
        lodgeSettings: {
          // Id-keyed like the per-lodge read path: LODGE_B has no row of
          // its own; the legacy "default" row is linked to LODGE_A.
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === "default"
              ? { capacity: 42, lodgeId: LODGE_A }
              : null,
          ),
        },
      }),
    );

    expect(status).toMatchObject({
      capacity: 0,
      source: "unconfigured_lodge",
    });
  });

  it("applies an unlinked (legacy) capacity override to any lodge", async () => {
    mocks.clubModuleSettingsFindUnique.mockResolvedValue({ bedAllocation: false });

    const status = await getLodgeCapacityStatus(
      LODGE_A,
      singleLodgeDb({
        lodgeSettings: {
          findUnique: vi.fn().mockResolvedValue({ capacity: 42, lodgeId: null }),
        },
      }),
    );

    expect(status).toMatchObject({ capacity: 42, source: "capacity_override" });
  });

  it("acquires a per-lodge advisory lock keyed by the lodge id", async () => {
    // $executeRaw, never $queryRaw: pg_advisory_xact_lock returns void and
    // the driver adapter fails to deserialize it as a result row.
    const executeRaw = vi.fn().mockResolvedValue(0);

    await acquireLodgeCapacityLock({ $executeRaw: executeRaw } as never, LODGE_A);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0];
    expect(strings.join("?")).toContain("pg_advisory_xact_lock(hashtextextended(");
    expect(values).toEqual([LODGE_A]);
  });

  it("never acquires the capacity lock through $queryRaw", () => {
    // Regression pin for the runtime failure this caused: every booking
    // transaction died with a void-deserialization error under the pg
    // driver adapter.
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/capacity.ts"),
      "utf8",
    );
    const lockFn = source.slice(
      source.indexOf("export async function acquireLodgeCapacityLock"),
      source.indexOf("}", source.indexOf("export async function acquireLodgeCapacityLock")) + 1,
    );
    expect(lockFn).toContain("$executeRaw");
    expect(lockFn).not.toContain("$queryRaw");
  });
});

describe("overCapacityNights (issue #1668 admin override)", () => {
  it("returns only the nights whose availableBeds went negative, as YYYY-MM-DD", () => {
    const nights = overCapacityNights({
      nightDetails: [
        { date: parseDateOnly("2026-09-01"), occupiedBeds: 10, availableBeds: 2 },
        { date: parseDateOnly("2026-09-02"), occupiedBeds: 30, availableBeds: -1 },
        { date: parseDateOnly("2026-09-03"), occupiedBeds: 31, availableBeds: -2 },
        { date: parseDateOnly("2026-09-04"), occupiedBeds: 29, availableBeds: 0 },
      ],
    });

    expect(nights).toEqual([
      { date: "2026-09-02", availableBeds: -1 },
      { date: "2026-09-03", availableBeds: -2 },
    ]);
  });

  it("returns an empty list when nothing is over capacity", () => {
    expect(
      overCapacityNights({
        nightDetails: [
          { date: parseDateOnly("2026-09-01"), occupiedBeds: 1, availableBeds: 5 },
        ],
      }),
    ).toEqual([]);
  });
});

describe("OverCapacityConfirmationRequiredError (issue #1668)", () => {
  it("is a 409 carrying the OVER_CAPACITY_CONFIRM_REQUIRED code and the night list", () => {
    const nightDetails = [{ date: "2026-09-02", availableBeds: -1 }];
    const err = new OverCapacityConfirmationRequiredError(nightDetails);

    expect(err.status).toBe(409);
    expect(err.code).toBe("OVER_CAPACITY_CONFIRM_REQUIRED");
    expect(err.nightDetails).toEqual(nightDetails);
  });
});
