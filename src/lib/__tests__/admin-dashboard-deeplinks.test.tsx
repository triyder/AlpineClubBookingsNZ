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
import { auth } from "@/lib/auth";
import { BED_ALLOCATABLE_BOOKING_STATUSES } from "@/lib/bed-allocation-lifecycle";
import {
  OPERATIONAL_STAY_BOOKING_STATUSES,
  UPCOMING_CHECK_IN_BOOKING_STATUSES,
} from "@/lib/booking-status";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { getUnassignedHutLeaderDates } from "@/lib/hut-leader-coverage";
import { prisma } from "@/lib/prisma";

function mockDashboardCounts({
  pendingBookingReviews,
  pendingBookingChangeRequests,
  pendingDeletionRequests = 0,
  unpaidFinishedStays = 0,
  unsettledAdditionalFinishedStays = 0,
}: {
  pendingBookingReviews: number;
  pendingBookingChangeRequests: number;
  pendingDeletionRequests?: number;
  unpaidFinishedStays?: number;
  unsettledAdditionalFinishedStays?: number;
}) {
  // A Full Admin actor so every permission-gated officer card renders (#2091).
  vi.mocked(auth).mockResolvedValue({ user: { id: "admin-1" } } as any);
  vi.mocked(prisma.member.findUnique).mockResolvedValue({
    id: "admin-1",
    canLogin: true,
    accessRoles: [{ role: "ADMIN" }],
  } as any);
  vi.mocked(prisma.member.count).mockResolvedValue(0);
  // booking.count call order mirrors getStats(): totalBookings,
  // activeBookings, upcomingCheckIns, unpaidFinishedStays,
  // unsettledAdditionalFinishedStays, pendingBookingReviews. The roster and bed
  // officer-card counts no longer use booking.count — they run through
  // window-scoped helpers backed by booking.findMany + choreAssignment.findMany
  // / bedAllocation.findMany (all mocked empty below → count 0).
  vi.mocked(prisma.booking.count)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(0)
    .mockResolvedValueOnce(unpaidFinishedStays)
    .mockResolvedValueOnce(unsettledAdditionalFinishedStays)
    .mockResolvedValueOnce(pendingBookingReviews);
  vi.mocked(prisma.payment.aggregate).mockResolvedValue({
    _sum: { amountCents: 0 },
  } as any);
  vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
  vi.mocked(prisma.choreAssignment.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.bedAllocation.findMany).mockResolvedValue([] as any);
  vi.mocked(prisma.refundRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.adminCreditAdjustmentRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.membershipCancellationRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.memberLifecycleActionRequest.count).mockResolvedValue(0);
  vi.mocked(prisma.deletionRequest.count).mockResolvedValue(
    pendingDeletionRequests,
  );
  vi.mocked(prisma.bookingChangeRequest.count).mockResolvedValue(
    pendingBookingChangeRequests,
  );
  vi.mocked(getUnassignedHutLeaderDates).mockResolvedValue([]);
}

describe("admin dashboard deep links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("links booking request alerts to the changes tab when only change requests are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=changes"');
  });

  it("links booking request alerts to the approvals tab when booking reviews are pending", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 1,
      pendingBookingChangeRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/booking-requests?tab=approvals"');
  });

  it("links pending account deletion request alerts to the deletion request queue", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      pendingDeletionRequests: 2,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toContain('href="/admin/deletion-requests?status=PENDING"');
    expect(html).toContain("Account Deletion Requests");
    expect(html).toContain(
      "2 account deletion requests waiting for admin review",
    );
  });

  it("flags unpaid finished stays and links to the pre-filtered bookings list", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      unpaidFinishedStays: 3,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());
    const todayKey = formatDateOnly(getTodayDateOnly());

    expect(html).toContain("Unpaid Finished Stays");
    expect(html).toContain(
      `href="/admin/bookings?status=PAYMENT_PENDING&amp;checkOutTo=${todayKey}"`,
    );
    expect(html).toContain("3 bookings still payment pending after check-out");

    // The count uses the finished-stay predicate (#1709): PAYMENT_PENDING
    // with check-out on or before NZ today, excluding soft-deleted bookings.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          deletedAt: null,
          status: "PAYMENT_PENDING",
          checkOut: { lte: getTodayDateOnly() },
        },
      },
    ]);
  });

  it("hides the unpaid finished stays card when no finished stay is owing", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).not.toContain("Unpaid Finished Stays");
  });

  it("flags unsettled finished-stay additions and links to the additionalOwed filter (#1723)", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
      unsettledAdditionalFinishedStays: 3,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());
    const todayKey = formatDateOnly(getTodayDateOnly());

    expect(html).toContain("Finished Stays With Unpaid Additions");
    expect(html).toContain(
      `href="/admin/bookings?additionalOwed=owed&amp;checkOutTo=${todayKey}"`,
    );
    expect(html).toContain("3 paid bookings");
    expect(html).toContain(
      "with an additional payment still owing after check-out",
    );

    // The count uses the sibling finished-stay predicate (#1723 path 2):
    // settled statuses (never PAYMENT_PENDING, so it stays disjoint from the
    // card above) whose latest additional payment never succeeded, with
    // check-out on or before NZ today.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          deletedAt: null,
          checkOut: { lte: getTodayDateOnly() },
          status: { in: ["CONFIRMED", "PAID", "COMPLETED"] },
          payment: {
            is: {
              additionalAmountCents: { gt: 0 },
              OR: [
                { additionalPaymentStatus: null },
                { additionalPaymentStatus: { not: "SUCCEEDED" } },
              ],
            },
          },
        },
      },
    ]);
  });

  it("hides the unpaid-additions card when every finished stay's additions are settled", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).not.toContain("Finished Stays With Unpaid Additions");
  });

  it("scopes the officer-card counts to the next-7-day window using each surface's own filters (#2091)", async () => {
    mockDashboardCounts({
      pendingBookingReviews: 0,
      pendingBookingChangeRequests: 0,
    });

    await AdminDashboardPage();

    const today = getTodayDateOnly();
    const to = addDaysDateOnly(today, 7);

    // Bookings card count matches the list it links to (/admin/bookings?
    // upcoming=7): the upcoming status set (excludes AWAITING_REVIEW), not
    // deleted, check-in within the next 7 days.
    expect(vi.mocked(prisma.booking.count).mock.calls).toContainEqual([
      {
        where: {
          status: { in: [...UPCOMING_CHECK_IN_BOOKING_STATUSES] },
          deletedAt: null,
          checkIn: { gte: today, lte: to },
        },
      },
    ]);

    // Roster count: operational stays overlapping the window, guest-existence
    // required (roster-status.ts semantics), scoped to today..+7.
    const rosterCall = vi
      .mocked(prisma.booking.findMany)
      .mock.calls.find(
        ([args]) =>
          JSON.stringify((args as { where?: { status?: unknown } })?.where?.status) ===
          JSON.stringify({ in: [...OPERATIONAL_STAY_BOOKING_STATUSES] }),
      );
    expect(rosterCall).toBeDefined();
    expect((rosterCall![0] as { where: unknown }).where).toMatchObject({
      deletedAt: null,
      checkIn: { lt: to },
      checkOut: { gt: today },
      guests: { some: { stayStart: { lt: to }, stayEnd: { gt: today } } },
    });

    // Chore assignments read for the same window.
    expect(vi.mocked(prisma.choreAssignment.findMany).mock.calls).toContainEqual([
      {
        where: { date: { gte: today, lt: to } },
        select: { date: true, status: true, bookingId: true },
      },
    ]);

    // Bed count: allocatable stays overlapping the window, whole-lodge holds
    // excluded, guest-existence required (admin-bed-allocation.ts semantics).
    const bedCall = vi
      .mocked(prisma.booking.findMany)
      .mock.calls.find(
        ([args]) =>
          (args as { where?: { wholeLodgeHold?: unknown } })?.where
            ?.wholeLodgeHold === false,
      );
    expect(bedCall).toBeDefined();
    expect((bedCall![0] as { where: unknown }).where).toMatchObject({
      deletedAt: null,
      status: { in: [...BED_ALLOCATABLE_BOOKING_STATUSES] },
      wholeLodgeHold: false,
      checkIn: { lt: to },
      checkOut: { gt: today },
      guests: { some: { stayStart: { lt: to }, stayEnd: { gt: today } } },
    });

    // Bed allocations diffed for the same window at guest-night granularity.
    expect(vi.mocked(prisma.bedAllocation.findMany).mock.calls).toContainEqual([
      {
        where: { stayDate: { gte: today, lt: to } },
        select: { bookingGuestId: true, stayDate: true },
      },
    ]);
  });
});
