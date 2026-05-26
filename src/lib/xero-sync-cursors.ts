/**
 * Xero sync coordination utilities.
 *
 * Shared cursor read/write helpers used by the bulk contact sync, the
 * contact-group cache refresh, and the membership-invoice sync. Also
 * exposes a couple of small runtime helpers (throttling, Xero error
 * formatting) that those flows reach for repeatedly.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

export const DEFAULT_XERO_SYNC_SCOPE = "default";

export interface XeroSyncCursorMetadata {
  retryMemberIds?: string[];
  retryContactIds?: string[];
  changedInvoiceCount?: number;
  changedContactCount?: number;
  affectedMemberCount?: number;
  groupCount?: number;
  membershipCount?: number;
  windowStart?: string;
  windowEnd?: string;
}

export function toPrismaJson(
  value: XeroSyncCursorMetadata | undefined
): Prisma.InputJsonValue | undefined {
  return value as Prisma.InputJsonValue | undefined;
}

export function throttle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getXeroSyncCursor(resourceType: string, scope: string) {
  return prisma.xeroSyncCursor.findUnique({
    where: {
      resourceType_scope: {
        resourceType,
        scope,
      },
    },
    select: {
      cursorDateTime: true,
      lastSuccessfulSyncAt: true,
      metadata: true,
    },
  });
}

export async function upsertXeroSyncCursor(input: {
  resourceType: string;
  scope: string;
  cursorDateTime?: Date | null;
  lastSuccessfulSyncAt?: Date | null;
  metadata?: XeroSyncCursorMetadata;
}) {
  await prisma.xeroSyncCursor.upsert({
    where: {
      resourceType_scope: {
        resourceType: input.resourceType,
        scope: input.scope,
      },
    },
    create: {
      resourceType: input.resourceType,
      scope: input.scope,
      cursorDateTime: input.cursorDateTime ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      metadata: toPrismaJson(input.metadata),
    },
    update: {
      cursorDateTime: input.cursorDateTime ?? null,
      lastSuccessfulSyncAt: input.lastSuccessfulSyncAt ?? null,
      metadata: toPrismaJson(input.metadata),
    },
  });
}

export function getXeroSyncCursorMetadata(
  metadata: unknown
): XeroSyncCursorMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  const value = metadata as Record<string, unknown>;
  return {
    retryMemberIds: Array.isArray(value.retryMemberIds)
      ? value.retryMemberIds.filter(
          (memberId): memberId is string => typeof memberId === "string"
        )
      : [],
    retryContactIds: Array.isArray(value.retryContactIds)
      ? value.retryContactIds.filter(
          (contactId): contactId is string => typeof contactId === "string"
        )
      : [],
    changedInvoiceCount:
      typeof value.changedInvoiceCount === "number"
        ? value.changedInvoiceCount
        : undefined,
    changedContactCount:
      typeof value.changedContactCount === "number"
        ? value.changedContactCount
        : undefined,
    affectedMemberCount:
      typeof value.affectedMemberCount === "number"
        ? value.affectedMemberCount
        : undefined,
    groupCount:
      typeof value.groupCount === "number" ? value.groupCount : undefined,
    membershipCount:
      typeof value.membershipCount === "number"
        ? value.membershipCount
        : undefined,
    windowStart:
      typeof value.windowStart === "string" ? value.windowStart : undefined,
    windowEnd:
      typeof value.windowEnd === "string" ? value.windowEnd : undefined,
  };
}

/**
 * Parse an error thrown during Xero API operations into a human-readable
 * string. Handles Error instances, xero-node SDK response objects, plain
 * strings, and unknown types.
 */
export function parseXeroError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null) {
    const obj = err as Record<string, unknown>;
    if (obj.statusCode || obj.status) {
      let msg = `HTTP ${obj.statusCode ?? obj.status}`;
      if (obj.body && typeof obj.body === "object") {
        const body = obj.body as Record<string, unknown>;
        if (body.Detail) msg += `: ${body.Detail}`;
        else if (body.Message) msg += `: ${body.Message}`;
        else if (body.Title) msg += `: ${body.Title}`;
      } else if (obj.message) {
        msg += `: ${obj.message}`;
      }
      return msg;
    }
    return JSON.stringify(err).slice(0, 200);
  }
  if (typeof err === "string") {
    return err;
  }
  return "Unknown error";
}
