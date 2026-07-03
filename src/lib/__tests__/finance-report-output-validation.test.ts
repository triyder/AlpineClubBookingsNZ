import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { parseDateOnly } from "@/lib/date-only";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    booking: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (input: string | { financeAccessLevel?: string }) =>
    (typeof input === "string" ? input : input.financeAccessLevel) === "MANAGER",
}));

import { buildFinanceBookingsReportPageModel } from "@/lib/finance-bookings-report-page";
import { FALLBACK_LODGE_CAPACITY as LODGE_CAPACITY } from "@/lib/lodge-capacity";

function occupiedBedsLabel(occupiedBeds: number): string {
  return `${occupiedBeds} / ${LODGE_CAPACITY}`;
}

function occupancyLabel(occupiedBedNights: number, dayCount = 1): string {
  const capacityBedNights = LODGE_CAPACITY * dayCount;
  const rate =
    capacityBedNights > 0
      ? Number((occupiedBedNights / capacityBedNights).toFixed(4))
      : 0;
  return `${(rate * 100).toFixed(1)}%`;
}

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "View",
    lastName: "Only",
    role: "USER" as const,
    financeAccessLevel: "VIEWER" as const,
    active: true,
    forcePasswordChange: false,
    accessRoles: [],
    twoFactorEnabled: false,
  };
}

function representativeBookings() {
  return [
    {
      id: "booking-confirmed-split",
      checkIn: new Date("2026-04-20T00:00:00.000Z"),
      checkOut: new Date("2026-04-23T00:00:00.000Z"),
      status: BookingStatus.PAID,
      finalPriceCents: 30000,
      guests: [{ id: "guest-1" }, { id: "guest-2" }],
      payment: {
        status: PaymentStatus.SUCCEEDED,
        amountCents: 30000,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        creditAppliedCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
    {
      id: "booking-paid-realized",
      checkIn: new Date("2026-04-18T00:00:00.000Z"),
      checkOut: new Date("2026-04-20T00:00:00.000Z"),
      status: BookingStatus.PAID,
      finalPriceCents: 12000,
      guests: [{ id: "guest-3" }],
      payment: {
        status: PaymentStatus.PARTIALLY_REFUNDED,
        amountCents: 12000,
        refundedAmountCents: 2000,
        changeFeeCents: 500,
        creditAppliedCents: 1000,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
    {
      id: "booking-completed-free",
      checkIn: new Date("2026-04-19T00:00:00.000Z"),
      checkOut: new Date("2026-04-20T00:00:00.000Z"),
      status: BookingStatus.COMPLETED,
      finalPriceCents: 0,
      guests: [{ id: "guest-4" }, { id: "guest-5" }, { id: "guest-6" }],
      payment: null,
    },
    {
      id: "booking-pending-forward",
      checkIn: new Date("2026-04-22T00:00:00.000Z"),
      checkOut: new Date("2026-04-24T00:00:00.000Z"),
      status: BookingStatus.PENDING,
      finalPriceCents: 8000,
      guests: [{ id: "guest-7" }],
      payment: {
        status: PaymentStatus.PENDING,
        amountCents: 8000,
        refundedAmountCents: 0,
        changeFeeCents: 0,
        creditAppliedCents: 0,
        additionalAmountCents: 0,
        additionalPaymentStatus: null,
      },
    },
  ];
}

describe("finance report output validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:30:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the representative bookings report output aligned with booking metrics", async () => {
    mockPrisma.booking.findMany.mockResolvedValue(representativeBookings());

    const model = await buildFinanceBookingsReportPageModel({
      member: financeViewer(),
      today: parseDateOnly("2026-04-21"),
      searchParams: {
        realizedFrom: "2026-04-18",
        realizedTo: "2026-04-22",
        realizedCutoff: "2026-04-21",
        forwardFrom: "2026-04-20",
        forwardTo: "2026-04-24",
        forwardAsOf: "2026-04-21",
      },
    });

    expect(model.realized.cards).toMatchObject([
      {
        title: "Guest nights",
        value: "9",
        footnote: "5 booking nights were realized.",
      },
      {
        title: "Occupancy",
        value: occupancyLabel(9, 4),
      },
      {
        title: "Booked revenue",
        value: "$320.00",
        footnote: "$64.00 average nightly revenue.",
      },
      {
        title: "Net collected cash",
        value: "$400.00",
        footnote: "1 booking has no payment row yet.",
      },
    ]);
    expect(model.realized.dailyRows).toEqual([
      {
        date: "Sat, 18 Apr",
        bookingCount: "1",
        guestNights: "1",
        occupiedBeds: occupiedBedsLabel(1),
        occupancyRate: occupancyLabel(1),
        bookedRevenue: "$60.00",
      },
      {
        date: "Sun, 19 Apr",
        bookingCount: "2",
        guestNights: "4",
        occupiedBeds: occupiedBedsLabel(4),
        occupancyRate: occupancyLabel(4),
        bookedRevenue: "$60.00",
      },
      {
        date: "Mon, 20 Apr",
        bookingCount: "1",
        guestNights: "2",
        occupiedBeds: occupiedBedsLabel(2),
        occupancyRate: occupancyLabel(2),
        bookedRevenue: "$100.00",
      },
      {
        date: "Tue, 21 Apr",
        bookingCount: "1",
        guestNights: "2",
        occupiedBeds: occupiedBedsLabel(2),
        occupancyRate: occupancyLabel(2),
        bookedRevenue: "$100.00",
      },
    ]);
    expect(model.realized.statusRows).toMatchObject([
      {
        pipeline: "Realized",
        status: "Paid",
        bookingCount: "2",
        bookingNights: "4",
        guestNights: "6",
        bookedRevenue: "$320.00",
      },
      {
        pipeline: "Realized",
        status: "Completed",
        bookingCount: "1",
        bookingNights: "1",
        guestNights: "3",
        bookedRevenue: "$0.00",
      },
    ]);
    expect(model.forward.cards).toMatchObject([
      {
        title: "Committed guest nights",
        value: "2",
        footnote: "$100.00",
      },
      {
        title: "At-risk guest nights",
        value: "2",
        footnote: "$80.00",
      },
      {
        title: "Total pipeline revenue",
        value: "$180.00",
      },
      {
        title: "Pipeline occupancy",
        value: occupancyLabel(4, 3),
      },
    ]);
    expect(model.forward.dailyRows).toEqual([
      {
        date: "Wed, 22 Apr",
        bookingCount: "2",
        guestNights: "3",
        occupiedBeds: occupiedBedsLabel(3),
        occupancyRate: occupancyLabel(3),
        bookedRevenue: "$140.00",
        committedBookingCount: "1",
        committedGuestNights: "2",
        atRiskBookingCount: "1",
        atRiskGuestNights: "1",
        totalPipelineBookingCount: "2",
        totalPipelineGuestNights: "3",
      },
      {
        date: "Thu, 23 Apr",
        bookingCount: "1",
        guestNights: "1",
        occupiedBeds: occupiedBedsLabel(1),
        occupancyRate: occupancyLabel(1),
        bookedRevenue: "$40.00",
        committedBookingCount: "0",
        committedGuestNights: "0",
        atRiskBookingCount: "1",
        atRiskGuestNights: "1",
        totalPipelineBookingCount: "1",
        totalPipelineGuestNights: "1",
      },
      {
        date: "Fri, 24 Apr",
        bookingCount: "0",
        guestNights: "0",
        occupiedBeds: occupiedBedsLabel(0),
        occupancyRate: occupancyLabel(0),
        bookedRevenue: "$0.00",
        committedBookingCount: "0",
        committedGuestNights: "0",
        atRiskBookingCount: "0",
        atRiskGuestNights: "0",
        totalPipelineBookingCount: "0",
        totalPipelineGuestNights: "0",
      },
    ]);
    expect(model.forward.statusRows).toMatchObject([
      {
        pipeline: "Committed",
        status: "Paid",
        bookingCount: "1",
        bookingNights: "1",
        guestNights: "2",
        bookedRevenue: "$100.00",
      },
      {
        pipeline: "At risk",
        status: "Pending",
        bookingCount: "1",
        bookingNights: "2",
        guestNights: "2",
        bookedRevenue: "$80.00",
      },
      {
        pipeline: "At risk",
        status: "Payment Pending",
        bookingCount: "0",
        bookingNights: "0",
        guestNights: "0",
        bookedRevenue: "$0.00",
      },
      {
        pipeline: "At risk",
        status: "Confirmed",
        bookingCount: "0",
        bookingNights: "0",
        guestNights: "0",
        bookedRevenue: "$0.00",
      },
    ]);
  });

});
