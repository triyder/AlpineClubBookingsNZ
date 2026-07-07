import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loggerError: vi.fn(),
  prisma: { booking: { findMany: vi.fn() } },
  getMonthAvailability: vi.fn(),
  getLodgeCapacity: vi.fn(),
  countActiveLodges: vi.fn(),
  getDefaultLodgeId: vi.fn(),
  lodgeNullTolerantScope: vi.fn((id: string) => ({ __scope: id })),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/capacity", () => ({
  getMonthAvailability: mocks.getMonthAvailability,
  getLodgeCapacity: mocks.getLodgeCapacity,
}));
vi.mock("@/lib/lodges", () => ({
  countActiveLodges: mocks.countActiveLodges,
  getDefaultLodgeId: mocks.getDefaultLodgeId,
  lodgeNullTolerantScope: mocks.lodgeNullTolerantScope,
}));

import { GET as getCalendar } from "@/app/api/admin/bookings/route";

function req(query: string) {
  return new NextRequest(`http://localhost/api/admin/bookings?${query}`);
}

describe("Admin bookings calendar route — lodge scoping (#9)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.prisma.booking.findMany.mockResolvedValue([]);
    mocks.getMonthAvailability.mockResolvedValue(new Map([["2026-07-01", 5]]));
    mocks.getLodgeCapacity.mockResolvedValue(32);
    mocks.getDefaultLodgeId.mockResolvedValue("lodge-1");
    mocks.countActiveLodges.mockResolvedValue(1);
  });

  it("scopes bookings and beds to the selected lodge", async () => {
    const res = await getCalendar(req("calendarMonth=2026-07&lodgeId=lodge-2"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBe("lodge-2");
    expect(mocks.getMonthAvailability).toHaveBeenCalledWith("lodge-2", 2026, 6);
    expect(body.availability).toEqual({ "2026-07-01": 27 });
  });

  it("hides the bed count for a multi-lodge 'All lodges' view, but keeps bookings unscoped", async () => {
    mocks.countActiveLodges.mockResolvedValue(2);
    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBeUndefined();
    expect(mocks.getMonthAvailability).not.toHaveBeenCalled();
    expect(mocks.getLodgeCapacity).not.toHaveBeenCalled();
    expect(body.availability).toEqual({});
  });

  it("shows the sole lodge's beds for a single-lodge club with no filter (ADR-002)", async () => {
    mocks.countActiveLodges.mockResolvedValue(1);
    const res = await getCalendar(req("calendarMonth=2026-07"));
    const body = await res.json();

    const where = mocks.prisma.booking.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.__scope).toBeUndefined();
    expect(mocks.getMonthAvailability).toHaveBeenCalledWith("lodge-1", 2026, 6);
    expect(body.availability).toEqual({ "2026-07-01": 27 });
  });
});
