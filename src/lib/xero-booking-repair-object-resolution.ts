// Xero object resolution across local fields, links, and past operations for
// the booking-vs-Xero repair tool. Extracted verbatim from
// xero-booking-repair.ts (#1208 item 2).
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import type {
  BlockingOperationMatch,
  ResolvedLocalObject,
  XeroObjectLinkRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";

const STUCK_OPERATION_MS = 30 * 60 * 1000;

function buildObjectUrl(
  xeroObjectType: string,
  objectId: string,
  fallbackUrl: string | null
) {
  if (fallbackUrl) {
    return fallbackUrl;
  }

  if (xeroObjectType === "INVOICE" || xeroObjectType === "ALLOCATION") {
    return buildXeroInvoiceUrl(objectId);
  }

  return null;
}

export function resolveObjectFromCandidates(params: {
  fieldObjectId?: string | null;
  fieldObjectNumber?: string | null;
  fieldObjectUrl?: string | null;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role?: string;
  entityType?: string;
  operationType?: string;
}): ResolvedLocalObject | null {
  const candidates: ResolvedLocalObject[] = [];

  if (params.fieldObjectId) {
    candidates.push({
      objectId: params.fieldObjectId,
      objectNumber: params.fieldObjectNumber ?? null,
      objectUrl: params.fieldObjectUrl ?? buildObjectUrl(
        params.xeroObjectType,
        params.fieldObjectId,
        null
      ),
      source: "field",
      link: null,
      operation: null,
      conflicts: [],
    });
  }

  for (const link of params.links) {
    if (link.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (params.role && link.role !== params.role) {
      continue;
    }

    candidates.push({
      objectId: link.xeroObjectId,
      objectNumber: link.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(params.xeroObjectType, link.xeroObjectId, link.xeroObjectUrl),
      source: "link",
      link,
      operation: null,
      conflicts: [],
    });
  }

  for (const operation of params.operations) {
    if (params.entityType && operation.entityType !== params.entityType) {
      continue;
    }
    if (params.operationType && operation.operationType !== params.operationType) {
      continue;
    }
    if (!["SUCCEEDED", "PARTIAL"].includes(operation.status)) {
      continue;
    }
    if (operation.xeroObjectType && operation.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (!operation.xeroObjectId) {
      continue;
    }

    candidates.push({
      objectId: operation.xeroObjectId,
      objectNumber: operation.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(
        params.xeroObjectType,
        operation.xeroObjectId,
        operation.xeroObjectUrl ?? null
      ),
      source: "operation",
      link: null,
      operation,
      conflicts: [],
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueIds = [...new Set(candidates.map((candidate) => candidate.objectId))];
  const priority = { field: 0, link: 1, operation: 2 } satisfies Record<ResolvedLocalObject["source"], number>;
  const chosen = [...candidates].sort(
    (left, right) => priority[left.source] - priority[right.source]
  )[0];

  return {
    ...chosen,
    conflicts: uniqueIds.filter((objectId) => objectId !== chosen.objectId),
  };
}

export function getBlockingOperation(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string
): BlockingOperationMatch | null {
  const relevant = operations.filter(
    (operation) =>
      operation.entityType === entityType &&
      operation.operationType === operationType &&
      ["FAILED", "PARTIAL", "PENDING", "RUNNING"].includes(operation.status)
  );

  if (relevant.length === 0) {
    return null;
  }

  const failedOrPartial = relevant.find((operation) =>
    ["FAILED", "PARTIAL"].includes(operation.status)
  );
  if (failedOrPartial) {
    return {
      operation: failedOrPartial,
      retryMeta: getXeroOperationRetryMeta(failedOrPartial),
    };
  }

  const pendingOrRunning = relevant[0];
  return {
    operation: pendingOrRunning,
    retryMeta: getXeroOperationRetryMeta(pendingOrRunning),
  };
}

export function isStuckOperation(operation: XeroOperationRecord) {
  if (!["PENDING", "RUNNING"].includes(operation.status)) {
    return false;
  }

  return Date.now() - operation.createdAt.getTime() >= STUCK_OPERATION_MS;
}
