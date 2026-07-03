import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn(),
}));

vi.mock("@/lib/cron-job-run", () => ({
  recordCronJobRunSafe: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn(),
  refreshAllMembershipStatuses: vi.fn(),
}));

vi.mock("@/lib/xero-feature-flags", () => ({
  isXeroDailyMembershipRefreshEnabled: vi.fn(),
}));

vi.mock("@/lib/xero-hardening", () => ({
  backfillHistoricalXeroObjectLinks: vi.fn(),
  cleanupStaleCanonicalXeroObjectLinks: vi.fn(),
  sendXeroReconciliationReport: vi.fn(),
}));

vi.mock("@/lib/xero-inbound-reconciliation", () => ({
  runXeroInboundReconciliationCycle: vi.fn(),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  processQueuedXeroOutboxOperations: vi.fn(),
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  processQueuedXeroOperationRetries: vi.fn(),
}));

import {
  runXeroCronTaskList,
  runXeroCronTasks,
} from "@/lib/xero-cron-runner";

describe("xero cron runner", () => {
  it("records outbox and replay as separate jobs in the scheduled queue cycle", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      tasks: {
        processQueuedXeroOutboxOperations: vi.fn(async () => ({
          found: 2,
          processed: 2,
          succeeded: 2,
          failed: 0,
          skipped: 0,
        })),
        processQueuedXeroOperationRetries: vi.fn(async () => ({
          found: 1,
          processed: 1,
          succeeded: 1,
          failed: 0,
          skipped: 0,
        })),
      },
    });

    expect(result.task).toBe("xero-queue");
    expect(result.queuedOutboxOperations).toEqual({
      found: 2,
      processed: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });
    expect(result.queuedRetries).toEqual({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-operation-replay",
        status: "SUCCESS",
      })
    );
  });

  it("records skipped task rows when the Xero module is disabled at run time", async () => {
    const recordCronRun = vi.fn();
    const isConnected = vi.fn(async () => true);

    const result = await runXeroCronTaskList(["outbox", "retries"], {
      taskLabel: "xero-queue",
      recordCronRun,
      isModuleEnabled: vi.fn(async () => false),
      isConnected,
    });

    expect(isConnected).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      message: "Xero cron tasks skipped",
      task: "xero-queue",
      connected: false,
      skipped: true,
      reason: "Operational Xero effective module state is disabled",
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-outbox",
        status: "SKIPPED",
      })
    );
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-operation-replay",
        status: "SKIPPED",
      })
    );
  });

  it("records the daily stale link cleanup job independently from backfill", async () => {
    const recordCronRun = vi.fn();

    const result = await runXeroCronTasks("link-cleanup", {
      recordCronRun,
      isModuleEnabled: vi.fn(async () => true),
      isConnected: vi.fn(async () => false),
      tasks: {
        cleanupStaleCanonicalXeroObjectLinks: vi.fn(async () => ({
          scannedActiveLinks: 3,
          deactivatedLinks: 1,
        })) as never,
      },
    });

    expect(result.linkCleanup).toEqual({
      scannedActiveLinks: 3,
      deactivatedLinks: 1,
    });
    expect(recordCronRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-cleanup",
        status: "SUCCESS",
      })
    );
    expect(recordCronRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: "xero-link-backfill",
      })
    );
  });
});
