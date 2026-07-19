import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn() },
    booking: { count: vi.fn(), findMany: vi.fn() },
    choreAssignment: { findMany: vi.fn() },
    bedAllocation: { findMany: vi.fn() },
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
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

// getStats booking.count call order (roster + bed counts no longer use
// booking.count — they now run through window-scoped helpers that findMany
// bookings + choreAssignments / bedAllocations): totalBookings, activeBookings,
// upcomingCheckIns, unpaidFinishedStays, unsettledAdditionalFinishedStays,
// pendingBookingReviews.
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
    .mockResolvedValueOnce(0); // pendingBookingReviews

  // The reworked officer-card counts compute over real fixtures so the headline
  // reconciles with each surface's own semantics (#2091 review). A single guest
  // stays two of the next seven nights with no chore assignment → 2 roster
  // nights needing chores; three guests each have an unallocated bed-night in
  // the window → 3 guests awaiting a bed.
  const today = getTodayDateOnly();
  const plus1 = addDaysDateOnly(today, 1);
  const plus2 = addDaysDateOnly(today, 2);

  const rosterBookings = [
    {
      id: "rb1",
      checkIn: today,
      checkOut: plus2,
      guests: [{ stayStart: today, stayEnd: plus2, ageTier: null, nights: [] }],
    },
  ];
  const bedBookings = [
    {
      id: "bb1",
      guests: [
        { id: "g1", stayStart: today, stayEnd: plus1 },
        { id: "g2", stayStart: today, stayEnd: plus1 },
        { id: "g3", stayStart: today, stayEnd: plus1 },
      ],
    },
  ];

  // booking.findMany serves three callers; route by the where-clause each uses:
  // the bed helper is the only one filtering wholeLodgeHold, the roster helper
  // the only other one carrying a status set, and Recent Bookings carries
  // neither.
  vi.mocked(prisma.booking.findMany).mockImplementation((args: any) => {
    const where = args?.where ?? {};
    if (where.wholeLodgeHold === false) return Promise.resolve(bedBookings) as any;
    if (where.status) return Promise.resolve(rosterBookings) as any;
    return Promise.resolve([]) as any; // Recent Bookings
  });
  vi.mocked(prisma.choreAssignment.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as any);

  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 123400 },
  } as any);
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

// Resolve the actor through the accessRoles-derivation path production actually
// uses (the dashboard's actor select carries accessRoles only — never an
// embedded adminPermissionMatrix), by attaching a definition-backed custom role
// whose per-area levels produce the requested matrix (#2091 review).
function mockActorMatrix(matrix: Partial<AdminPermissionMatrix>) {
  const roleDefinition = Object.fromEntries(
    Object.entries(matrix).map(([area, level]) => [
      `${area}Level`,
      level === "edit" ? "EDIT" : level === "view" ? "VIEW" : "NONE",
    ]),
  );
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "admin-1",
    canLogin: true,
    accessRoles: [{ role: null, roleDefinition }],
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
    expect(html).toContain("nights in the next 7 days with no chores assigned");
    expect(html).toContain("Bed Allocation");
    expect(html).toContain("guests in the next 7 days awaiting a bed");
    expect(html).toContain(">7</div>"); // upcoming check-ins
    expect(html).toContain(">2</div>"); // roster nights needing chores
    expect(html).toContain(">3</div>"); // guests awaiting a bed

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
