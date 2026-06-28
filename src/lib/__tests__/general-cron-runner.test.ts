import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/booking-request", () => ({
  purgeExpiredBookingRequests: vi.fn(),
}));

vi.mock("@/lib/cron-confirm-pending", () => ({
  confirmPendingBookings: vi.fn(),
}));

vi.mock("@/lib/cron-job-run", () => ({
  recordCronJobRunSafe: vi.fn(),
}));

vi.mock("@/lib/cron-pre-arrival-reminders", () => ({
  sendPreArrivalReminders: vi.fn(),
}));

vi.mock("@/lib/cron-quote-expiry-reminders", () => ({
  sendQuoteExpiryReminders: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

import {
  GeneralCronCycleError,
  runGeneralCronCycle,
} from "@/lib/general-cron-runner";

describe("general cron runner", () => {
  it("records every job in the shared general cron cycle", async () => {
    const recordCronRun = vi.fn();
    const result = await runGeneralCronCycle({
      recordCronRun,
      log: { error: vi.fn(), info: vi.fn() },
      tasks: {
        confirmPendingBookings: vi.fn(async () => ({
          confirmedBookingIds: ["booking-1"],
          bumpedBookingIds: [],
          partialBumpedBookingIds: [],
          failedBookingIds: [],
        })),
        sendPreArrivalReminders: vi.fn(async () => ({
          reminderDays: 3,
          windowStart: "2026-06-28",
          windowEndExclusive: "2026-07-02",
          sentBookingIds: ["booking-1"],
          skippedBookingIds: [],
          failedBookingIds: [],
        })),
        purgeExpiredBookingRequests: vi.fn(async () => ({
          declinedPurged: 1,
          neverVerifiedPurged: 2,
        })),
        sendQuoteExpiryReminders: vi.fn(async () => ({
          remindedCount: 1,
          failedCount: 0,
        })),
      },
    });

    expect(result.confirmPending?.confirmedBookingIds).toEqual(["booking-1"]);
    expect(result.preArrivalReminders?.sentBookingIds).toEqual(["booking-1"]);
    expect(result.bookingRequestPurge).toEqual({
      declinedPurged: 1,
      neverVerifiedPurged: 2,
    });
    expect(result.quoteExpiryReminders).toEqual({
      remindedCount: 1,
      failedCount: 0,
    });
    expect(recordCronRun).toHaveBeenCalledTimes(4);
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "confirm-pending",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "pre-arrival-reminders",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "purge-booking-requests",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "quote-expiry-reminders",
        status: "SUCCESS",
      })
    );
  });

  it("continues through independent jobs and reports failures after recording each outcome", async () => {
    const recordCronRun = vi.fn();
    const sendPreArrivalReminders = vi.fn(async () => ({
      reminderDays: 3,
      windowStart: "2026-06-28",
      windowEndExclusive: "2026-07-02",
      sentBookingIds: [],
      skippedBookingIds: [],
      failedBookingIds: [],
    }));
    const purgeExpiredBookingRequests = vi.fn(async () => ({
      declinedPurged: 0,
      neverVerifiedPurged: 0,
    }));
    const sendQuoteExpiryReminders = vi.fn(async () => ({
      remindedCount: 0,
      failedCount: 0,
    }));

    await expect(
      runGeneralCronCycle({
        recordCronRun,
        log: { error: vi.fn(), info: vi.fn() },
        tasks: {
          confirmPendingBookings: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
          sendPreArrivalReminders,
          purgeExpiredBookingRequests,
          sendQuoteExpiryReminders,
        },
      })
    ).rejects.toMatchObject<Partial<GeneralCronCycleError>>({
      failures: [
        { jobName: "confirm-pending", message: "database unavailable" },
      ],
    });

    expect(sendPreArrivalReminders).toHaveBeenCalled();
    expect(purgeExpiredBookingRequests).toHaveBeenCalled();
    expect(sendQuoteExpiryReminders).toHaveBeenCalled();
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "confirm-pending",
        status: "FAILURE",
        error: "database unavailable",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "quote-expiry-reminders",
        status: "SUCCESS",
      })
    );
  });
});
