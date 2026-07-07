import { describe, expect, it } from "vitest";
import {
  isDashboardPaymentOwed,
  summarizeMemberPaymentOwed,
} from "../member-dashboard";

describe("summarizeMemberPaymentOwed", () => {
  it("adds outstanding initial and additional booking payments", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        id: "booking-1",
        status: "CONFIRMED",
        finalPriceCents: 12000,
        payment: null,
      },
      {
        id: "booking-2",
        status: "PAID",
        finalPriceCents: 9000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3000,
          additionalPaymentStatus: "PENDING",
        },
      },
      {
        id: "booking-3",
        status: "CONFIRMED",
        finalPriceCents: 8000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 1000,
          additionalPaymentStatus: "PENDING",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 3,
      totalCents: 24000,
    });
  });

  it("ignores bookings without any actionable amount due", () => {
    const summary = summarizeMemberPaymentOwed([
      {
        id: "booking-1",
        status: "PENDING",
        finalPriceCents: 7000,
        payment: {
          status: "PENDING",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-2",
        status: "CONFIRMED",
        finalPriceCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 0,
          additionalPaymentStatus: null,
        },
      },
      {
        id: "booking-3",
        status: "PAID",
        finalPriceCents: 7000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 2000,
          additionalPaymentStatus: "SUCCEEDED",
        },
      },
    ]);

    expect(summary).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });

  it("identifies the singular booking that should receive payment attention", () => {
    expect(
      isDashboardPaymentOwed({
        id: "booking-owed",
        status: "PAID",
        finalPriceCents: 12000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3500,
          additionalPaymentStatus: "PENDING",
        },
      }),
    ).toBe(true);

    expect(
      isDashboardPaymentOwed({
        id: "booking-settled",
        status: "PAID",
        finalPriceCents: 12000,
        payment: {
          status: "SUCCEEDED",
          additionalAmountCents: 3500,
          additionalPaymentStatus: "SUCCEEDED",
        },
      }),
    ).toBe(false);
  });

  it("does not treat zero-dollar unpaid bookings as payment-owed targets", () => {
    const booking = {
      id: "booking-zero",
      status: "CONFIRMED",
      finalPriceCents: 0,
      payment: null,
    };

    expect(isDashboardPaymentOwed(booking)).toBe(false);
    expect(summarizeMemberPaymentOwed([booking])).toEqual({
      bookingCount: 0,
      totalCents: 0,
    });
  });
});
