import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn() },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    // Multi-lodge phase 8: the page loads active lodges for the lodge
    // filter/column (hidden while only one comes back).
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", name: "Lodge" }]),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));

vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));

vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: vi.fn().mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    }),
  };
});

import AdminBookingsPage, {
  formatAdminBookingGuestCount,
} from "@/app/(admin)/admin/bookings/page";
import {
  adminBookingsQuerySchema,
  listAdminBookings,
} from "@/lib/admin-bookings-service";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

const effectiveModulesOn = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
  bedAllocation: true,
  internetBankingPayments: true,
  // Flags this page does not exercise stay off, matching the pre-existing
  // runtime behaviour when they were absent from the fixture.
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  analytics: false,
  multiLodge: false,
};

describe("AdminBookingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(effectiveModulesOn);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
    vi.mocked(auth).mockResolvedValue({
      user: {
        id: "admin-1",
        accessRoles: [{ role: "ADMIN" }],
      },
    } as any);
  });

  function makeBooking(overrides: Record<string, unknown> = {}) {
    return {
      id: "booking-1",
      status: "PAID",
      checkIn: new Date("2026-07-01T00:00:00.000Z"),
      checkOut: new Date("2026-07-03T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      finalPriceCents: 10000,
      requiresAdminReview: false,
      adminReviewStatus: null,
      adminReviewReason: null,
      deletedAt: null,
      member: {
        id: "member-1",
        firstName: "Aroha",
        lastName: "Ngata",
        email: "aroha@example.test",
      },
      guests: [],
      payment: null,
      bedAllocations: [],
      modifications: [],
      changeRequests: [],
      creditsFromCancellation: [],
      refundRequests: [],
      ...overrides,
    };
  }

  it("applies separate last-updated and check-in date ranges", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        updatedFrom: "2026-05-01",
        updatedTo: "2026-05-31",
        checkInFrom: "2026-07-01",
        checkInTo: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.updatedAt.gte).toEqual(new Date("2026-04-30T12:00:00.000Z"));
    expect(callArgs.where.updatedAt.lte).toEqual(new Date("2026-05-31T11:59:59.999Z"));
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(callArgs.where.checkIn.lte).toEqual(new Date("2026-07-31T00:00:00.000Z"));
    expect(callArgs.where.checkOut).toBeUndefined();
  });

  it("applies a check-out date range via checkOutFrom/checkOutTo", async () => {
    const from = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), -14));
    const to = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), -7));

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        checkOutFrom: from,
        checkOutTo: to,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkOut.gte).toEqual(parseDateOnly(from));
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(to));
    expect(callArgs.where.checkIn).toBeUndefined();
  });

  it("expresses the unpaid-finished-stays deep link (#1709): status=PAYMENT_PENDING and checkOutTo=today", async () => {
    const todayKey = formatDateOnly(getTodayDateOnly());

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        status: "PAYMENT_PENDING",
        checkOutTo: todayKey,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.status).toBe("PAYMENT_PENDING");
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(todayKey));
  });

  it("prefers explicit checkOutTo over the legacy to param", async () => {
    const legacyTo = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), 30));
    const checkOutTo = formatDateOnly(getTodayDateOnly());

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        to: legacyTo,
        checkOutTo,
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkOut.lte).toEqual(parseDateOnly(checkOutTo));
    expect(callArgs.where.checkOut.gte).toBeUndefined();
  });

  it("keeps legacy from/to compatibility when named check-in params are absent", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        from: "2026-07-01",
        to: "2026-07-31",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00.000Z"));
    expect(callArgs.where.checkOut.lte).toEqual(new Date("2026-07-31T00:00:00.000Z"));
  });

  it("treats BookingFilters' rewrite of a legacy from/to link as a no-op (#1720)", async () => {
    // BookingFilters rewrites ?from=A&to=B into ?checkInFrom=A&checkOutTo=B.
    // Both spellings must build the identical date where-clause.
    const legacyFrom = formatDateOnly(getTodayDateOnly());
    const legacyTo = formatDateOnly(addDaysDateOnly(getTodayDateOnly(), 14));

    await AdminBookingsPage({
      searchParams: Promise.resolve({ from: legacyFrom, to: legacyTo }),
    });
    const legacyWhere = (
      vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any
    ).where;

    vi.mocked(prisma.booking.findMany).mockClear();

    await AdminBookingsPage({
      searchParams: Promise.resolve({
        checkInFrom: legacyFrom,
        checkOutTo: legacyTo,
      }),
    });
    const rewrittenWhere = (
      vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any
    ).where;

    expect(rewrittenWhere.checkIn).toEqual(legacyWhere.checkIn);
    expect(rewrittenWhere.checkOut).toEqual(legacyWhere.checkOut);
    expect(legacyWhere.checkIn.gte).toEqual(parseDateOnly(legacyFrom));
    expect(legacyWhere.checkOut.lte).toEqual(parseDateOnly(legacyTo));
  });

  it("sorts by member using stable member-name ordering", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-z",
        member: {
          id: "member-z",
          firstName: "Zoe",
          lastName: "Young",
          email: "zoe@example.test",
        },
      }),
      makeBooking({
        id: "booking-a",
        member: {
          id: "member-a",
          firstName: "Amy",
          lastName: "Adams",
          email: "amy@example.test",
        },
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        sortBy: "member",
        sortDir: "asc",
      })
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual([
      "booking-a",
      "booking-z",
    ]);
  });

  it("hides soft-deleted bookings by default", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({}),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.deletedAt).toBeNull();
  });

  it("can filter to deleted bookings only", async () => {
    await AdminBookingsPage({
      searchParams: Promise.resolve({
        deleted: "only",
      }),
    });

    const callArgs = vi.mocked(prisma.booking.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.deletedAt).toEqual({ not: null });
  });

  it("filters bookings by missing Xero invoice state", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-missing",
        payment: {
          id: "payment-missing",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          refundedAmountCents: 0,
        },
      }),
      makeBooking({
        id: "booking-linked",
        payment: {
          id: "payment-linked",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: "inv-1",
          xeroInvoiceNumber: "INV-1",
          refundedAmountCents: 0,
        },
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ xeroState: "invoiceMissing" })
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-missing"]);
    expect(result.bookings[0].operational.xeroState).toBe("invoiceMissing");
  });

  it("filters bookings by no-payment source", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({ id: "booking-none", payment: null }),
      makeBooking({
        id: "booking-stripe",
        payment: {
          id: "payment-stripe",
          source: "STRIPE",
          status: "SUCCEEDED",
          xeroInvoiceId: "inv-1",
          xeroInvoiceNumber: "INV-1",
          refundedAmountCents: 0,
        },
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ paymentSource: "NONE" })
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-none"]);
  });

  it("filters bookings by bed allocation and change state", async () => {
    const guest = {
      id: "guest-1",
      firstName: "Tama",
      lastName: "Guest",
      ageTier: "ADULT",
      isMember: false,
      stayStart: new Date("2026-07-01T00:00:00.000Z"),
      stayEnd: new Date("2026-07-03T00:00:00.000Z"),
    };
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-unallocated",
        guests: [guest],
        changeRequests: [{ id: "request-1", status: "REQUESTED", createdAt: new Date(), linkedModificationId: null }],
      }),
      makeBooking({
        id: "booking-clean",
        guests: [guest],
        bedAllocations: [
          {
            id: "allocation-1",
            bookingId: "booking-clean",
            bookingGuestId: "guest-1",
            roomId: "room-1",
            bedId: "bed-1",
            stayDate: new Date("2026-07-01T00:00:00.000Z"),
            approvedAt: new Date("2026-06-01T00:00:00.000Z"),
            bookingGuest: {
              id: "guest-1",
              firstName: "Tama",
              lastName: "Guest",
              ageTier: "ADULT",
            },
            room: { id: "room-1", name: "Room 1" },
            bed: { id: "bed-1", name: "Bed 1" },
          },
          {
            id: "allocation-2",
            bookingId: "booking-clean",
            bookingGuestId: "guest-1",
            roomId: "room-1",
            bedId: "bed-1",
            stayDate: new Date("2026-07-02T00:00:00.000Z"),
            approvedAt: new Date("2026-06-01T00:00:00.000Z"),
            bookingGuest: {
              id: "guest-1",
              firstName: "Tama",
              lastName: "Guest",
              ageTier: "ADULT",
            },
            room: { id: "room-1", name: "Room 1" },
            bed: { id: "bed-1", name: "Bed 1" },
          },
        ],
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({
        bedState: "unallocated",
        changeState: "pendingRequest",
      })
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-unallocated"]);
    expect(result.bookings[0].operational.bedState).toBe("unallocated");
    expect(result.bookings[0].operational.pendingChangeRequest).toBe(true);
  });

  it("ignores bed allocation filters when the module is disabled", async () => {
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        id: "booking-clean",
        guests: [
          {
            id: "guest-1",
            firstName: "Tama",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: new Date("2026-07-01T00:00:00.000Z"),
            stayEnd: new Date("2026-07-03T00:00:00.000Z"),
          },
        ],
      }),
    ] as any);

    const result = await listAdminBookings(
      adminBookingsQuerySchema.parse({ bedState: "unallocated" }),
      { bedAllocationEnabled: false }
    );

    expect(result.bookings.map((booking) => booking.id)).toEqual(["booking-clean"]);
    expect(result.bookings[0].operational.expectedGuestNights).toBe(0);
  });

  it("hides bed allocation booking UI when the effective module is disabled", async () => {
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValueOnce({
      ...effectiveModulesOn,
      bedAllocation: false,
    });
    vi.mocked(prisma.booking.findMany).mockResolvedValue([
      makeBooking({
        guests: [
          {
            id: "guest-1",
            firstName: "Tama",
            lastName: "Guest",
            ageTier: "ADULT",
            isMember: false,
            stayStart: new Date("2026-07-01T00:00:00.000Z"),
            stayEnd: new Date("2026-07-03T00:00:00.000Z"),
          },
        ],
      }),
    ] as any);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({ bedState: "unallocated" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("All Bookings");
    expect(html).toContain("Aroha Ngata");
    expect(html).toContain("Changes");
    expect(html).not.toContain("/admin/bed-allocation");
    expect(html).not.toContain("bedState=unallocated");
    expect(html).not.toContain(">Beds<");
    expect(html).not.toContain("Unallocated");
  });

  it("disables booking creation for a bookings view-only admin", async () => {
    vi.mocked(auth).mockResolvedValueOnce({
      user: {
        id: "admin-readonly",
        accessRoles: [{ role: "ADMIN_READONLY" }],
      },
    } as any);

    const element = await AdminBookingsPage({
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("+ Create Booking");
    expect(html).toContain("disabled");
    expect(html).toContain(ADMIN_VIEW_ONLY_ACTION_REASON);
    expect(html).not.toContain('href="/admin/book"');
  });

  it("formats total guests with non-member guests in brackets", () => {
    expect(formatAdminBookingGuestCount(6, 2)).toBe("6 (2 non-members)");
    expect(formatAdminBookingGuestCount(1, 1)).toBe("1 (1 non-member)");
  });
});
