import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { BookingStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";
import {
  capacityHoldingBookingFilter,
  CAPACITY_HOLDING_BOOKING_STATUSES,
} from "@/lib/booking-status";

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
  bookingsOverlap,
  checkCapacity,
  checkCapacityForGuestRanges,
  findOverlappingCapacityHoldingBookings,
  getLodgeHeldNights,
  getMonthAvailability,
  sameLodgeNullTolerant,
} from "@/lib/capacity";
import {
  overCapacityNights,
  OverCapacityConfirmationRequiredError,
  wholeLodgeBlockedNights,
  WholeLodgeHoldBlockedError,
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

// ADR-001 exclusive whole-lodge hold (issue #118). A capacity-holding booking
// with wholeLodgeHold=true hard-blocks its nights: to members the night is
// indistinguishable from a full lodge (decision 6), and an admin over-capacity
// override cannot punch into it (decision 5).
describe("whole-lodge exclusive hold — capacity engine (issue #118)", () => {
  const HELD_IN = parseDateOnly("2026-08-10");
  const HELD_OUT = parseDateOnly("2026-08-12");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bookingFindMany.mockResolvedValue([]);
    mocks.clubModuleSettingsFindUnique.mockResolvedValue(null);
    mocks.lodgeBedCount.mockResolvedValue(0);
  });

  function heldBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "held-booking",
      status: BookingStatus.CONFIRMED,
      checkIn: HELD_IN,
      checkOut: HELD_OUT,
      wholeLodgeHold: true,
      // A single guest: numeric beds (19 of 20 free) would easily fit a new
      // small booking. The hold — not the arithmetic — is what must block.
      guests: [{ id: "school-1" }],
      ...overrides,
    };
  }

  it("blocks a NEW admission on overlapping nights even though numeric beds fit (checkCapacityForGuestRanges)", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((n) => n.wholeLodgeHeld)).toEqual([true, true]);
    // Pinned to 0, never negative — so it can never enter the confirmable set.
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([0, 0]);
  });

  it("blocks a NEW admission in checkCapacity as well (available forced false, beds pinned to 0)", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacity(LODGE_A, HELD_IN, HELD_OUT, 1);

    expect(result.available).toBe(false);
    expect(result.nightDetails.map((n) => n.wholeLodgeHeld)).toEqual([true, true]);
    expect(result.nightDetails.map((n) => n.availableBeds)).toEqual([0, 0]);
  });

  it("member parity: held nights are NOT in overCapacityNights, so members get the ordinary no-space path", async () => {
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    // Unavailable exactly like a full lodge, but with NO confirmable night —
    // the hold is never surfaced as a bypassable over-capacity signal.
    expect(result.available).toBe(false);
    expect(overCapacityNights(result)).toEqual([]);
    expect(wholeLodgeBlockedNights(result)).toEqual(["2026-08-10", "2026-08-11"]);
  });

  it("edge-night handover: a hold departing on day D does NOT block a booking arriving night D ([checkIn, checkOut))", async () => {
    // Held booking runs 08-08 → 08-10 (checkout day 08-10). A new booking
    // arriving the night of 08-10 must NOT be blocked: the hold spans only
    // 08-08 and 08-09.
    mocks.bookingFindMany.mockResolvedValue([
      heldBooking({
        checkIn: parseDateOnly("2026-08-08"),
        checkOut: parseDateOnly("2026-08-10"),
      }),
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      parseDateOnly("2026-08-10"),
      parseDateOnly("2026-08-12"),
      [{ stayStart: parseDateOnly("2026-08-10"), stayEnd: parseDateOnly("2026-08-12") }],
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.some((n) => n.wholeLodgeHeld)).toBe(false);
  });

  it("editing the hold's OWN dates: excludeBookingId removes it from the overlap query so its nights are not blocked against itself", async () => {
    // Prisma applies the exclude; the mock returns the post-exclusion set.
    mocks.bookingFindMany.mockResolvedValue([]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
      "held-booking",
    );

    expect(result.available).toBe(true);
    expect(result.nightDetails.some((n) => n.wholeLodgeHeld)).toBe(false);
    // The held booking's own id is excluded from the overlap query.
    expect(mocks.bookingFindMany.mock.calls[0][0].where).toMatchObject({
      id: { not: "held-booking" },
    });
  });

  it("regression: a genuinely full (numeric) lodge with NO hold still yields overCapacityNights and stays override-confirmable", async () => {
    // 20 guests fill a 20-bed lodge; a proposed 21st goes to -1. No hold.
    mocks.bookingFindMany.mockResolvedValue([
      {
        status: BookingStatus.PAID,
        checkIn: HELD_IN,
        checkOut: HELD_OUT,
        wholeLodgeHold: false,
        guests: Array.from({ length: TEST_LODGE_CAPACITY }, (_, i) => ({ id: `g${i}` })),
      },
    ]);

    const result = await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    expect(result.available).toBe(false);
    expect(result.nightDetails.every((n) => !n.wholeLodgeHeld)).toBe(true);
    // Negative, so it IS confirmable — the ordinary #1668 override still works.
    expect(overCapacityNights(result)).toEqual([
      { date: "2026-08-10", availableBeds: -1 },
      { date: "2026-08-11", availableBeds: -1 },
    ]);
    expect(wholeLodgeBlockedNights(result)).toEqual([]);
  });

  it("month calendar parity (getMonthAvailability): a held-but-not-full night reports as FULL, indistinguishable from a genuinely full lodge (decision 6)", async () => {
    // A single guest holds the whole lodge for 08-10 → 08-12. Numerically 19 of
    // 20 beds are free, but the public calendar must show ZERO availability.
    mocks.bookingFindMany.mockResolvedValue([heldBooking()]);

    const availability = await getMonthAvailability(LODGE_A, 2026, 7); // August

    // Held nights report full occupancy (= capacity), so the frontend's
    // capacity - occupied yields no free beds.
    expect(availability.get("2026-08-10")).toBe(TEST_LODGE_CAPACITY);
    expect(availability.get("2026-08-11")).toBe(TEST_LODGE_CAPACITY);
    // The checkout day (08-12) is outside [checkIn, checkOut): not held, and no
    // guest occupies it, so it stays free.
    expect(availability.get("2026-08-12")).toBe(0);
  });

  it("a CANCELLED whole-lodge-hold booking cannot block: the capacity query filters to holding statuses only (CANCELLED excluded)", async () => {
    await checkCapacityForGuestRanges(
      LODGE_A,
      HELD_IN,
      HELD_OUT,
      [{ stayStart: HELD_IN, stayEnd: HELD_OUT }],
    );

    // The overlap query is scoped by capacityHoldingBookingFilter(), whose
    // status set never includes CANCELLED — a cancelled hold is never even
    // fetched, so its wholeLodgeHold flag is irrelevant.
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
    expect(CAPACITY_HOLDING_BOOKING_STATUSES).not.toContain(BookingStatus.CANCELLED);
  });
});

describe("wholeLodgeBlockedNights + WholeLodgeHoldBlockedError (issue #118)", () => {
  it("wholeLodgeBlockedNights returns only the held nights as YYYY-MM-DD", () => {
    expect(
      wholeLodgeBlockedNights({
        nightDetails: [
          { date: parseDateOnly("2026-09-01"), occupiedBeds: 5, availableBeds: 15 },
          {
            date: parseDateOnly("2026-09-02"),
            occupiedBeds: 3,
            availableBeds: 0,
            wholeLodgeHeld: true,
          },
          {
            date: parseDateOnly("2026-09-03"),
            occupiedBeds: 31,
            availableBeds: -1,
          },
        ],
      }),
    ).toEqual(["2026-09-02"]);
  });

  it("is a non-confirmable 409 carrying the WHOLE_LODGE_HOLD_BLOCKED code and the blocked nights", () => {
    const err = new WholeLodgeHoldBlockedError(["2026-09-02", "2026-09-03"]);

    expect(err.status).toBe(409);
    expect(err.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(err.blockedNights).toEqual(["2026-09-02", "2026-09-03"]);
  });
});

// Admin conflict-surfacing helpers (issue #119). Shared by the exclusive-hold
// route, the school approval, the booking detail page, and the admin bookings
// list — reusing the capacity engine's overlap window / hold population.
describe("bookingsOverlap + sameLodgeNullTolerant (issue #119)", () => {
  it("uses the half-open span: a back-to-back handover does NOT overlap", () => {
    const a = {
      checkIn: parseDateOnly("2026-08-08"),
      checkOut: parseDateOnly("2026-08-10"),
    };
    const backToBack = {
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
    };
    const overlapping = {
      checkIn: parseDateOnly("2026-08-09"),
      checkOut: parseDateOnly("2026-08-11"),
    };
    expect(bookingsOverlap(a, backToBack)).toBe(false);
    expect(bookingsOverlap(a, overlapping)).toBe(true);
  });

  it("tolerates a null lodgeId on either side (expand-release)", () => {
    expect(sameLodgeNullTolerant(null, "lodge-a")).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", undefined)).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", "lodge-a")).toBe(true);
    expect(sameLodgeNullTolerant("lodge-a", "lodge-b")).toBe(false);
  });
});

describe("findOverlappingCapacityHoldingBookings (issue #119)", () => {
  const db = { booking: { findMany: mocks.bookingFindMany } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the overlapping capacity-holding bookings, excluding the held booking", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: "booking-2",
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
        status: "CONFIRMED",
        member: { firstName: "Jane", lastName: "Doe", email: "j@x.nz" },
        _count: { guests: 3 },
      },
    ]);

    const result = await findOverlappingCapacityHoldingBookings(db, {
      lodgeId: "lodge-a",
      checkIn: parseDateOnly("2026-08-10"),
      checkOut: parseDateOnly("2026-08-12"),
      excludeBookingId: "held-1",
    });

    expect(result).toEqual([
      {
        id: "booking-2",
        memberName: "Jane Doe",
        checkIn: "2026-08-10",
        checkOut: "2026-08-12",
        guestCount: 3,
        status: "CONFIRMED",
      },
    ]);
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      lodgeId: "lodge-a",
      id: { not: "held-1" },
      deletedAt: null,
    });
    // Reuses the capacity-holding population filter, not a bespoke status list.
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("returns [] when nothing overlaps", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);
    expect(
      await findOverlappingCapacityHoldingBookings(db, {
        lodgeId: "lodge-a",
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
      }),
    ).toEqual([]);
  });
});

describe("getLodgeHeldNights — admin companion to getLodgeCapacityStatus (issue #119)", () => {
  const db = { booking: { findMany: mocks.bookingFindMany } } as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the whole-lodge-held nights within the range (half-open span)", async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        checkIn: parseDateOnly("2026-08-10"),
        checkOut: parseDateOnly("2026-08-12"),
        wholeLodgeHold: true,
      },
    ]);

    const nights = await getLodgeHeldNights(
      "lodge-a",
      parseDateOnly("2026-08-09"),
      parseDateOnly("2026-08-13"),
      db,
    );

    // Held 08-10 and 08-11; the checkout day 08-12 is outside [checkIn, checkOut).
    expect(nights).toEqual(["2026-08-10", "2026-08-11"]);
    const where = mocks.bookingFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ lodgeId: "lodge-a", wholeLodgeHold: true });
    expect(where.OR).toEqual(capacityHoldingBookingFilter().OR);
  });

  it("returns [] when no hold overlaps the range", async () => {
    mocks.bookingFindMany.mockResolvedValue([]);
    expect(
      await getLodgeHeldNights(
        "lodge-a",
        parseDateOnly("2026-08-09"),
        parseDateOnly("2026-08-13"),
        db,
      ),
    ).toEqual([]);
  });
});
