import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceSnapshotType } from "@prisma/client";

const {
  mockBuildFinanceMonthlyPnlSummary,
  mockBuildFinanceMonthlyBalanceSeries,
  mockBuildFinanceRatioMatrix,
  mockBuildFinanceFinancialYearsPanelItems,
  mockBuildFinanceRevenueReconciliation,
  mockBuildFinanceSyncHealth,
  mockGetFinanceBookingMetrics,
  mockGetFinanceSyncDiagnosticsStatus,
  mockListFinanceSnapshots,
  mockParseCashSnapshot,
  mockRefreshFinancialYearConfig,
  mockSeasonFindMany,
} = vi.hoisted(() => ({
  mockBuildFinanceMonthlyPnlSummary: vi.fn(),
  mockBuildFinanceMonthlyBalanceSeries: vi.fn(),
  mockBuildFinanceRatioMatrix: vi.fn(),
  mockBuildFinanceFinancialYearsPanelItems: vi.fn(),
  mockBuildFinanceRevenueReconciliation: vi.fn(),
  mockBuildFinanceSyncHealth: vi.fn(),
  mockGetFinanceBookingMetrics: vi.fn(),
  mockGetFinanceSyncDiagnosticsStatus: vi.fn(),
  mockListFinanceSnapshots: vi.fn(),
  mockParseCashSnapshot: vi.fn(),
  mockRefreshFinancialYearConfig: vi.fn(),
  mockSeasonFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    season: {
      findMany: mockSeasonFindMany,
    },
  },
}));

vi.mock("@/lib/finance-sync-diagnostics", () => ({
  getFinanceSyncDiagnosticsStatus: mockGetFinanceSyncDiagnosticsStatus,
}));

vi.mock("@/lib/finance-sync-health", () => ({
  buildFinanceSyncHealth: mockBuildFinanceSyncHealth,
}));

vi.mock("@/lib/finance-booking-metrics", () => ({
  getFinanceBookingMetrics: mockGetFinanceBookingMetrics,
}));

vi.mock("@/lib/finance-monthly-pnl", () => ({
  buildFinanceMonthlyPnlSummary: mockBuildFinanceMonthlyPnlSummary,
}));

vi.mock("@/lib/finance-monthly-balance", () => ({
  buildFinanceMonthlyBalanceSeries: mockBuildFinanceMonthlyBalanceSeries,
}));

vi.mock("@/lib/finance-ratio-insights", () => ({
  buildFinanceRatioMatrix: mockBuildFinanceRatioMatrix,
  buildFinanceFinancialYearsPanelItems: mockBuildFinanceFinancialYearsPanelItems,
}));

vi.mock("@/lib/financial-year-server", () => ({
  refreshFinancialYearConfig: mockRefreshFinancialYearConfig,
}));

vi.mock("@/lib/finance-revenue-reconciliation", () => ({
  buildFinanceRevenueReconciliation: mockBuildFinanceRevenueReconciliation,
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

vi.mock("@/lib/finance-cash-snapshot", () => ({
  parseCashSnapshot: mockParseCashSnapshot,
}));

import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import type { FinanceDashboardView } from "@/lib/finance-dashboard-ranges";

function financeManager() {
  return {
    id: "finance-manager-1",
    email: "manager@example.com",
    firstName: "Fin",
    lastName: "Manager",
    role: "USER" as const,
    financeAccessLevel: "NONE" as const,
    accessRoles: [{ role: "FINANCE_ADMIN" as const }],
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
  };
}

function financeViewer() {
  return {
    id: "finance-viewer-1",
    email: "viewer@example.com",
    firstName: "Fin",
    lastName: "Viewer",
    role: "USER" as const,
    financeAccessLevel: "MANAGER" as const,
    accessRoles: [{ role: "FINANCE_USER" as const }],
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
  };
}

function bookingMetrics() {
  const bucket = {
    bookingCount: 2,
    bookingNights: 3,
    guestNights: 6,
    bookedRevenueCents: 24_000,
    occupancy: {
      occupiedBedNights: 6,
      capacityBedNights: 60,
      occupancyRate: 0.1,
    },
  };
  return {
    generatedAt: "2026-06-28T00:00:00.000Z",
    bookingCount: 2,
    paymentSummary: {
      bookingCount: 2,
      bookingsWithPayment: 2,
      bookingsWithoutPayment: 0,
      paymentStatusBreakdown: {
        PENDING: 0,
        PROCESSING: 0,
        SUCCEEDED: 2,
        FAILED: 0,
        REFUNDED: 0,
        PARTIALLY_REFUNDED: 0,
        NONE: 0,
      },
      additionalPaymentStatusBreakdown: {
        PENDING: 0,
        SUCCEEDED: 0,
        FAILED: 0,
        NONE: 2,
      },
      capturedPrimaryCents: 24_000,
      capturedAdditionalCents: 0,
      refundedCents: 0,
      netCollectedCents: 24_000,
      creditAppliedCents: 0,
      changeFeeCents: 0,
    },
    realized: {
      window: {
        from: "2026-05-01",
        to: "2026-05-31",
        cutoffDate: "2026-05-31",
        effectiveFrom: "2026-05-01",
        effectiveTo: "2026-05-31",
        dayCount: 31,
      },
      totals: {
        ...bucket,
        averageNightlyRevenueCents: 8_000,
      },
      statusBreakdown: {
        CONFIRMED: bucket,
        PAID: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
        COMPLETED: { ...bucket, bookingCount: 0, guestNights: 0, bookedRevenueCents: 0 },
      },
      byDate: [
        {
          date: "2026-05-01",
          bookingCount: 1,
          guestNights: 2,
          occupiedBeds: 2,
          availableBeds: 30,
          occupancyRate: 0.0667,
          bookedRevenueCents: 8_000,
        },
      ],
    },
    forward: {
      window: {
        from: "2026-07-01",
        to: "2026-07-31",
        asOfDate: "2026-05-31",
        effectiveFrom: "2026-07-01",
        effectiveTo: "2026-07-31",
        dayCount: 31,
      },
      totals: {
        committed: {
          ...bucket,
          statusBreakdown: { PAID: bucket },
        },
        atRisk: {
          ...bucket,
          guestNights: 3,
          statusBreakdown: {
            PENDING: { ...bucket, guestNights: 3 },
            CONFIRMED: { ...bucket, bookingCount: 0, guestNights: 0 },
          },
        },
        totalPipeline: { ...bucket, guestNights: 9 },
      },
      byDate: [
        {
          date: "2026-07-01",
          committed: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 2,
            occupiedBeds: 2,
            availableBeds: 30,
            occupancyRate: 0.0667,
            bookedRevenueCents: 8_000,
          },
          atRisk: {
            date: "2026-07-01",
            bookingCount: 1,
            guestNights: 1,
            occupiedBeds: 1,
            availableBeds: 30,
            occupancyRate: 0.0333,
            bookedRevenueCents: 4_000,
          },
          totalPipeline: {
            date: "2026-07-01",
            bookingCount: 2,
            guestNights: 3,
            occupiedBeds: 3,
            availableBeds: 30,
            occupancyRate: 0.1,
            bookedRevenueCents: 12_000,
          },
        },
      ],
    },
  };
}

function mappedSummary(kind: "REVENUE" | "EXPENSE") {
  return {
    kind,
    amountCents: kind === "REVENUE" ? 100_000 : 40_000,
    comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
    deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
    formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
    formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
    formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
    groups: [
      {
        id: "group-1",
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        subtype: kind === "REVENUE" ? "Operating" : "Overheads",
        kind,
        sortOrder: 10,
        amountCents: kind === "REVENUE" ? 100_000 : 40_000,
        comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
        deltaCents: kind === "REVENUE" ? 20_000 : 5_000,
        formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
        formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
        formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
        lineCount: 1,
        lines: [
          {
            key: "line-1",
            sectionLabel: kind === "REVENUE" ? "Income" : "Expenses",
            lineLabel: kind === "REVENUE" ? "Hut Fees" : "Insurance",
            accountCode: kind === "REVENUE" ? "200" : null,
            amountCents: kind === "REVENUE" ? 100_000 : 40_000,
            comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
            formattedAmount: kind === "REVENUE" ? "$1,000" : "$400",
            formattedComparisonAmount: kind === "REVENUE" ? "$800" : "$350",
            formattedDelta: kind === "REVENUE" ? "+$200" : "+$50",
            periodsPresent: 1,
          },
        ],
      },
    ],
    mix: [
      {
        name: kind === "REVENUE" ? "Hut Fees" : "Insurance",
        valueCents: kind === "REVENUE" ? 100_000 : 40_000,
      },
    ],
    trend: [
      {
        monthKey: "2026-05",
        label: "May 2026",
        amountCents: kind === "REVENUE" ? 100_000 : 40_000,
        comparisonAmountCents: kind === "REVENUE" ? 80_000 : 35_000,
        isProvisional: false,
      },
    ],
    availableExpenseLines:
      kind === "EXPENSE"
        ? [{ value: "INSURANCE", label: "Insurance", categoryId: "group-1" }]
        : [],
    warnings: [],
    monthsWithData: 1,
    includesProvisionalMonth: false,
  };
}

function balanceSeries() {
  const point = {
    monthKey: "2026-05",
    label: "May 2026",
    assetsCents: 500_000,
    liabilitiesCents: 120_000,
    equityCents: 380_000,
    netAssetsCents: 380_000,
    currentAssetsCents: 200_000,
    currentLiabilitiesCents: 50_000,
    workingCapitalCents: 150_000,
    bankCents: 150_000,
    hasData: true,
    isProvisional: false,
  };
  return {
    points: [point],
    latest: point,
    latestBankAccounts: [
      { label: "Operating", balanceCents: 100_000 },
      { label: "Savings", balanceCents: 50_000 },
    ],
    monthsWithData: 1,
  };
}

describe("finance dashboard page model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeasonFindMany.mockResolvedValue([]);
    mockGetFinanceSyncDiagnosticsStatus.mockResolvedValue({
      latestRun: {
        status: "SUCCEEDED",
        startedAt: "2026-06-28T00:00:00.000Z",
        completedAt: "2026-06-28T00:02:00.000Z",
        snapshotCount: 8,
        totalRowCount: 120,
      },
      cron: { schedule: "0 5 * * *", timezone: "Pacific/Auckland" },
    });
    mockGetFinanceBookingMetrics.mockResolvedValue(bookingMetrics());
    mockRefreshFinancialYearConfig.mockResolvedValue(3);
    mockBuildFinanceMonthlyPnlSummary.mockImplementation(async (input: { kind: "REVENUE" | "EXPENSE" }) =>
      mappedSummary(input.kind)
    );
    mockBuildFinanceMonthlyBalanceSeries.mockResolvedValue(balanceSeries());
    mockBuildFinanceRatioMatrix.mockResolvedValue({
      months: ["2026-05", "2026-06"],
      provisionalMonths: [],
      series: [
        {
          id: "total-income",
          name: "Total income",
          kind: "REVENUE",
          isTotal: true,
          valuesCents: [100_000, 80_000],
        },
        {
          id: "cat-hut",
          name: "Hut Fees",
          kind: "REVENUE",
          isTotal: false,
          valuesCents: [100_000, 80_000],
        },
      ],
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    });
    mockBuildFinanceFinancialYearsPanelItems.mockReturnValue([
      {
        label: "Total income",
        value: "$1,800",
        detail: "FY2026 $0 · FY2025 $0",
        emphasis: true,
      },
    ]);
    mockBuildFinanceRevenueReconciliation.mockResolvedValue({
      overallStatus: "TIES",
      periods: [
        {
          periodLabel: "May 2026",
          varianceCents: 0,
          xeroHutFeesIncomeCents: 100_000,
          bookingHutFeesCents: 100_000,
        },
      ],
    });
    mockBuildFinanceSyncHealth.mockResolvedValue({
      overallTone: "amber",
      overallLabel: "Needs attention",
      warnings: ["Pending operations: 2."],
      sections: [
        {
          id: "daily-sync",
          title: "Daily Xero sync",
          description: "The scheduled pull.",
          tone: "green",
          signals: [
            {
              id: "latest-sync-run",
              label: "Latest sync run",
              value: "Succeeded 2h ago",
              tone: "green",
              href: "/admin/xero",
              linkLabel: "Open Xero admin",
            },
          ],
        },
        {
          id: "xero-operations",
          title: "Xero operations",
          description: "Outbound writes.",
          tone: "amber",
          signals: [
            {
              id: "pending-operations",
              label: "Pending operations",
              value: "2",
              detail: "Queued writes.",
              tone: "amber",
              href: "/admin/xero",
            },
          ],
        },
      ],
    });
    mockListFinanceSnapshots.mockResolvedValue([{ id: "snapshot-1" }]);
    mockParseCashSnapshot.mockReturnValue({
      totalBalanceCents: 150_000,
      totalBalance: "$1500.00",
      accountCount: 2,
      snapshotLabel: "31 May 2026",
      sourceUpdatedAtLabel: "31 May 2026, 12:00 pm",
      accounts: [
        { label: "Operating", balanceCents: 100_000 },
        { label: "Savings", balanceCents: 50_000 },
      ],
    });
  });

  it.each<FinanceDashboardView>([
    "bookings",
    "revenue",
    "costs",
    "ratios",
    "pricing-sensitivity",
    "working-capital",
    "cash",
    "balance-sheet",
    "sync-health",
  ])("builds the %s dashboard from stored/modelled data", async (view) => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view },
    });

    expect(model.selection.view).toBe(view);
    if (view === "ratios") {
      expect(model.ratios?.matrix.months.length).toBeGreaterThan(0);
    } else {
      expect(model.cards.length).toBeGreaterThan(0);
      expect(model.ratios).toBeNull();
    }
    expect(model.exportSections[0].title).toBe("Dashboard selection");
    expect(model.sourceNotes.length).toBeGreaterThan(0);
  });

  it("maps sync-health sections onto status panels with tones, links, and warnings", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "sync-health" },
    });

    expect(model.cards[0]).toMatchObject({
      title: "Sync confidence",
      value: "Needs attention",
    });

    const opsPanel = model.statusPanels.find(
      (panel) => panel.title === "Xero operations"
    );
    expect(opsPanel).toMatchObject({
      badgeLabel: "Attention",
      badgeTone: "warning",
    });
    expect(opsPanel?.items[0]).toMatchObject({
      label: "Pending operations",
      value: "2",
      emphasis: true,
      href: "/admin/xero",
    });

    const syncPanel = model.statusPanels.find(
      (panel) => panel.title === "Daily Xero sync"
    );
    expect(syncPanel).toMatchObject({ badgeLabel: "OK", badgeTone: "success" });
    expect(syncPanel?.items[0]).toMatchObject({ emphasis: false });

    expect(model.warnings).toContain("Pending operations: 2.");
    expect(
      model.exportSections.some((section) => section.title === "Sync health signals")
    ).toBe(true);
  });

  it("appends the financial-years committee panel to revenue and costs views", async () => {
    const revenue = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const costs = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "costs" },
    });

    for (const model of [revenue, costs]) {
      const panel = model.statusPanels.find(
        (statusPanel) => statusPanel.title === "Financial years"
      );
      expect(panel).toBeDefined();
      expect(panel?.items[0]).toMatchObject({ label: "Total income" });
    }
  });

  it("passes the ratio explorer selection through from query params", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: {
        view: "ratios",
        ratioNumerator: "cat-catering",
        ratioDenominator: "cat-hut",
      },
    });

    expect(model.ratios).toMatchObject({
      initialNumeratorId: "cat-catering",
      initialDenominatorId: "cat-hut",
    });
  });

  it("groups mapped P&L categories under subtype sub-headings with sub-totals", async () => {
    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });

    const panel = model.statusPanels.find(
      (statusPanel) => statusPanel.title === "Revenue groups"
    );
    expect(panel).toBeDefined();
    const subheading = panel?.items.find((item) => item.emphasis);
    expect(subheading).toMatchObject({ label: "Operating", value: "$1,000" });
    expect(panel?.items.some((item) => item.label === "Hut Fees")).toBe(true);
  });

  it("derives manager-only dashboard actions from access role rows", async () => {
    const managerModel = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "bookings" },
    });
    const viewerModel = await buildFinanceDashboardPageModel({
      member: financeViewer(),
      searchParams: { view: "bookings" },
    });

    expect(managerModel.isManager).toBe(true);
    expect(viewerModel.isManager).toBe(false);
  });

  it("surfaces missing stored monthly data as a compact warning", async () => {
    mockBuildFinanceMonthlyBalanceSeries.mockResolvedValue({
      points: [],
      latest: null,
      latestBankAccounts: [],
      monthsWithData: 0,
    });
    mockListFinanceSnapshots.mockImplementation(async (input?: { snapshotType?: FinanceSnapshotType }) => {
      if (input?.snapshotType === FinanceSnapshotType.BANK_BALANCES) {
        return [];
      }
      return [{ id: "snapshot-1" }];
    });

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "cash" },
    });

    expect(
      model.warnings.some((warning) =>
        warning.includes("No monthly Xero balance data is stored")
      )
    ).toBe(true);
  });

  it("overlays the comparison series on the revenue trend and omits it when compare is none", async () => {
    const withComparison = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const revenueTrend = withComparison.trends[0];
    expect(revenueTrend.series.map((series) => series.key)).toEqual([
      "amount",
      "comparison",
    ]);
    expect(revenueTrend.data[0]).toMatchObject({
      label: "May 2026",
      amount: 100_000,
      comparison: 80_000,
    });

    const withoutComparison = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue", compare: "none" },
    });
    expect(mockBuildFinanceMonthlyPnlSummary).toHaveBeenLastCalledWith(
      expect.objectContaining({ comparison: null })
    );
    expect(withoutComparison.selectionLabels.comparisonWindow).toBe("None");
  });

  it("renders a gap, not a $0 bar, for unaligned trailing comparison months", async () => {
    mockBuildFinanceMonthlyPnlSummary.mockImplementation(
      async (input: { kind: "REVENUE" | "EXPENSE" }) => ({
        ...mappedSummary(input.kind),
        trend: [
          {
            monthKey: "2026-05",
            label: "May 2026",
            amountCents: 100_000,
            comparisonAmountCents: 80_000,
            isProvisional: false,
          },
          {
            // A comparison window shorter than the primary leaves this month
            // unaligned (null), which must render as a gap rather than $0.
            monthKey: "2026-06",
            label: "Jun 2026",
            amountCents: 120_000,
            comparisonAmountCents: null,
            isProvisional: false,
          },
        ],
      })
    );

    const model = await buildFinanceDashboardPageModel({
      member: financeManager(),
      searchParams: { view: "revenue" },
    });
    const trend = model.trends[0];

    expect(trend.data[0]).toMatchObject({
      label: "May 2026",
      amount: 100_000,
      comparison: 80_000,
    });
    expect(trend.data[1]).toMatchObject({ label: "Jun 2026", amount: 120_000 });
    // The unaligned month omits the comparison key so the chart draws a gap.
    expect("comparison" in trend.data[1]).toBe(false);
  });
});
