import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { parseDateOnly } from "@/lib/date-only";

// Route-level serialisation test for issue #155: on a whole-lodge-held night
// the response must report occupiedBeds === lodgeCapacity (mirroring
// getMonthAvailability's pin, ADR-001 decision 6), so
// occupiedBeds + availableBeds === lodgeCapacity on every night. checkCapacity
// itself is unit-tested in src/lib/__tests__/capacity.test.ts ("whole-lodge
// exclusive hold — capacity engine"); this file only proves the route passes
// the engine's pinned values through unchanged.
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  isMemberEligibleToBookLodge: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  checkCapacity: vi.fn(),
  lodgeFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: h.requireActiveSessionUser,
}));
vi.mock("@/lib/lodge-access", () => ({
  isMemberEligibleToBookLodge: h.isMemberEligibleToBookLodge,
}));
vi.mock("@/lib/lodges", () => ({
  getDefaultLodgeId: h.getDefaultLodgeId,
}));
vi.mock("@/lib/capacity", () => ({
  checkCapacity: h.checkCapacity,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: { findUnique: h.lodgeFindUnique },
  },
}));

import { GET } from "@/app/api/availability/check/route";

const TEST_LODGE_CAPACITY = 20;

function makeRequest(params: Record<string, string>) {
  const search = new URLSearchParams(params).toString();
  return new NextRequest(`http://localhost/api/availability/check?${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue({ user: { id: "member-1" } });
  h.requireActiveSessionUser.mockResolvedValue(null);
  h.isMemberEligibleToBookLodge.mockResolvedValue(true);
  h.getDefaultLodgeId.mockResolvedValue("lodge-a");
});

describe("GET /api/availability/check — held-night occupiedBeds pinning (issue #155)", () => {
  it("a held-but-not-full night serialises occupiedBeds === lodgeCapacity and availableBeds === 0", async () => {
    // checkCapacity (engine-level, issue #155) already pins occupiedBeds to
    // lodgeCapacity on a held night; this asserts the route passes that
    // pinned value through unchanged rather than re-deriving it.
    h.checkCapacity.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-11" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nightDetails).toEqual([
      { date: "2026-08-10", occupiedBeds: TEST_LODGE_CAPACITY, availableBeds: 0 },
    ]);
    for (const night of body.nightDetails) {
      expect(night.occupiedBeds + night.availableBeds).toBe(TEST_LODGE_CAPACITY);
    }
  });

  it("held first night: occupiedBeds + availableBeds === lodgeCapacity (fixes admin resolvedCapacity reconstruction, issue #155)", async () => {
    h.checkCapacity.mockResolvedValue({
      available: false,
      minAvailable: 0,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
        {
          date: parseDateOnly("2026-08-11"),
          occupiedBeds: TEST_LODGE_CAPACITY,
          availableBeds: 0,
          wholeLodgeHeld: true,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-12" }),
    );

    const body = await res.json();
    const [firstNight] = body.nightDetails;
    const resolvedCapacity = firstNight.occupiedBeds + firstNight.availableBeds;
    expect(resolvedCapacity).toBe(TEST_LODGE_CAPACITY);
  });

  it("unheld nights: response is unchanged (real occupiedBeds passed through as-is)", async () => {
    h.checkCapacity.mockResolvedValue({
      available: true,
      minAvailable: TEST_LODGE_CAPACITY - 3,
      nightDetails: [
        {
          date: parseDateOnly("2026-08-10"),
          occupiedBeds: 3,
          availableBeds: TEST_LODGE_CAPACITY - 3,
          wholeLodgeHeld: false,
        },
      ],
    });

    const res = await GET(
      makeRequest({ checkIn: "2026-08-10", checkOut: "2026-08-11" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      minAvailable: TEST_LODGE_CAPACITY - 3,
      nightDetails: [
        { date: "2026-08-10", occupiedBeds: 3, availableBeds: TEST_LODGE_CAPACITY - 3 },
      ],
    });
  });
});
