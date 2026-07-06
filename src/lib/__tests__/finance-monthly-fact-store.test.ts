import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinanceMonthlyStatementKind, FinanceSnapshotType } from "@prisma/client";

const { mockDeleteMany, mockCreateMany, mockFindMany, mockTransaction } =
  vi.hoisted(() => ({
    mockDeleteMany: vi.fn(),
    mockCreateMany: vi.fn(),
    mockFindMany: vi.fn(),
    mockTransaction: vi.fn(),
  }));

const { mockListFinanceSnapshots } = vi.hoisted(() => ({
  mockListFinanceSnapshots: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    financeAccountMonthlyBalance: {
      deleteMany: mockDeleteMany,
      createMany: mockCreateMany,
      findMany: mockFindMany,
    },
    $transaction: mockTransaction,
  },
}));

vi.mock("@/lib/finance-sync-storage", () => ({
  DEFAULT_FINANCE_SNAPSHOT_SCOPE: "default",
  listFinanceSnapshots: mockListFinanceSnapshots,
}));

import {
  listMonthlyFacts,
  loadFinanceMonthlyChartContext,
  replaceMonthlyFacts,
} from "@/lib/finance-monthly-fact-store";
import type { FinanceMonthlyFactRowInput } from "@/lib/finance-monthly-facts";

function buildRow(
  overrides: Partial<FinanceMonthlyFactRowInput> = {}
): FinanceMonthlyFactRowInput {
  return {
    month: "2026-04",
    accountCode: "200",
    accountId: "acc-hut",
    accountName: "Hut Fees",
    accountType: "SALES",
    accountClass: "REVENUE",
    amountCents: 125000,
    isProvisional: false,
    ...overrides,
  };
}

describe("replaceMonthlyFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMany.mockReturnValue(Promise.resolve({ count: 3 }));
    mockCreateMany.mockReturnValue(Promise.resolve({ count: 2 }));
    mockTransaction.mockImplementation(async (operations: Promise<unknown>[]) =>
      Promise.all(operations)
    );
  });

  it("atomically replaces the pulled months", async () => {
    const syncedAt = new Date("2026-04-20T10:15:00.000Z");
    const result = await replaceMonthlyFacts({
      statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
      months: ["2026-03", "2026-04"],
      rows: [
        buildRow({ month: "2026-03", amountCents: 98050 }),
        buildRow({ month: "2026-04", isProvisional: true }),
      ],
      sourceReport: "getReportProfitAndLoss",
      syncRunId: "run-1",
      currency: "NZD",
      syncedAt,
    });

    expect(result).toEqual({ monthCount: 2, deletedCount: 3, createdCount: 2 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: {
        statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
        scope: "default",
        month: {
          in: [
            new Date("2026-03-01T00:00:00.000Z"),
            new Date("2026-04-01T00:00:00.000Z"),
          ],
        },
      },
    });
    expect(mockCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
          scope: "default",
          month: new Date("2026-03-01T00:00:00.000Z"),
          accountCode: "200",
          amountCents: 98050,
          isProvisional: false,
          currency: "NZD",
          sourceReport: "getReportProfitAndLoss",
          syncRunId: "run-1",
          syncedAt,
        }),
        expect.objectContaining({
          month: new Date("2026-04-01T00:00:00.000Z"),
          isProvisional: true,
        }),
      ],
    });
  });

  it("rejects rows outside the pulled window", async () => {
    await expect(
      replaceMonthlyFacts({
        statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
        months: ["2026-04"],
        rows: [buildRow({ month: "2026-03" })],
        sourceReport: "getReportProfitAndLoss",
      })
    ).rejects.toThrow(/outside the pulled window/);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      "empty months",
      { months: [], rows: [] },
      /at least one month/,
    ],
    [
      "invalid month key",
      { months: ["2026-4"], rows: [] },
      /YYYY-MM month key/,
    ],
    [
      "blank account code",
      { months: ["2026-04"], rows: [buildRow({ accountCode: "  " })] },
      /non-empty accountCode/,
    ],
    [
      "fractional cents",
      { months: ["2026-04"], rows: [buildRow({ amountCents: 10.5 })] },
      /non-integer amountCents/,
    ],
  ])("rejects %s", async (_label, partial, message) => {
    await expect(
      replaceMonthlyFacts({
        statementKind: FinanceMonthlyStatementKind.PROFIT_AND_LOSS,
        sourceReport: "getReportProfitAndLoss",
        ...partial,
      })
    ).rejects.toThrow(message);
  });
});

describe("listMonthlyFacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries the inclusive month range and maps months back to keys", async () => {
    mockFindMany.mockResolvedValue([
      {
        statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
        month: new Date("2026-03-01T00:00:00.000Z"),
        accountCode: "090",
        accountId: "acc-bank",
        accountName: "Cheque Account",
        accountType: "BANK",
        accountClass: "ASSET",
        amountCents: 1234500,
        currency: "NZD",
        isProvisional: false,
        sourceReport: "getReportBalanceSheet",
        syncedAt: new Date("2026-04-20T10:15:00.000Z"),
      },
    ]);

    const records = await listMonthlyFacts({
      statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
      fromMonth: "2026-01",
      toMonth: "2026-04",
    });

    expect(mockFindMany).toHaveBeenCalledWith({
      where: {
        statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
        scope: "default",
        month: {
          gte: new Date("2026-01-01T00:00:00.000Z"),
          lte: new Date("2026-04-01T00:00:00.000Z"),
        },
      },
      orderBy: [{ month: "asc" }, { accountCode: "asc" }],
    });
    expect(records).toEqual([
      expect.objectContaining({
        month: "2026-03",
        accountCode: "090",
        amountCents: 1234500,
      }),
    ]);
  });

  it("rejects reversed ranges", async () => {
    await expect(
      listMonthlyFacts({
        statementKind: FinanceMonthlyStatementKind.BALANCE_SHEET,
        fromMonth: "2026-05",
        toMonth: "2026-04",
      })
    ).rejects.toThrow(/fromMonth must not be after toMonth/);
  });
});

describe("loadFinanceMonthlyChartContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses the latest chart-of-accounts snapshot", async () => {
    mockListFinanceSnapshots.mockResolvedValue([
      {
        payload: {
          accounts: [
            {
              accountId: "acc-hut",
              code: "200",
              name: "Hut Fees",
              type: "SALES",
              class: "REVENUE",
            },
          ],
        },
      },
    ]);

    const chart = await loadFinanceMonthlyChartContext();

    expect(mockListFinanceSnapshots).toHaveBeenCalledWith({
      snapshotType: FinanceSnapshotType.CHART_OF_ACCOUNTS,
      scope: "default",
      limit: 1,
    });
    expect(chart.accountsById.get("acc-hut")?.code).toBe("200");
  });

  it("returns an empty context when no snapshot is stored", async () => {
    mockListFinanceSnapshots.mockResolvedValue([]);

    const chart = await loadFinanceMonthlyChartContext();

    expect(chart.accountsById.size).toBe(0);
  });
});
