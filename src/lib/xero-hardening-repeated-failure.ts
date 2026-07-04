// Repeated Xero failure alerting: notifies admins when the same correlation key
// fails repeatedly inside the rolling window, deduplicated against recent
// alerts. Extracted verbatim from xero-hardening.ts (#1208 item 5). Import xero
// source modules directly, never the @/lib/xero facade (#1208).
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroRepeatedFailureAlert } from "@/lib/email";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import {
  DEFAULT_REPEATED_FAILURE_THRESHOLD,
  XERO_REQUEUE_OPERATION_TYPE,
  getRepeatedFailureWindowStart,
} from "./xero-hardening-shared";

const DEFAULT_REPEATED_FAILURE_WINDOW_HOURS = 24;

type FailureAlertOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "correlationKey"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "lastErrorMessage"
  | "xeroObjectType"
  | "xeroObjectId"
  | "xeroObjectUrl"
>;

function getRepeatedFailureAlertSubject(correlationKey: string) {
  return `Repeated Xero Failure: ${correlationKey}`;
}

export async function maybeNotifyXeroRepeatedFailure(
  operation: FailureAlertOperation,
  options?: {
    threshold?: number;
    windowHours?: number;
  }
): Promise<{ triggered: boolean; failureCount: number }> {
  if (!operation.correlationKey || operation.operationType === XERO_REQUEUE_OPERATION_TYPE) {
    return { triggered: false, failureCount: 0 };
  }

  const threshold = options?.threshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
  const windowHours = options?.windowHours ?? DEFAULT_REPEATED_FAILURE_WINDOW_HOURS;
  const now = new Date();
  const windowStart = getRepeatedFailureWindowStart(now, windowHours);

  const failureCount = await prisma.xeroSyncOperation.count({
    where: {
      correlationKey: operation.correlationKey,
      operationType: {
        not: XERO_REQUEUE_OPERATION_TYPE,
      },
      status: {
        in: ["FAILED", "PARTIAL"],
      },
      createdAt: {
        gte: windowStart,
      },
    },
  });

  if (failureCount < threshold) {
    return { triggered: false, failureCount };
  }

  const subject = getRepeatedFailureAlertSubject(operation.correlationKey);
  const recentAlert = await prisma.emailLog.findFirst({
    where: {
      templateName: "admin-xero-repeated-failure",
      subject,
      createdAt: {
        gte: windowStart,
      },
      status: {
        in: ["QUEUED", "SENT"],
      },
    },
  });

  if (recentAlert) {
    return { triggered: false, failureCount };
  }

  try {
    await sendAdminXeroRepeatedFailureAlert({
      subject,
      correlationKey: operation.correlationKey,
      failureCount,
      windowHours,
      entityType: operation.entityType,
      operationType: operation.operationType,
      localModel: operation.localModel ?? null,
      localId: operation.localId ?? null,
      localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      xeroObjectUrl:
        operation.xeroObjectUrl ??
        (operation.xeroObjectType && operation.xeroObjectId
          ? buildXeroObjectUrl(operation.xeroObjectType, operation.xeroObjectId)
          : null),
      latestErrorMessage: operation.lastErrorMessage ?? null,
      timestamp: now,
    });
    return { triggered: true, failureCount };
  } catch (error) {
    logger.error(
      {
        err: error,
        correlationKey: operation.correlationKey,
        operationId: operation.id,
      },
      "Failed to send repeated Xero failure alert"
    );
    return { triggered: false, failureCount };
  }
}
