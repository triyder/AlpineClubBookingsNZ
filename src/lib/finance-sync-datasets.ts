import type { FinanceSyncDatasetDefinition } from "@/lib/finance-sync-service";
import {
  FINANCE_SYNC_XERO_ACCOUNTS_RECEIVABLE_INVOICES_DATASET_KEY,
  FINANCE_SYNC_XERO_ACCOUNTS_PAYABLE_INVOICES_DATASET_KEY,
  FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_AGED_PAYABLES_DATASET_KEY,
  FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
  FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
  FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
  FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
  syncFinanceAccountsReceivableInvoicesSnapshot,
  syncFinanceAccountsPayableInvoicesSnapshot,
  syncFinanceAgedReceivablesSnapshot,
  syncFinanceAgedPayablesSnapshot,
  syncFinanceBalanceSheetSnapshot,
  syncFinanceBankBalancesSnapshot,
  syncFinanceChartOfAccountsSnapshot,
  syncFinanceProfitAndLossMonthlySnapshot,
} from "@/lib/finance-sync-xero-datasets";

const financeSyncDatasets: FinanceSyncDatasetDefinition[] = [
  {
    key: FINANCE_SYNC_XERO_PROFIT_AND_LOSS_MONTHLY_DATASET_KEY,
    description: "Xero monthly profit and loss report snapshot",
    sync: syncFinanceProfitAndLossMonthlySnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_BALANCE_SHEET_DATASET_KEY,
    description: "Xero balance sheet report snapshot",
    sync: syncFinanceBalanceSheetSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_BANK_BALANCES_DATASET_KEY,
    description: "Xero bank summary report snapshot",
    sync: syncFinanceBankBalancesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_AGED_RECEIVABLES_DATASET_KEY,
    description: "Xero aged receivables snapshot from open receivable invoices",
    sync: syncFinanceAgedReceivablesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_ACCOUNTS_RECEIVABLE_INVOICES_DATASET_KEY,
    description:
      "Xero accounts receivable invoice snapshot from open receivable invoices",
    sync: syncFinanceAccountsReceivableInvoicesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_AGED_PAYABLES_DATASET_KEY,
    description: "Xero aged payables snapshot from open payable invoices",
    sync: syncFinanceAgedPayablesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_ACCOUNTS_PAYABLE_INVOICES_DATASET_KEY,
    description: "Xero accounts payable invoice snapshot from open payable invoices",
    sync: syncFinanceAccountsPayableInvoicesSnapshot,
  },
  {
    key: FINANCE_SYNC_XERO_CHART_OF_ACCOUNTS_DATASET_KEY,
    description:
      "Xero chart of accounts snapshot (AccountID-to-GL-code map for reconciliation)",
    sync: syncFinanceChartOfAccountsSnapshot,
  },
];

export function getFinanceSyncDatasets(): FinanceSyncDatasetDefinition[] {
  return financeSyncDatasets.slice();
}
