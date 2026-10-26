import type { XeroSyncOperation } from "@prisma/client";

/** Active correlation-key population of XeroSyncOperation_active_correlationKey_unique. */
export const XERO_ACTIVE_OPERATION_STATUSES = [
  "PENDING",
  "RUNNING",
  "WAITING_PAYMENT",
] as const satisfies readonly XeroSyncOperation["status"][];
