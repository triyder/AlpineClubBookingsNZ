import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  isXeroConnected: vi.fn(),
  getXeroLockDates: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: h.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/xero-token-store", () => ({
  isXeroConnected: h.isXeroConnected,
}));
// getEffectiveXeroLockDate stays real: the effective-lock (later-of-two)
// resolution is part of what these tests prove.
vi.mock("@/lib/xero-organisation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/xero-organisation")>();
  return { ...actual, getXeroLockDates: h.getXeroLockDates };
});

import {
  assertCheckInClearsXeroLockDate,
  assertProposedCheckInClearsXeroLockDate,
  getXeroLockGuardErrorResponse,
  XeroLockDateCheckFailedError,
  XeroPeriodLockedError,
} from "@/lib/xero-period-lock-guard";
import {
  addDaysDateOnly,
  formatDateOnly,
  getTodayDateOnly,
} from "@/lib/date-only";

// Relative dates only: the guard compares against the real NZ today.
const daysAgo = (n: number) => addDaysDateOnly(getTodayDateOnly(), -n);

beforeEach(() => {
  vi.clearAllMocks();
  h.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: true });
  h.isXeroConnected.mockResolvedValue(true);
  h.getXeroLockDates.mockResolvedValue({
    periodLockDate: daysAgo(10),
    endOfYearLockDate: null,
  });
});

describe("assertCheckInClearsXeroLockDate", () => {
  it("passes a today-or-future check-in without touching flags, connection, or Xero", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(getTodayDateOnly()),
    ).resolves.toBeUndefined();
    await expect(
      assertCheckInClearsXeroLockDate(addDaysDateOnly(getTodayDateOnly(), 3)),
    ).resolves.toBeUndefined();

    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("passes an unparseable check-in (normal validation owns that rejection)", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(new Date("invalid")),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("skips when the Xero module is disabled", async () => {
    h.loadEffectiveModuleFlags.mockResolvedValue({ xeroIntegration: false });

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("skips when Xero is not connected", async () => {
    h.isXeroConnected.mockResolvedValue(false);

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("honours a caller-provided module flag instead of re-loading settings", async () => {
    await assertCheckInClearsXeroLockDate(daysAgo(5), {
      xeroIntegrationEnabled: true,
    });
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.getXeroLockDates).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    await assertCheckInClearsXeroLockDate(daysAgo(5), {
      xeroIntegrationEnabled: false,
    });
    expect(h.loadEffectiveModuleFlags).not.toHaveBeenCalled();
    expect(h.isXeroConnected).not.toHaveBeenCalled();
  });

  it("fails closed when the lock dates cannot be read", async () => {
    h.getXeroLockDates.mockRejectedValue(new Error("xero down"));

    await expect(assertCheckInClearsXeroLockDate(daysAgo(5))).rejects.toThrow(
      XeroLockDateCheckFailedError,
    );
  });

  it("rejects a past check-in before the effective lock date with the lock date attached", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: daysAgo(10),
      endOfYearLockDate: null,
    });

    const error = await assertCheckInClearsXeroLockDate(daysAgo(15)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(XeroPeriodLockedError);
    expect((error as XeroPeriodLockedError).status).toBe(409);
    expect((error as XeroPeriodLockedError).lockDate).toBe(
      formatDateOnly(daysAgo(10)),
    );
  });

  it("rejects a check-in exactly ON the lock date (locked periods are inclusive)", async () => {
    await expect(assertCheckInClearsXeroLockDate(daysAgo(10))).rejects.toThrow(
      XeroPeriodLockedError,
    );
  });

  it("passes a past check-in after the lock date", async () => {
    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(5)),
    ).resolves.toBeUndefined();
  });

  it("guards against the LATER of the two lock dates", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: daysAgo(20),
      endOfYearLockDate: daysAgo(8),
    });

    // Clears the period lock but not the end-of-year lock.
    await expect(assertCheckInClearsXeroLockDate(daysAgo(12))).rejects.toThrow(
      XeroPeriodLockedError,
    );
  });

  it("passes when neither lock date is set", async () => {
    h.getXeroLockDates.mockResolvedValue({
      periodLockDate: null,
      endOfYearLockDate: null,
    });

    await expect(
      assertCheckInClearsXeroLockDate(daysAgo(30)),
    ).resolves.toBeUndefined();
  });
});

describe("assertProposedCheckInClearsXeroLockDate", () => {
  const dbWith = (checkIn: Date | null) => ({
    booking: {
      findUnique: vi
        .fn()
        .mockResolvedValue(checkIn === null ? null : { checkIn }),
    },
  });

  it("guards the requested check-in without reading the booking", async () => {
    const db = dbWith(daysAgo(2));

    await expect(
      assertProposedCheckInClearsXeroLockDate(
        db,
        "b1",
        formatDateOnly(daysAgo(15)),
      ),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(db.booking.findUnique).not.toHaveBeenCalled();
  });

  it("falls back to the booking's current check-in when no new one was requested", async () => {
    const db = dbWith(daysAgo(15));

    await expect(
      assertProposedCheckInClearsXeroLockDate(db, "b1", undefined),
    ).rejects.toThrow(XeroPeriodLockedError);
    expect(db.booking.findUnique).toHaveBeenCalledWith({
      where: { id: "b1" },
      select: { checkIn: true },
    });
  });

  it("passes when the unchanged current check-in clears the lock", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(daysAgo(5)), "b1", undefined),
    ).resolves.toBeUndefined();
  });

  it("resolves silently for a missing booking (the transaction path 404s)", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(null), "b1", undefined),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });

  it("resolves silently for an unparseable requested date (validation owns it)", async () => {
    await expect(
      assertProposedCheckInClearsXeroLockDate(dbWith(daysAgo(2)), "b1", "not-a-date"),
    ).resolves.toBeUndefined();
    expect(h.getXeroLockDates).not.toHaveBeenCalled();
  });
});

describe("getXeroLockGuardErrorResponse", () => {
  it("maps XeroPeriodLockedError to a 409 body with code and lockDate", () => {
    const lockDate = formatDateOnly(daysAgo(10));
    const mapped = getXeroLockGuardErrorResponse(
      new XeroPeriodLockedError(lockDate),
    );
    expect(mapped).toEqual({
      body: {
        error: expect.stringContaining(lockDate),
        code: "XERO_PERIOD_LOCKED",
        lockDate,
      },
      status: 409,
    });
  });

  it("maps XeroLockDateCheckFailedError to a 503 body with code", () => {
    const mapped = getXeroLockGuardErrorResponse(
      new XeroLockDateCheckFailedError(),
    );
    expect(mapped).toEqual({
      body: {
        error: "Could not verify the Xero lock dates. Please try again.",
        code: "XERO_LOCK_DATE_CHECK_FAILED",
      },
      status: 503,
    });
  });

  it("returns null for anything else", () => {
    expect(getXeroLockGuardErrorResponse(new Error("other"))).toBeNull();
    expect(getXeroLockGuardErrorResponse(null)).toBeNull();
  });
});
