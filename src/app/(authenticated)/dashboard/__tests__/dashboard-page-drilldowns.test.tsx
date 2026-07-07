import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  bookingFindFirst: vi.fn(),
  bookingFindMany: vi.fn(),
  getAvailablePromoCodesForMember: vi.fn(),
  getMemberCreditBalance: vi.fn(),
  hasAccessRole: vi.fn(),
  isHutLeader: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  lockerFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findFirst: mocks.bookingFindFirst,
      findMany: mocks.bookingFindMany,
    },
    locker: {
      findMany: mocks.lockerFindMany,
    },
    member: {
      findUnique: mocks.memberFindUnique,
    },
  },
}));

vi.mock("@/lib/member-credit", () => ({
  getMemberCreditBalance: mocks.getMemberCreditBalance,
}));

vi.mock("@/lib/promo", () => ({
  getAvailablePromoCodesForMember: mocks.getAvailablePromoCodesForMember,
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));

vi.mock("@/lib/access-roles", () => ({
  hasAccessRole: mocks.hasAccessRole,
}));

vi.mock("@/lib/hut-leader", () => ({
  isHutLeader: mocks.isHutLeader,
}));

import DashboardPage from "../page";

function moduleFlags() {
  return {
    kiosk: false,
    chores: false,
    financeDashboard: false,
    waitlist: false,
    xeroIntegration: false,
    bedAllocation: false,
    internetBankingPayments: false,
    addressAutocomplete: false,
    groupBookings: false,
    lockers: false,
    induction: false,
    workParties: false,
    promoCodes: true,
    hutLeaders: false,
    communications: false,
    skifieldConditions: false,
    twoFactor: false,
    analytics: false,
  };
}

async function renderDashboardPage() {
  return renderToStaticMarkup(await DashboardPage());
}

describe("DashboardPage summary card drill-downs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: {
        id: "member-1",
        name: "Mere Member",
      },
    });
    mocks.bookingFindFirst.mockResolvedValue(null);
    mocks.bookingFindMany
      .mockResolvedValueOnce([
        {
          id: "upcoming-1",
          memberId: "member-1",
          checkIn: new Date("2026-08-10T00:00:00.000Z"),
          checkOut: new Date("2026-08-12T00:00:00.000Z"),
          status: "CONFIRMED",
          finalPriceCents: 18000,
          _count: { guests: 2 },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "owed-1",
          status: "CONFIRMED",
          finalPriceCents: 18000,
          payment: null,
        },
      ]);
    mocks.getMemberCreditBalance.mockResolvedValue(2500);
    mocks.getAvailablePromoCodesForMember.mockResolvedValue([
      {
        code: "SAVE10",
        description: "Winter special",
        fixedNightlyMode: null,
        fixedNightlyPriceCents: null,
        freeNightsPerIndividual: null,
        lifetimeFreeNightsCap: null,
        percentOff: 10,
        type: "PERCENTAGE",
        valueCents: null,
      },
    ]);
    mocks.lockerFindMany.mockResolvedValue([]);
    mocks.memberFindUnique.mockResolvedValue({
      requiresInduction: false,
      inductions: [],
    });
    mocks.loadEffectiveModuleFlags.mockResolvedValue(moduleFlags());
    mocks.hasAccessRole.mockReturnValue(false);
  });

  it("links summary cards to their drill-down targets", async () => {
    const html = await renderDashboardPage();

    expect(html).toContain('href="/bookings"');
    expect(html).toContain('href="/bookings/upcoming-1?returnTo=%2Fdashboard"');
    expect(html).toContain(
      'href="/profile?returnTo=%2Fdashboard#account-credit"',
    );
    expect(html).toContain('href="/bookings/owed-1?returnTo=%2Fdashboard"');
    expect(html).toContain('href="/profile?returnTo=%2Fdashboard#promo-codes"');
    expect(html).toContain("SAVE10");
    expect(html).toContain("10% off per individual");
  });
});
