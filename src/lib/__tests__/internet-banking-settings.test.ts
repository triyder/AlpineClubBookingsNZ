import { describe, expect, it } from "vitest";
import { DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS } from "@/config/club-settings-defaults";
import { parseDateOnly } from "@/lib/date-only";
import {
  buildInternetBankingHoldPolicySummary,
  checkInternetBankingLeadTime,
  normalizeInternetBankingPaymentSettings,
} from "@/lib/internet-banking-settings";

describe("internet banking payment settings", () => {
  it("defaults to unheld bookings with no lead-time cutoff", () => {
    expect(normalizeInternetBankingPaymentSettings(null)).toEqual(
      DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
    );
    expect(DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS).toEqual({
      holdBedSlots: false,
      holdDays: 3,
      minimumDaysBeforeCheckIn: 0,
    });
  });

  it("allows no-check-in option lookups", () => {
    expect(
      checkInternetBankingLeadTime({
        settings: DEFAULT_INTERNET_BANKING_PAYMENT_SETTINGS,
        today: parseDateOnly("2026-06-28"),
      }),
    ).toMatchObject({
      allowed: true,
      checkIn: null,
      minimumDaysBeforeCheckIn: 0,
    });
  });

  it("blocks bookings inside the configured NZ date-only lead time", () => {
    const result = checkInternetBankingLeadTime({
      checkIn: parseDateOnly("2026-07-01"),
      today: parseDateOnly("2026-06-28"),
      settings: {
        holdBedSlots: false,
        holdDays: 3,
        minimumDaysBeforeCheckIn: 5,
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.unavailableReason).toContain("5 days before check-in");
  });

  it("allows bookings on or after the configured lead-time boundary", () => {
    expect(
      checkInternetBankingLeadTime({
        checkIn: parseDateOnly("2026-07-03"),
        today: parseDateOnly("2026-06-28"),
        settings: {
          holdBedSlots: false,
          holdDays: 3,
          minimumDaysBeforeCheckIn: 5,
        },
      }).allowed,
    ).toBe(true);
  });

  it("describes held and unheld policies", () => {
    expect(
      buildInternetBankingHoldPolicySummary({
        holdBedSlots: false,
        holdDays: 3,
        minimumDaysBeforeCheckIn: 0,
      }),
    ).toContain("not held");

    expect(
      buildInternetBankingHoldPolicySummary({
        holdBedSlots: true,
        holdDays: 1,
        minimumDaysBeforeCheckIn: 0,
      }),
    ).toContain("1 day");
  });
});
