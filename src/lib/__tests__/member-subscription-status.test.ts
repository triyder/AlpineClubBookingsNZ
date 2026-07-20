import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      // Delegates the membership-type-policy resolver reads. Default to empty so
      // the resolver returns null (no policy) and existing tests are unchanged.
      findMany: vi.fn(async () => []),
    },
    seasonalMembershipAssignment: { findMany: vi.fn(async () => []) },
    membershipType: { findMany: vi.fn(async () => []) },
    // #2041 NOT_REQUIRED-row dominance lookup (booking resolver).
    memberSubscription: { findFirst: vi.fn(async () => null) },
  },
}));

// The subscription gate consults the effective module flags (Xero-off
// bypass). Default to Xero on; individual tests flip it off.
const mockLoadEffectiveModuleFlags = vi.fn();
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: (...args: unknown[]) =>
      mockLoadEffectiveModuleFlags(...args),
  };
});
vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: vi.fn(async () => 3),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/subscription-status/route";

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.member.findUnique as ReturnType<typeof vi.fn>;

describe("GET /api/member/subscription-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [],
    });
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns invoice metadata for the current season", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      }],
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual(expect.objectContaining({
      status: "UNPAID",
      rawStatus: "UNPAID",
      subscriptionRequired: true,
      effectiveStatusReason: "REQUIRED",
      seasonDisplay: "2026/2027",
      invoiceUrl: "https://pay.xero.com/invoice/inv-1",
      invoiceNumber: "INV-0042",
      rawInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      rawInvoiceNumber: "INV-0042",
      membershipTypeKey: null,
      membershipTypeName: null,
      membershipTypeSubscriptionBehavior: null,
    }));
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1" },
        select: expect.objectContaining({
          role: true,
          ageTier: true,
          subscriptions: expect.objectContaining({
            where: { seasonYear: 2026 },
            select: expect.objectContaining({
              status: true,
              xeroInvoiceId: true,
              xeroInvoiceNumber: true,
              xeroOnlineInvoiceUrl: true,
            }),
          }),
        }),
      })
    );
  });

  it("keeps member subscription reads local even when the invoice URL is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: null,
      }],
    });

    const res = await GET();
    const body = await res.json();

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(body.invoiceUrl).toBeNull();
    expect(body.rawInvoiceNumber).toBe("INV-0042");
  });

  it("returns not required for members whose age tier does not require subscriptions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "CHILD",
      subscriptions: [],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("NOT_REQUIRED");
    expect(body.subscriptionRequired).toBe(false);
    expect(body.rawStatus).toBe("NOT_INVOICED");
    expect(body.invoiceUrl).toBeNull();
  });

  it("reports MEMBERSHIP_TYPE_AGE_TIER_NOT_REQUIRED for a BASED_ON_AGE_TIER type on an exempt tier (#2041)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "CHILD",
      subscriptions: [],
    });
    const findMany = prisma.member.findMany as ReturnType<typeof vi.fn>;
    findMany.mockResolvedValue([
      { id: "member-1", firstName: "Alex", lastName: "Member", email: "a@x.test", role: "MEMBER", ageTier: "CHILD" },
    ]);
    (prisma.seasonalMembershipAssignment.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        memberId: "member-1",
        seasonYear: 2026,
        membershipType: {
          id: "type-full", key: "FULL", name: "Full", isActive: true, isBuiltIn: true,
          bookingBehavior: "MEMBER_RATE", subscriptionBehavior: "BASED_ON_AGE_TIER",
        },
      },
    ]);

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.subscriptionRequired).toBe(false);
    expect(body.status).toBe("NOT_REQUIRED");
    expect(body.effectiveStatusReason).toBe("MEMBERSHIP_TYPE_AGE_TIER_NOT_REQUIRED");
    expect(body.membershipTypeSubscriptionBehavior).toBe("BASED_ON_AGE_TIER");
  });

  it("returns not required when the Xero module is effectively off", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    // Subscriptions are invoiced through Xero; with the module off the
    // status endpoint must not report an outstanding subscription.
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: false,
      bedAllocation: true,
      internetBankingPayments: false,
    });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      }],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("NOT_REQUIRED");
    expect(body.rawStatus).toBe("UNPAID");
    expect(body.subscriptionRequired).toBe(false);
    expect(body.invoiceUrl).toBeNull();
    expect(body.invoiceNumber).toBeNull();
    expect(body.rawInvoiceUrl).toBe("https://pay.xero.com/invoice/inv-1");
    expect(body.rawInvoiceNumber).toBe("INV-0042");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
