import { describe, expect, it } from "vitest";
import {
  extractMonthlyFactsFromReport,
  isMonthKey,
  normalizeFactAccountCode,
  parseFinanceChartOfAccountsContext,
  parseReportColumnMonth,
  shiftMonthKey,
  type FinanceMonthlyChartContext,
} from "@/lib/finance-monthly-facts";

function buildChart(): FinanceMonthlyChartContext {
  return parseFinanceChartOfAccountsContext({
    accountCount: 2,
    accounts: [
      {
        accountId: "acc-hut",
        code: "200",
        name: "Hut Fees",
        type: "SALES",
        class: "REVENUE",
        status: "ACTIVE",
      },
      {
        accountId: "acc-cat",
        code: "310a",
        name: "Catering",
        type: "EXPENSE",
        class: "EXPENSE",
        status: "ACTIVE",
      },
    ],
  });
}

function accountCell(value: string, accountId: string) {
  return { value, attributes: [{ id: "account", value: accountId }] };
}

function plainCell(value: string) {
  return { value, attributes: [] };
}

interface TestReportRow {
  rowType: string;
  title: string | null;
  cells: Array<{ value: string; attributes: Array<{ id: string; value: string }> }>;
  rows: TestReportRow[];
}

/**
 * A stored multi-period P&L payload: three monthly columns, newest first,
 * exactly as Xero returns them.
 */
function buildMultiPeriodPayload(extraIncomeRows: TestReportRow[] = []) {
  return {
    reportId: "pnl-1",
    reportName: "Profit and Loss",
    reportType: "ProfitLoss",
    reportTitle: "Profit and Loss",
    reportTitles: ["Profit and Loss"],
    reportDate: "2026-04-20",
    updatedDateUTC: null,
    fields: [],
    rows: [
      {
        rowType: "Header",
        title: null,
        cells: [
          plainCell(""),
          plainCell("30 Apr 26"),
          plainCell("31 Mar 26"),
          plainCell("28 Feb 26"),
        ],
        rows: [],
      },
      {
        rowType: "Section",
        title: "Income",
        cells: [],
        rows: [
          {
            rowType: "Row",
            title: null,
            cells: [
              accountCell("Hut Fees", "acc-hut"),
              plainCell("1,250.00"),
              plainCell("980.50"),
              plainCell("0.00"),
            ],
            rows: [],
          },
          {
            rowType: "SummaryRow",
            title: null,
            cells: [
              plainCell("Total Income"),
              plainCell("1,250.00"),
              plainCell("980.50"),
              plainCell("0.00"),
            ],
            rows: [],
          },
          ...extraIncomeRows,
        ],
      },
      {
        rowType: "Section",
        title: "Less Operating Expenses",
        cells: [],
        rows: [
          {
            rowType: "Row",
            title: null,
            cells: [
              accountCell("Catering", "acc-cat"),
              plainCell("(45.00)"),
              plainCell("120.00"),
              plainCell(""),
            ],
            rows: [],
          },
          {
            rowType: "Row",
            title: null,
            cells: [
              plainCell("Mystery line"),
              plainCell("10.00"),
              plainCell("0.00"),
              plainCell("0.00"),
            ],
            rows: [],
          },
        ],
      },
    ],
  };
}

describe("parseReportColumnMonth", () => {
  it.each([
    ["30 Jun 26", "2026-06"],
    ["30 June 2026", "2026-06"],
    ["1 Feb 26", "2026-02"],
    ["Jun-26", "2026-06"],
    ["Jun 2026", "2026-06"],
    ["2026-06-30", "2026-06"],
    ["2026-06", "2026-06"],
  ])("parses %s", (value, expected) => {
    expect(parseReportColumnMonth(value)).toBe(expected);
  });

  it.each(["", "   ", "Account", "Total", "1,250.00", "13-26", "Foo-26", null])(
    "returns null for %s",
    (value) => {
      expect(parseReportColumnMonth(value)).toBeNull();
    }
  );
});

describe("shiftMonthKey", () => {
  it("shifts backwards across year boundaries", () => {
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-05", -12)).toBe("2025-05");
    expect(shiftMonthKey("2026-03", -25)).toBe("2024-02");
  });

  it("shifts forwards", () => {
    expect(shiftMonthKey("2025-12", 1)).toBe("2026-01");
    expect(shiftMonthKey("2026-04", 11)).toBe("2027-03");
  });

  it("rejects invalid keys", () => {
    expect(() => shiftMonthKey("2026-13", -1)).toThrow(/month key/);
    expect(() => shiftMonthKey("2026-4", -1)).toThrow(/month key/);
  });
});

describe("isMonthKey / normalizeFactAccountCode", () => {
  it("accepts YYYY-MM only", () => {
    expect(isMonthKey("2026-04")).toBe(true);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("2026-04-01")).toBe(false);
  });

  it("normalizes account codes to trimmed upper-case", () => {
    expect(normalizeFactAccountCode(" 310a ")).toBe("310A");
    expect(normalizeFactAccountCode("")).toBeNull();
    expect(normalizeFactAccountCode(null)).toBeNull();
  });
});

describe("parseFinanceChartOfAccountsContext", () => {
  it("indexes accounts by AccountID with normalized codes", () => {
    const chart = buildChart();

    expect(chart.accountsById.get("acc-cat")).toEqual({
      accountId: "acc-cat",
      code: "310A",
      name: "Catering",
      type: "EXPENSE",
      class: "EXPENSE",
    });
  });

  it("skips malformed payloads and entries without AccountIDs", () => {
    expect(parseFinanceChartOfAccountsContext(null).accountsById.size).toBe(0);
    expect(
      parseFinanceChartOfAccountsContext({
        accounts: [{ code: "200" }, "junk", null],
      }).accountsById.size
    ).toBe(0);
  });
});

describe("extractMonthlyFactsFromReport", () => {
  it("maps newest-first period columns onto months and accounts", () => {
    const result = extractMonthlyFactsFromReport({
      payload: buildMultiPeriodPayload(),
      chart: buildChart(),
      provisionalFromMonth: "2026-04",
    });

    expect(result.months).toEqual(["2026-02", "2026-03", "2026-04"]);
    expect(result.unresolvedRowLabels).toEqual(["Mystery line"]);
    expect(result.rows).toEqual([
      {
        month: "2026-02",
        accountCode: "200",
        accountId: "acc-hut",
        accountName: "Hut Fees",
        accountType: "SALES",
        accountClass: "REVENUE",
        amountCents: 0,
        isProvisional: false,
      },
      {
        month: "2026-03",
        accountCode: "200",
        accountId: "acc-hut",
        accountName: "Hut Fees",
        accountType: "SALES",
        accountClass: "REVENUE",
        amountCents: 98050,
        isProvisional: false,
      },
      {
        month: "2026-03",
        accountCode: "310A",
        accountId: "acc-cat",
        accountName: "Catering",
        accountType: "EXPENSE",
        accountClass: "EXPENSE",
        amountCents: 12000,
        isProvisional: false,
      },
      {
        month: "2026-04",
        accountCode: "200",
        accountId: "acc-hut",
        accountName: "Hut Fees",
        accountType: "SALES",
        accountClass: "REVENUE",
        amountCents: 125000,
        isProvisional: true,
      },
      {
        month: "2026-04",
        accountCode: "310A",
        accountId: "acc-cat",
        accountName: "Catering",
        accountType: "EXPENSE",
        accountClass: "EXPENSE",
        amountCents: -4500,
        isProvisional: true,
      },
    ]);
  });

  it("accumulates duplicate rows for the same account and month", () => {
    const payload = buildMultiPeriodPayload([
      {
        rowType: "Row",
        title: null,
        cells: [
          accountCell("Hut Fees (winter)", "acc-hut"),
          plainCell("100.00"),
          plainCell("0.00"),
          plainCell("0.00"),
        ],
        rows: [],
      },
    ]);

    const result = extractMonthlyFactsFromReport({
      payload,
      chart: buildChart(),
    });

    const april = result.rows.find(
      (row) => row.month === "2026-04" && row.accountCode === "200"
    );
    expect(april?.amountCents).toBe(125000 + 10000);
  });

  it("flags nothing provisional without a provisionalFromMonth", () => {
    const result = extractMonthlyFactsFromReport({
      payload: buildMultiPeriodPayload(),
      chart: buildChart(),
    });

    expect(result.rows.every((row) => !row.isProvisional)).toBe(true);
  });

  it("returns empty results for unreadable payloads", () => {
    expect(
      extractMonthlyFactsFromReport({ payload: null, chart: buildChart() })
    ).toEqual({ months: [], rows: [], unresolvedRowLabels: [] });
  });

  it("returns no months when the header has no parseable date columns", () => {
    const payload = buildMultiPeriodPayload();
    payload.rows[0].cells = [plainCell(""), plainCell("Account"), plainCell("Total")];

    const result = extractMonthlyFactsFromReport({
      payload,
      chart: buildChart(),
    });

    expect(result.months).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("treats accounts missing from the chart as unresolved when they carry amounts", () => {
    const chart = parseFinanceChartOfAccountsContext({
      accounts: [
        {
          accountId: "acc-hut",
          code: "200",
          name: "Hut Fees",
          type: "SALES",
          class: "REVENUE",
        },
      ],
    });

    const result = extractMonthlyFactsFromReport({
      payload: buildMultiPeriodPayload(),
      chart,
    });

    expect(result.unresolvedRowLabels).toEqual(["Catering", "Mystery line"]);
    expect(result.rows.every((row) => row.accountCode === "200")).toBe(true);
  });
});
