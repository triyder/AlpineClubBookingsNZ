import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  siteBannerFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    siteBanner: {
      findMany: mocks.siteBannerFindMany,
    },
  },
}));

// Pin "today" (NZ date-only) so window and grouping assertions are stable.
const TODAY = new Date("2026-07-02T00:00:00.000Z");

vi.mock("@/lib/date-only", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/date-only")>()),
  getTodayDateOnly: () => TODAY,
}));

import {
  getCurrentSiteBanners,
  listSiteBannersForAdmin,
} from "@/lib/site-banners";

function bannerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "banner-1",
    message: "Mountain closed",
    priority: "URGENT",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-07-10T00:00:00.000Z"),
    active: true,
    createdByMemberId: "admin-1",
    updatedByMemberId: "admin-1",
    createdAt: new Date("2026-06-30T01:00:00.000Z"),
    updatedAt: new Date("2026-06-30T02:00:00.000Z"),
    ...overrides,
  };
}

describe("getCurrentSiteBanners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteBannerFindMany.mockResolvedValue([]);
  });

  it("queries active banners whose window includes today's NZ date", async () => {
    await getCurrentSiteBanners();

    expect(mocks.siteBannerFindMany).toHaveBeenCalledWith({
      where: {
        active: true,
        startDate: { lte: TODAY },
        endDate: { gte: TODAY },
      },
      select: {
        id: true,
        message: true,
        priority: true,
        startDate: true,
        updatedAt: true,
      },
    });
  });

  it("sorts URGENT before WARNING before NOTIFY, then newest start date", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({ id: "notify-1", priority: "NOTIFY" }),
      bannerRow({
        id: "urgent-old",
        priority: "URGENT",
        startDate: new Date("2026-06-20T00:00:00.000Z"),
      }),
      bannerRow({ id: "warning-1", priority: "WARNING" }),
      bannerRow({
        id: "urgent-new",
        priority: "URGENT",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ]);

    const banners = await getCurrentSiteBanners();

    expect(banners.map((banner) => banner.id)).toEqual([
      "urgent-new",
      "urgent-old",
      "warning-1",
      "notify-1",
    ]);
  });

  it("returns a serialisable shape with an ISO updatedAt", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([bannerRow()]);

    const banners = await getCurrentSiteBanners();

    expect(banners).toEqual([
      {
        id: "banner-1",
        message: "Mountain closed",
        priority: "URGENT",
        updatedAt: "2026-06-30T02:00:00.000Z",
      },
    ]);
  });
});

describe("listSiteBannersForAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.siteBannerFindMany.mockResolvedValue([]);
  });

  it("splits banners into current, upcoming, and past groups", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      // Ends before today -> past.
      bannerRow({
        id: "past-1",
        startDate: new Date("2026-06-01T00:00:00.000Z"),
        endDate: new Date("2026-07-01T00:00:00.000Z"),
      }),
      // Window includes today -> current.
      bannerRow({
        id: "current-1",
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-05T00:00:00.000Z"),
      }),
      // Starts after today -> upcoming.
      bannerRow({
        id: "upcoming-1",
        startDate: new Date("2026-07-03T00:00:00.000Z"),
        endDate: new Date("2026-07-08T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual(["current-1"]);
    expect(groups.upcoming.map((banner) => banner.id)).toEqual(["upcoming-1"]);
    expect(groups.past.map((banner) => banner.id)).toEqual(["past-1"]);
  });

  it("treats a banner ending today as current (inclusive end date)", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({
        id: "ends-today",
        startDate: new Date("2026-06-28T00:00:00.000Z"),
        endDate: new Date("2026-07-02T00:00:00.000Z"),
      }),
      bannerRow({
        id: "starts-today",
        startDate: new Date("2026-07-02T00:00:00.000Z"),
        endDate: new Date("2026-07-09T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual([
      "starts-today",
      "ends-today",
    ]);
    expect(groups.upcoming).toEqual([]);
    expect(groups.past).toEqual([]);
  });

  it("keeps inactive banners in their date-derived group", async () => {
    mocks.siteBannerFindMany.mockResolvedValue([
      bannerRow({
        id: "inactive-current",
        active: false,
        startDate: new Date("2026-07-01T00:00:00.000Z"),
        endDate: new Date("2026-07-05T00:00:00.000Z"),
      }),
    ]);

    const groups = await listSiteBannersForAdmin();

    expect(groups.current.map((banner) => banner.id)).toEqual([
      "inactive-current",
    ]);
    expect(groups.current[0].active).toBe(false);
  });

  it("serialises dates as date-only strings and caps past banners at 50", async () => {
    const pastBanners = Array.from({ length: 60 }, (_, index) =>
      bannerRow({
        id: `past-${index}`,
        startDate: new Date("2026-05-01T00:00:00.000Z"),
        // Spread end dates so the newest-ended sort is observable.
        endDate: new Date(Date.UTC(2026, 4, 1 + index)),
      }),
    );
    mocks.siteBannerFindMany.mockResolvedValue(pastBanners);

    const groups = await listSiteBannersForAdmin();

    expect(groups.past).toHaveLength(50);
    // Most recently ended first.
    expect(groups.past[0].id).toBe("past-59");
    expect(groups.past[0]).toMatchObject({
      startDate: "2026-05-01",
      endDate: "2026-06-29",
    });
  });
});
