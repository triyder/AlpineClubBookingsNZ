import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/config/operational", () => ({ APP_CURRENCY: "NZD" }));
vi.mock("@/lib/date-only", () => ({ getTodayDateOnly: () => new Date("2026-07-14T00:00:00.000Z") }));

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  entranceFees: vi.fn(),
  lodge: vi.fn(),
  cancellation: vi.fn(),
  periods: vi.fn(),
  membershipTypes: vi.fn(),
  lodges: vi.fn(),
  seasons: vi.fn(),
  ageTiers: vi.fn(),
  defaults: vi.fn(),
  minimumStays: vi.fn(),
  discount: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  publicContentSettings: { findUnique: mocks.settings },
  entranceFee: { findMany: mocks.entranceFees },
  lodge: { findFirst: mocks.lodge, findMany: mocks.lodges },
  membershipType: { findMany: mocks.membershipTypes },
  season: { findMany: mocks.seasons },
  ageTierSetting: { findMany: mocks.ageTiers },
  bookingDefaults: { findUnique: mocks.defaults },
  minimumStayPolicy: { findMany: mocks.minimumStays },
  groupDiscountSetting: { findUnique: mocks.discount },
  cancellationPolicy: { findMany: mocks.cancellation },
  bookingPeriod: { findMany: mocks.periods },
} }));

import {
  loadPublicCancellationPolicy,
  loadPublicEntranceFees,
  loadPublicHutFees,
  loadPublicMembershipTypes,
  loadPublicBookingPolicy,
} from "@/lib/public-page-content-tokens";

describe("public PageContent token view models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockImplementation(({ select }: { select: Record<string, boolean> }) =>
      Object.fromEntries(Object.keys(select).map((key) => [key, true])),
    );
    mocks.periods.mockResolvedValue([]);
    mocks.minimumStays.mockResolvedValue([]);
    mocks.discount.mockResolvedValue(null);
    mocks.defaults.mockResolvedValue(null);
  });

  it("keeps every block hidden when its persisted opt-in row is absent", async () => {
    mocks.settings.mockResolvedValue(null);
    await expect(loadPublicEntranceFees()).resolves.toEqual([]);
    expect(mocks.entranceFees).not.toHaveBeenCalled();
  });

  it("uses only current EntranceFee schedules and omits missing categories", async () => {
    mocks.entranceFees.mockResolvedValue([
      { category: "ADULT", amountCents: 12500 },
      { category: "YOUTH", amountCents: 5000 },
    ]);
    await expect(loadPublicEntranceFees()).resolves.toEqual([
      { category: "Adult", fee: { amountCents: 12500, label: "$125.00" } },
      { category: "Youth", fee: { amountCents: 5000, label: "$50.00" } },
    ]);
    expect(mocks.entranceFees).toHaveBeenCalledWith(expect.objectContaining({
      select: { category: true, amountCents: true },
    }));
  });

  it("fails closed for an invalid lodge slug", async () => {
    mocks.lodge.mockResolvedValue(null);
    await expect(loadPublicHutFees("missing-lodge")).resolves.toEqual([]);
  });

  it("publishes only listed membership types and distinguishes no-invoice schedules", async () => {
    mocks.membershipTypes.mockResolvedValue([{ name: "Life", publicDescription: "For life members", annualFees: [{ amountCents: 0, billingBasis: "NO_INVOICE", prorationRule: "NONE" }] }]);
    await expect(loadPublicMembershipTypes()).resolves.toEqual([{ name: "Life", description: "For life members", annualFee: null, billingLabel: "No invoice required" }]);
    expect(mocks.membershipTypes).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true, publiclyListed: true } }));
  });

  it("uses configured age labels and stable order for lodge rates", async () => {
    mocks.lodges.mockResolvedValue([{ id: "l1", name: "River Lodge", slug: "river" }]);
    mocks.seasons.mockResolvedValue([{ lodgeId: "l1", name: "Winter", startDate: new Date("2026-06-01"), endDate: new Date("2026-10-01"), rates: [
      { ageTier: "ADULT", isMember: true, pricePerNightCents: 4000 },
      { ageTier: "CHILD", isMember: true, pricePerNightCents: 2000 },
    ] }]);
    mocks.ageTiers.mockResolvedValue([
      { tier: "CHILD", label: "Child (5–12)", sortOrder: 1 },
      { tier: "ADULT", label: "Adult (18+)", sortOrder: 2 },
    ]);
    const result = await loadPublicHutFees();
    expect(result[0]?.seasons[0]?.rates.map((rate) => rate.ageTier)).toEqual(["Child (5–12)", "Adult (18+)"]);
  });

  it("summarizes only customer-facing booking policy fields", async () => {
    mocks.defaults.mockResolvedValue({ nonMemberHoldEnabled: true, nonMemberHoldDays: 7, waitlistCrossLodgeOrder: "MERGED" });
    mocks.periods.mockResolvedValue([{ name: "School holidays", startDate: new Date("2026-09-01"), endDate: new Date("2026-09-10"), nonMemberHoldEnabled: false, nonMemberHoldDays: 3, lodgeId: null, cancellationRules: [{ secret: true }] }]);
    mocks.minimumStays.mockResolvedValue([{ name: "Weekend", startDate: new Date("2026-07-01"), endDate: new Date("2026-08-01"), minimumNights: 2, triggerDays: [6], lodgeId: null }]);
    mocks.discount.mockResolvedValue({ enabled: true, minGroupSize: 5, summerOnly: true, id: "internal" });
    const policy = await loadPublicBookingPolicy();
    expect(policy).toEqual(expect.objectContaining({ hold: expect.stringContaining("7 days"), groupDiscount: expect.stringContaining("5") }));
    expect(policy?.minimumStays[0]?.triggerDays).toBe("Saturday");
    expect(JSON.stringify(policy)).not.toContain("waitlistCrossLodgeOrder");
    expect(JSON.stringify(policy)).not.toContain("secret");
    expect(JSON.stringify(policy)).not.toContain("internal");
  });

  it("describes divergent card and credit cancellation terms", async () => {
    mocks.cancellation.mockResolvedValue([{
      daysBeforeStay: 14,
      refundPercentage: 80,
      creditRefundPercentage: 100,
      fixedFeeCents: 2500,
      creditFixedFeeCents: 0,
      lodgeId: null,
    }]);
    const policy = await loadPublicCancellationPolicy();
    expect(policy?.tiers[0]?.description).toBe(
      "14 days before check-in: 80% card refund less a $25.00 fee; 100% credit refund",
    );
  });
});
