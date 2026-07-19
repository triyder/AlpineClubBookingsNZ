import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn() },
    booking: { count: vi.fn(), findMany: vi.fn() },
    payment: { aggregate: vi.fn() },
    refundRequest: { count: vi.fn() },
    adminCreditAdjustmentRequest: { count: vi.fn() },
    membershipCancellationRequest: { count: vi.fn() },
    memberLifecycleActionRequest: { count: vi.fn() },
    deletionRequest: { count: vi.fn() },
    bookingChangeRequest: { count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/lib/hut-leader-coverage", () => ({
  getUnassignedHutLeaderDates: vi.fn(),
}));

import AdminDashboardPage from "@/app/(admin)/admin/dashboard/page";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { auth } from "@/lib/auth";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

// getStats booking.count call order: totalBookings, activeBookings,
// upcomingCheckIns, unpaidFinishedStays, unsettledAdditionalFinishedStays,
// pendingBookingReviews, rosterStaysNeedingRoster, bedAllocationStaysAwaiting.
function mockStats() {
  vi.mocked(auth).mockResolvedValue({ user: { id: "admin-1" } } as any);
  vi.mocked(prisma.member.count)
    .mockResolvedValueOnce(50) // totalMembers
    .mockResolvedValueOnce(42) // activeMembers
    .mockResolvedValueOnce(8); // inactiveMembers
  vi.mocked(prisma.booking.count)
    .mockResolvedValueOnce(120) // totalBookings
    .mockResolvedValueOnce(15) // activeBookings
    .mockResolvedValueOnce(7) // upcomingCheckIns
    .mockResolvedValueOnce(0) // unpaidFinishedStays
    .mockResolvedValueOnce(0) // unsettledAdditionalFinishedStays
    .mockResolvedValueOnce(0) // pendingBookingReviews
    .mockResolvedValueOnce(4) // rosterStaysNeedingRoster
    .mockResolvedValueOnce(3); // bedAllocationStaysAwaiting
  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 123400 },
  } as any);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.adminCreditAdjustmentRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.membershipCancellationRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.memberLifecycleActionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.deletionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.bookingChangeRequest.count).mockResolvedValue(0);
  // Empty so the "assignment required" attention card stays hidden — this suite
  // isolates the officer key cards, and /admin/hut-leaders would otherwise also
  // be linked from that attention card.
  vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([]);
}

function mockActorMatrix(matrix: Partial<AdminPermissionMatrix>) {
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "admin-1",
    canLogin: true,
    accessRoles: [],
    adminPermissionMatrix: matrix,
  } as any);
}

describe("admin dashboard officer key cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStats();
  });

  it("renders all four officer cards with actionable counts for a full admin", async () => {
    mockActorMatrix({
      overview: "edit",
      bookings: "edit",
      membership: "edit",
      finance: "edit",
      lodge: "edit",
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    // Four officer surfaces linked from the primary row.
    expect(html).toContain('href="/admin/bookings?upcoming=7"');
    expect(html).toContain('href="/admin/hut-leaders"');
    expect(html).toContain('href="/admin/roster"');
    expect(html).toContain('href="/admin/bed-allocation"');

    // Officer-card-unique copy and headline counts.
    expect(html).toContain("checking in within 7 days");
    expect(html).toContain("Roster Assignment");
    expect(html).toContain("upcoming stays with no chores assigned");
    expect(html).toContain("Bed Allocation");
    expect(html).toContain("upcoming stays awaiting a bed");
    expect(html).toContain(">7</div>"); // upcoming check-ins
    expect(html).toContain(">4</div>"); // roster stays needing a roster
    expect(html).toContain(">3</div>"); // stays awaiting a bed

    // Slim secondary row keeps Members + Revenue.
    expect(html).toContain("Revenue This Month");
    expect(html).toContain("active of 50 total");
  });

  it("hides officer cards whose target page the actor cannot open", async () => {
    // Lodge-only officer: sees Hut Leader + Roster (lodge area), never the
    // Bookings / Bed Allocation cards (bookings area) or the Members / Revenue
    // secondary row (membership / finance areas).
    mockActorMatrix({ overview: "view", lodge: "edit" });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/hut-leaders"');
    expect(html).toContain("Roster Assignment");
    // Bookings-area officer cards are gone.
    expect(html).not.toContain('href="/admin/bed-allocation"');
    expect(html).not.toContain("Bed Allocation");
    expect(html).not.toContain('href="/admin/bookings?upcoming=7"');
    expect(html).not.toContain("checking in within 7 days");
    // Secondary row is entirely hidden.
    expect(html).not.toContain("Revenue This Month");
  });

  it("renders with no officer or secondary cards when the actor has no area access", async () => {
    mockActorMatrix({ overview: "view" });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    // Page still renders its shell and Recent Bookings without throwing.
    expect(html).toContain("Admin Dashboard");
    expect(html).toContain("Recent Bookings");
    expect(html).not.toContain("Roster Assignment");
    expect(html).not.toContain("Bed Allocation");
    expect(html).not.toContain("checking in within 7 days");
    expect(html).not.toContain("Revenue This Month");
  });
});
