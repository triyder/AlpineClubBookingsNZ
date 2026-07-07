import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Low 2: the bed-allocation GET dashboards must validate an explicit
// ?lodgeId= the same way their write paths do (400 on unknown/inactive),
// while an omitted lodgeId stays club-wide. resolveOptionalActiveLodgeId is
// left un-mocked so the real validation runs against the mocked prisma.
const {
  mockLodgeFindUnique,
  mockRequireBedAllocationAdmin,
  mockGetBedAllocationDashboard,
  mockGetRoomsAndBedsConfiguration,
} = vi.hoisted(() => ({
  mockLodgeFindUnique: vi.fn(),
  mockRequireBedAllocationAdmin: vi.fn(),
  mockGetBedAllocationDashboard: vi.fn(),
  mockGetRoomsAndBedsConfiguration: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { lodge: { findUnique: mockLodgeFindUnique } },
}));

vi.mock("@/lib/admin-bed-allocation-routes", () => ({
  requireBedAllocationAdmin: () => mockRequireBedAllocationAdmin(),
  bedAllocationErrorResponse: vi.fn(),
}));

vi.mock("@/lib/admin-bed-allocation", () => ({
  parseBedAllocationDateRange: () => ({
    from: new Date("2026-04-01T00:00:00Z"),
    to: new Date("2026-04-14T00:00:00Z"),
  }),
  getBedAllocationDashboard: (...args: unknown[]) =>
    mockGetBedAllocationDashboard(...args),
  getRoomsAndBedsConfiguration: (...args: unknown[]) =>
    mockGetRoomsAndBedsConfiguration(...args),
  createBedAllocationRoom: vi.fn(),
}));

describe("GET /api/admin/bed-allocation lodge validation (Low 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireBedAllocationAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockGetBedAllocationDashboard.mockResolvedValue({ ok: true });
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(400);
    expect(mockGetBedAllocationDashboard).not.toHaveBeenCalled();
  });

  it("passes a valid active lodge through to the dashboard", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: "lodge-2" }),
    );
  });

  it("stays club-wide when no lodgeId is supplied (no validation query)", async () => {
    const { GET } = await import("@/app/api/admin/bed-allocation/route");
    const res = await GET(
      new NextRequest(
        "http://localhost/api/admin/bed-allocation?from=2026-04-01&to=2026-04-14",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockLodgeFindUnique).not.toHaveBeenCalled();
    expect(mockGetBedAllocationDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ lodgeId: undefined }),
    );
  });
});

describe("GET /api/admin/bed-allocation/rooms lodge validation (Low 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireBedAllocationAdmin.mockResolvedValue({
      ok: true,
      session: { user: { id: "admin-1" } },
    });
    mockGetRoomsAndBedsConfiguration.mockResolvedValue({ rooms: [] });
  });

  it("rejects an unknown or inactive lodgeId with 400", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const { GET } = await import("@/app/api/admin/bed-allocation/rooms/route");
    const res = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/rooms?lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(400);
    expect(mockGetRoomsAndBedsConfiguration).not.toHaveBeenCalled();
  });

  it("passes a valid active lodge through to the configuration query", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const { GET } = await import("@/app/api/admin/bed-allocation/rooms/route");
    const res = await GET(
      new Request(
        "http://localhost/api/admin/bed-allocation/rooms?lodgeId=lodge-2",
      ),
    );

    expect(res.status).toBe(200);
    expect(mockGetRoomsAndBedsConfiguration).toHaveBeenCalledWith(
      undefined,
      "lodge-2",
    );
  });
});
