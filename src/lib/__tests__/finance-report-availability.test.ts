import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetFinanceSyncDiagnosticsStatus,
  mockIsXeroConnected,
} = vi.hoisted(() => ({
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockIsXeroConnected: vi.fn(),
}));

vi.mock("@/lib/finance-auth", () => ({
  hasFinanceManagerAccess: (input: string | { financeAccessLevel?: string }) =>
    (typeof input === "string" ? input : input.financeAccessLevel) === "MANAGER",
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/xero", () => ({
  isXeroConnected: mockIsXeroConnected,
}));

import {
  buildFinanceSnapshotLoadErrorMessage,
  buildFinanceSnapshotMissingMessage,
} from "@/lib/finance-report-availability";

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

function financeManager() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "ADMIN" as const,
    financeAccessLevel: "MANAGER" as const,
    active: true,
    forcePasswordChange: false,
    accessRoles: [],
    twoFactorEnabled: false,
  };
}

describe("finance report availability messaging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: null,
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });
    mockIsXeroConnected.mockResolvedValue(false);
  });

  it("tells managers to connect Xero from the admin page when not connected", async () => {
    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeManager(),
        reportTitle: "This revenue report",
        dataLabel: "monthly revenue snapshots",
      })
    ).resolves.toContain("admin Xero page");
  });

  it("tells viewers when the first finance sync has not run yet", async () => {
    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeViewer(),
        reportTitle: "This revenue report",
        dataLabel: "monthly revenue snapshots",
      })
    ).resolves.toContain("first finance sync");
  });

  it("reports sync failures as the reason data is missing", async () => {
    mockIsXeroConnected.mockResolvedValue(true);
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: {
        id: "run-1",
        workflow: "daily-finance-sync",
        trigger: "CRON",
        status: "FAILED",
        startedAt: "2026-04-21T00:00:00.000Z",
        completedAt: "2026-04-21T00:02:00.000Z",
        durationMs: 120000,
        xeroTenantId: "tenant-123",
        requestedByMemberId: null,
        snapshotCount: 0,
        totalRowCount: 0,
        datasetCount: 7,
        successfulDatasetCount: 0,
        failedDatasetCount: 7,
        datasets: [],
        errorSummary: "sync failed",
        failureDetails: [],
      },
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });

    await expect(
      buildFinanceSnapshotMissingMessage({
        member: financeManager(),
        reportTitle: "This cash report",
        dataLabel: "cash balance snapshots",
      })
    ).resolves.toContain("latest finance sync failed");
  });

  it("uses a generic storage-read message when synced data cannot be read", async () => {
    mockIsXeroConnected.mockResolvedValue(true);
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      workflow: "daily-finance-sync",
      latestRun: {
        id: "run-1",
        workflow: "daily-finance-sync",
        trigger: "CRON",
        status: "SUCCEEDED",
        startedAt: "2026-04-21T00:00:00.000Z",
        completedAt: "2026-04-21T00:02:00.000Z",
        durationMs: 120000,
        xeroTenantId: "tenant-123",
        requestedByMemberId: null,
        snapshotCount: 7,
        totalRowCount: 140,
        datasetCount: 7,
        successfulDatasetCount: 7,
        failedDatasetCount: 0,
        datasets: [],
        errorSummary: null,
        failureDetails: [],
      },
      cron: {
        jobName: "finance-daily-sync",
        schedule: "0 5 * * *",
        timezone: "Pacific/Auckland",
        latestRun: null,
      },
      recentFailures: {
        syncRuns: [],
        cronRuns: [],
      },
    });

    await expect(
      buildFinanceSnapshotLoadErrorMessage({
        member: financeViewer(),
        reportTitle: "This balance sheet report",
        dataLabel: "balance sheet snapshots",
      })
    ).resolves.toContain("could not be loaded right now");
  });
});
