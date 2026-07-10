import { beforeEach, describe, expect, it, vi } from "vitest";

// #1697 wiring: both recalculate-override services must consult the Xero
// lock-date guard BEFORE opening their modification transaction (the guard
// performs a Xero API call, which must never run inside a DB transaction),
// and only when the admin override is active.

const h = vi.hoisted(() => ({
  assertProposed: vi.fn(),
  transaction: vi.fn(),
}));

const TRANSACTION_SENTINEL = new Error("reached-the-transaction");

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: h.transaction,
    booking: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/xero-period-lock-guard", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-period-lock-guard")>();
  return { ...actual, assertProposedCheckInClearsXeroLockDate: h.assertProposed };
});
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { modifyBookingBatch } from "@/lib/booking-batch-modification-service";
import { modifyBookingDates } from "@/lib/booking-date-modification-service";
import { XeroPeriodLockedError } from "@/lib/xero-period-lock-guard";

const actor = { id: "admin1", role: "ADMIN" as const };

beforeEach(() => {
  vi.clearAllMocks();
  h.assertProposed.mockResolvedValue(undefined);
  // The transaction body needs a real database; every case here must resolve
  // BEFORE it. Rejecting with a sentinel proves exactly how far a call got.
  h.transaction.mockRejectedValue(TRANSACTION_SENTINEL);
});

describe("modifyBookingDates (issue #1697)", () => {
  it("consults the guard with the requested check-in before the transaction and propagates its rejection", async () => {
    h.assertProposed.mockRejectedValue(new XeroPeriodLockedError("2026-06-30"));

    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        // This service's override is always the recalculate mode (shift is
        // dispatched to adminShiftBookingDates at the route).
        input: {
          adminOverride: true,
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(XeroPeriodLockedError);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "2026-06-15",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("passes undefined for a check-out-only override (the guard falls back to the stored check-in)", async () => {
    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          checkOut: "2026-06-20",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      undefined,
    );
  });

  it("never consults the guard for a standard (non-override) date change", async () => {
    await expect(
      modifyBookingDates({
        bookingId: "b1",
        actor,
        input: { checkIn: "2026-06-15" },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).not.toHaveBeenCalled();
  });
});

describe("modifyBookingBatch (issue #1697)", () => {
  it("consults the guard for a recalculate override before the transaction and propagates its rejection", async () => {
    h.assertProposed.mockRejectedValue(new XeroPeriodLockedError("2026-06-30"));

    await expect(
      modifyBookingBatch({
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          pricingMode: "recalculate",
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(XeroPeriodLockedError);

    expect(h.assertProposed).toHaveBeenCalledWith(
      expect.anything(),
      "b1",
      "2026-06-15",
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("rejects shift mode before the guard is ever consulted (shift never reaches recalculate machinery)", async () => {
    await expect(
      modifyBookingBatch({
        bookingId: "b1",
        actor,
        input: {
          adminOverride: true,
          pricingMode: "shift",
          checkIn: "2026-06-15",
        },
        ipAddress: "test",
      }),
    ).rejects.toThrow(
      "Shift-mode admin overrides are applied through the date-shift path",
    );

    expect(h.assertProposed).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("never consults the guard for a standard (non-override) edit", async () => {
    await expect(
      modifyBookingBatch({
        bookingId: "b1",
        actor,
        input: { checkIn: "2026-06-15" },
        ipAddress: "test",
      }),
    ).rejects.toThrow(TRANSACTION_SENTINEL);

    expect(h.assertProposed).not.toHaveBeenCalled();
  });
});
