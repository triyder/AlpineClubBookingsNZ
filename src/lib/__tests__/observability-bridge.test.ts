import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/nextjs";
import loggerDefault from "@/lib/logger";
import {
  reportCronError,
  reportWebhookError,
  resetObservabilityBridgeForTests,
} from "@/lib/observability-bridge";

describe("observability bridge (scoped pino -> Sentry)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetObservabilityBridgeForTests();
    delete process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS;
  });

  describe("positive: cron + webhook failures log AND page Sentry", () => {
    it("reportCronError with an Error logs at error and captures the exception with a scoped fingerprint", () => {
      const err = new Error("db unavailable");

      reportCronError({
        tag: "confirm-pending",
        err,
        message: "Pending confirmation cron error",
        context: { job: "confirm-pending" },
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "cron",
          job: "confirm-pending",
          err,
        }),
        "Pending confirmation cron error"
      );
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          level: "error",
          fingerprint: ["cron", "confirm-pending"],
          tags: { scope: "cron", operation: "confirm-pending" },
        })
      );
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("reportWebhookError with an Error logs at error and captures scoped to webhook", () => {
      const err = new Error("boom");

      reportWebhookError({
        tag: "stripe:payment_intent.succeeded",
        err,
        message: "Error processing webhook event",
        context: { eventType: "payment_intent.succeeded" },
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "webhook",
          eventType: "payment_intent.succeeded",
          err,
        }),
        "Error processing webhook event"
      );
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          fingerprint: ["webhook", "stripe:payment_intent.succeeded"],
          tags: { scope: "webhook", operation: "stripe:payment_intent.succeeded" },
        })
      );
    });

    it("uses captureMessage (not captureException) when there is no Error object", () => {
      reportCronError({
        tag: "credit-reconciliation:negative-credit-balances",
        message: "2 member(s) have negative credit balances",
        context: { alert: "CREDIT_BALANCE_DISCREPANCY", count: 2 },
      });

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        "2 member(s) have negative credit balances",
        expect.objectContaining({
          level: "error",
          fingerprint: ["cron", "credit-reconciliation:negative-credit-balances"],
          extra: expect.objectContaining({
            alert: "CREDIT_BALANCE_DISCREPANCY",
            count: 2,
          }),
        })
      );
    });

    it("logs and pages at fatal when level is fatal", () => {
      const err = new Error("fatal boom");

      reportWebhookError({
        tag: "ses-sns",
        err,
        message: "Error processing SES/SNS webhook",
        level: "fatal",
      });

      expect(mockLogger.fatal).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "webhook", err }),
        "Error processing SES/SNS webhook"
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(Sentry.captureException).toHaveBeenCalledWith(
        err,
        expect.objectContaining({ level: "fatal" })
      );
    });
  });

  describe("negative: ordinary route loggers stay log-only (scoped, not global)", () => {
    it("a plain logger.error does NOT reach Sentry", () => {
      // Ordinary route/request code logs through the pino singleton and never
      // imports the bridge, so logging alone must not emit a Sentry event.
      loggerDefault.error({ route: "/api/whatever" }, "route level failure");

      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    });

    it("the pino logger module installs no global Sentry transport (scoped-not-global by construction)", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const source = fs.readFileSync(
        path.resolve(process.cwd(), "src/lib/logger.ts"),
        "utf8"
      );

      expect(source).not.toContain("@sentry");
      expect(source).not.toContain("captureException");
      expect(source).not.toContain("captureMessage");
    });
  });

  describe("dedup: in-process cooldown + stable fingerprint", () => {
    it("suppresses repeat same-fingerprint captures within the cooldown, then re-sends after it", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
      process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS = "300000"; // 5 min

      const err1 = new Error("stuck provider #1");
      const err2 = new Error("stuck provider #2");

      reportCronError({
        tag: "xero-operation-replay",
        err: err1,
        message: "Error processing queued Xero work",
      });

      // 1 minute later, same fingerprint -> Sentry suppressed (still logged).
      vi.advanceTimersByTime(60_000);
      reportCronError({
        tag: "xero-operation-replay",
        err: err2,
        message: "Error processing queued Xero work",
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      // The log line is never suppressed — only the Sentry send is deduped.
      expect(mockLogger.error).toHaveBeenCalledTimes(2);

      // After the cooldown elapses, the next occurrence re-sends.
      vi.advanceTimersByTime(5 * 60_000);
      reportCronError({
        tag: "xero-operation-replay",
        err: err1,
        message: "Error processing queued Xero work",
      });

      expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    });

    it("does not cross-suppress different fingerprints (scope + tag)", () => {
      const err = new Error("boom");

      reportCronError({ tag: "confirm-pending", err, message: "A" });
      reportCronError({ tag: "pre-arrival-reminders", err, message: "B" });
      // Same tag but a different scope is a distinct fingerprint.
      reportWebhookError({ tag: "confirm-pending", err, message: "C" });

      expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    });

    it("falls back to the default cooldown when the env override is invalid", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-04T00:00:00Z"));
      process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS = "not-a-number";

      const err = new Error("boom");
      reportCronError({ tag: "backup", err, message: "Error running database backup" });
      // Well within the default 5-minute window.
      vi.advanceTimersByTime(60_000);
      reportCronError({ tag: "backup", err, message: "Error running database backup" });

      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });
});
