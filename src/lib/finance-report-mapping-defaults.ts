export type FinanceReportCategoryKindValue = "REVENUE" | "EXPENSE";

export interface DefaultFinanceReportCategory {
  kind: FinanceReportCategoryKindValue;
  name: string;
  subtype: string | null;
  sortOrder: number;
}

export const DEFAULT_FINANCE_REPORT_CATEGORIES: readonly DefaultFinanceReportCategory[] = [
  { kind: "REVENUE", name: "Hut Fees", subtype: "Operating", sortOrder: 10 },
  { kind: "REVENUE", name: "Subscriptions", subtype: "Operating", sortOrder: 20 },
  { kind: "REVENUE", name: "Entrance Fees", subtype: "Operating", sortOrder: 30 },
  { kind: "REVENUE", name: "Other Revenue", subtype: "Other", sortOrder: 90 },
  { kind: "EXPENSE", name: "Accommodation Operations", subtype: "Operating", sortOrder: 10 },
  { kind: "EXPENSE", name: "Catering", subtype: "Operating", sortOrder: 20 },
  { kind: "EXPENSE", name: "Utilities", subtype: "Operating", sortOrder: 30 },
  { kind: "EXPENSE", name: "Maintenance", subtype: "Operating", sortOrder: 40 },
  { kind: "EXPENSE", name: "Insurance & Compliance", subtype: "Overheads", sortOrder: 50 },
  { kind: "EXPENSE", name: "Admin & Software", subtype: "Overheads", sortOrder: 60 },
  { kind: "EXPENSE", name: "Payment & Bank Fees", subtype: "Overheads", sortOrder: 70 },
  { kind: "EXPENSE", name: "Other Expenses", subtype: "Other", sortOrder: 90 },
] as const;
