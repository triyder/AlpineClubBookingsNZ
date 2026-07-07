import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListMonthlyFacts, mockListFinanceReportCategories } = vi.hoisted(
  () => ({
    mockListMonthlyFacts: vi.fn(),
    mockListFinanceReportCategories: vi.fn(),
  })
);

vi.mock("@/lib/finance-monthly-fact-store", () => ({
  listMonthlyFacts: mockListMonthlyFacts,
}));

vi.mock("@/lib/finance-report-mappings", () => ({
  UNMAPPED_FINANCE_CATEGORY_ID: "unmapped",
  listFinanceReportCategories: mockListFinanceReportCategories,
}));

import {
  buildFinanceFinancialYearsPanelItems,
  buildFinanceRatioMatrix,
} from "@/lib/finance-ratio-insights";
import {
  financeFinancialYearBuckets,
  last12MonthWindow,
  ratioForWindow,
  sumRatioSeries,
} from "@/lib/finance-ratio-shared";

function fact(seed: {
  month: string;
  accountCode: string;
  accountClass: "REVENUE" | "EXPENSE";
  amountCents: number;
  isProvisional?: boolean;
}) {
  return {
    statementKind: "PROFIT_AND_LOSS",
    month: seed.month,
    accountCode: seed.accountCode,
    accountId: `acc-${seed.accountCode}`,
    accountName: seed.accountCode,
    accountType: seed.accountClass === "REVENUE" ? "SALES" : "EXPENSE",
    accountClass: seed.accountClass,
    amountCents: seed.amountCents,
    currency: "NZD",
    isProvisional: seed.isProvisional ?? false,
    sourceReport: "getReportProfitAndLoss",
    syncedAt: new Date("2026-07-06T10:15:00.000Z"),
  };
}

describe("financeFinancialYearBuckets", () => {
  it("builds this-FY-to-date plus the two prior full years for a March year-end", () => {
    const buckets = financeFinancialYearBuckets({
      currentMonth: "2026-07",
      financialYearEndMonth: 3,
    });

    expect(buckets).toEqual([
      {
        label: "FY2027 (YTD)",
        fromMonth: "2026-04",
        toMonth: "2026-07",
        isYearToDate: true,
      },
      {
        label: "FY2026",
        fromMonth: "2025-04",
        toMonth: "2026-03",
        isYearToDate: false,
      },
      {
        label: "FY2025",
        fromMonth: "2024-04",
        toMonth: "2025-03",
        isYearToDate: false,
      },
    ]);
  });
});

describe("last12MonthWindow", () => {
  it("spans exactly 12 calendar months even when stored history has gaps", () => {
    // 16 stored data months over a 30-month calendar span. The old
    // months[length - 12] logic anchored on 2024-08 (23 calendar months);
    // calendar arithmetic keeps the window a true year.
    const months = [
      "2024-01", "2024-02", "2024-04", "2024-06", "2024-08", "2024-10",
      "2024-12", "2025-02", "2025-04", "2025-06", "2025-08", "2025-10",
      "2025-12", "2026-02", "2026-04", "2026-06",
    ];

    expect(last12MonthWindow({ months, currentMonth: "2026-07" })).toEqual({
      fromMonth: "2025-07",
      toMonth: "2026-06",
    });
  });

  it("falls back to the current month when no data is stored", () => {
    expect(last12MonthWindow({ months: [], currentMonth: "2026-07" })).toEqual({
      fromMonth: "2025-08",
      toMonth: "2026-07",
    });
  });
});

describe("ratio helpers", () => {
  const matrix = { months: ["2026-04", "2026-05", "2026-06"] };
  const catering = { valuesCents: [1_000, 2_000, 0] };
  const hutFees = { valuesCents: [10_000, 20_000, 0] };

  it("sums a series over an inclusive window", () => {
    expect(
      sumRatioSeries(matrix, catering, { fromMonth: "2026-04", toMonth: "2026-05" })
    ).toBe(3_000);
  });

  it("returns null instead of dividing by zero", () => {
    expect(
      ratioForWindow(matrix, catering, hutFees, {
        fromMonth: "2026-04",
        toMonth: "2026-05",
      })
    ).toBeCloseTo(0.1);
    expect(
      ratioForWindow(matrix, catering, hutFees, {
        fromMonth: "2026-06",
        toMonth: "2026-06",
      })
    ).toBeNull();
  });
});

describe("buildFinanceRatioMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFinanceReportCategories.mockResolvedValue([
      {
        id: "cat-hut",
        kind: "REVENUE",
        name: "Hut Fees",
        subtype: null,
        sortOrder: 10,
        archived: false,
        mappings: [{ accountCode: "200" }],
      },
      {
        id: "cat-catering",
        kind: "EXPENSE",
        name: "Catering",
        subtype: null,
        sortOrder: 10,
        archived: false,
        mappings: [{ accountCode: "310" }],
      },
    ]);
    mockListMonthlyFacts.mockResolvedValue([
      fact({ month: "2026-05", accountCode: "200", accountClass: "REVENUE", amountCents: 100_000 }),
      fact({ month: "2026-06", accountCode: "200", accountClass: "REVENUE", amountCents: 80_000 }),
      fact({ month: "2026-06", accountCode: "260", accountClass: "REVENUE", amountCents: 5_000 }),
      fact({ month: "2026-06", accountCode: "310", accountClass: "EXPENSE", amountCents: 12_000 }),
      fact({ month: "2026-07", accountCode: "200", accountClass: "REVENUE", amountCents: 20_000, isProvisional: true }),
    ]);
  });

  it("builds category and total series aligned to the stored months", async () => {
    const matrix = await buildFinanceRatioMatrix({
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    });

    expect(matrix.months).toEqual(["2026-05", "2026-06", "2026-07"]);
    expect(matrix.provisionalMonths).toEqual(["2026-07"]);

    const byId = new Map(matrix.series.map((series) => [series.id, series]));
    expect(byId.get("cat-hut")?.valuesCents).toEqual([100_000, 80_000, 20_000]);
    expect(byId.get("cat-catering")?.valuesCents).toEqual([0, 12_000, 0]);
    expect(byId.get("unmapped-revenue")?.valuesCents).toEqual([0, 5_000, 0]);
    expect(byId.get("total-income")?.valuesCents).toEqual([
      100_000, 85_000, 20_000,
    ]);
    expect(byId.get("total-expenses")?.valuesCents).toEqual([0, 12_000, 0]);
  });

  it("answers catering as a share of hut fees for a window", async () => {
    const matrix = await buildFinanceRatioMatrix({
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    });
    const byId = new Map(matrix.series.map((series) => [series.id, series]));

    expect(
      ratioForWindow(matrix, byId.get("cat-catering")!, byId.get("cat-hut")!, {
        fromMonth: "2026-06",
        toMonth: "2026-06",
      })
    ).toBeCloseTo(0.15);
  });

  it("builds the financial-years panel with totals emphasised first", async () => {
    const matrix = await buildFinanceRatioMatrix({
      financialYearEndMonth: 3,
      currentMonth: "2026-07",
    });

    const items = buildFinanceFinancialYearsPanelItems({
      matrix,
      kind: "REVENUE",
      formatCents: (cents) => `$${Math.round(cents / 100)}`,
    });

    expect(items[0]).toMatchObject({
      label: "Total income",
      value: "$2050", // FY2027 YTD: May + Jun + Jul revenue
      emphasis: true,
    });
    expect(items.some((item) => item.label === "Hut Fees")).toBe(true);
    expect(items[0].detail).toContain("FY2026");
    expect(items[0].detail).toContain("FY2025");
  });
});
