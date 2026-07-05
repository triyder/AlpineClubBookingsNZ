import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  periodFindFirst: vi.fn(),
  defaultsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingPeriod: {
      findFirst: (...args: unknown[]) => h.periodFindFirst(...args),
    },
    bookingDefaults: {
      findUnique: (...args: unknown[]) => h.defaultsFindUnique(...args),
    },
  },
}));

import { getNonMemberHoldPolicy } from "@/lib/cancellation";

describe("getNonMemberHoldPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to enabled Members First behavior when no defaults row exists", async () => {
    h.periodFindFirst.mockResolvedValue(null);
    h.defaultsFindUnique.mockResolvedValue(null);

    await expect(getNonMemberHoldPolicy(new Date("2026-07-10"))).resolves.toEqual({
      enabled: true,
      holdDays: 7,
      source: "default",
    });
  });

  it("uses a date-specific period override for enabled flag and hold days", async () => {
    h.periodFindFirst.mockResolvedValue({
      id: "period-1",
      nonMemberHoldEnabled: false,
      nonMemberHoldDays: 21,
    });

    await expect(getNonMemberHoldPolicy(new Date("2026-07-10"))).resolves.toEqual({
      enabled: false,
      holdDays: 21,
      source: "period",
    });
  });
});
