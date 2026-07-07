export type FinanceOpenInvoiceType = "ACCREC" | "ACCPAY";
export type FinanceAgedInvoiceBucketKey =
  | "current"
  | "days1To30"
  | "days31To60"
  | "days61To90"
  | "days91Plus";

export interface FinanceAgedInvoiceBucketTotals {
  current: number;
  days1To30: number;
  days31To60: number;
  days61To90: number;
  days91Plus: number;
  overdue: number;
  total: number;
}
