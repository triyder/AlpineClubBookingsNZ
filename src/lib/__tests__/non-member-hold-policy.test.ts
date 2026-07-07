import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  periodFindMany: vi.fn(),
  defaultsFindUnique: vi.fn(),
  lodgeFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingPeriod: {
      findMany: (...args: unknown[]) => h.periodFindMany(...args),
    },
    bookingDefaults: {
      findUnique: (...args: unknown[]) => h.defaultsFindUnique(...args),
    },
    lodge: {
      findFirst: (...args: unknown[]) => h.lodgeFindFirst(...args),
    },
  },
}));

import { getNonMemberHoldPolicy } from "@/lib/cancellation";

describe("getNonMemberHoldPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to enabled Members First behavior when no defaults row exists", async () => {
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.periodFindMany.mockResolvedValue([]);
    h.defaultsFindUnique.mockResolvedValue(null);

    await expect(getNonMemberHoldPolicy(new Date("2026-07-10"))).resolves.toEqual({
      enabled: true,
      holdDays: 7,
      source: "default",
    });
  });

  it("uses a date-specific period override for enabled flag and hold days", async () => {
    h.lodgeFindFirst.mockResolvedValue({ id: "lodge-1" });
    h.periodFindMany.mockResolvedValue([
      {
        id: "period-1",
        lodgeId: "lodge-1",
        startDate: new Date("2026-07-01"),
        endDate: new Date("2026-07-31"),
        nonMemberHoldEnabled: false,
        nonMemberHoldDays: 21,
      },
    ]);

    await expect(getNonMemberHoldPolicy(new Date("2026-07-10"))).resolves.toEqual({
      enabled: false,
      holdDays: 21,
      source: "period",
    });
  });
});
