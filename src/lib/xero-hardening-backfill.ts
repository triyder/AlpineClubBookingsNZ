// Historical Xero object-link backfill: reconstructs canonical xeroObjectLink
// rows (and their bookkeeping BACKFILL_LINK operations) from the local
// canonical Xero id fields. Extracted verbatim from xero-hardening.ts (#1208
// item 5). Import xero source modules directly, never the @/lib/xero facade
// (#1208).
import { prisma } from "@/lib/prisma";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import type {
  XeroHistoricalBackfillResult,
  XeroLinkBackfillCategoryResult,
} from "./xero-hardening-types";

const XERO_BACKFILL_OPERATION_TYPE = "BACKFILL_LINK";

interface CanonicalLinkTarget {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  metadata?: unknown;
  sourceField: string;
}

function buildBackfillCorrelationKey(target: CanonicalLinkTarget) {
  return [
    "xero-backfill",
    target.localModel,
    target.localId,
    target.role,
    target.xeroObjectType,
    target.xeroObjectId,
  ].join(":");
}

function buildLinkKey(target: {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  role: string;
}) {
  return [
    target.localModel,
    target.localId,
    target.xeroObjectType,
    target.xeroObjectId,
    target.role,
  ].join(":");
}

function buildBackfillOperationData(target: CanonicalLinkTarget, now: Date) {
  const correlationKey = buildBackfillCorrelationKey(target);

  return {
    direction: "OUTBOUND",
    entityType: target.xeroObjectType,
    operationType: XERO_BACKFILL_OPERATION_TYPE,
    localModel: target.localModel,
    localId: target.localId,
    status: "SUCCEEDED",
    idempotencyKey: correlationKey,
    correlationKey,
    attemptCount: 1,
    replayable: false,
    requestPayload: {
      source: "historical-canonical-xero-id-backfill",
      sourceField: target.sourceField,
      role: target.role,
    },
    responsePayload: {
      backfilled: true,
    },
    xeroObjectType: target.xeroObjectType,
    xeroObjectId: target.xeroObjectId,
    xeroObjectNumber: target.xeroObjectNumber ?? null,
    xeroObjectUrl:
      target.xeroObjectUrl ??
      buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
    createdByMemberId: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

async function backfillCanonicalLinkTargets(
  targets: CanonicalLinkTarget[]
): Promise<XeroLinkBackfillCategoryResult> {
  if (targets.length === 0) {
    return {
      scanned: 0,
      existingLinks: 0,
      createdLinks: 0,
      existingOperations: 0,
      createdOperations: 0,
    };
  }

  const existingLinks = await prisma.xeroObjectLink.findMany({
    where: {
      OR: targets.map((target) => ({
        localModel: target.localModel,
        localId: target.localId,
        xeroObjectType: target.xeroObjectType,
        xeroObjectId: target.xeroObjectId,
        role: target.role,
      })),
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      xeroObjectId: true,
      role: true,
    },
  });
  const existingLinkKeys = new Set(existingLinks.map(buildLinkKey));
  const linksToCreate = targets.filter(
    (target) => !existingLinkKeys.has(buildLinkKey(target))
  );

  const backfillOperationKeys = targets.map(buildBackfillCorrelationKey);
  const existingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      operationType: XERO_BACKFILL_OPERATION_TYPE,
      correlationKey: { in: backfillOperationKeys },
    },
    select: {
      correlationKey: true,
    },
  });
  const existingOperationKeys = new Set(
    existingOperations
      .map((operation) => operation.correlationKey)
      .filter((value): value is string => Boolean(value))
  );
  const now = new Date();
  const operationsToCreate = targets
    .filter((target) => !existingOperationKeys.has(buildBackfillCorrelationKey(target)))
    .map((target) => buildBackfillOperationData(target, now));

  const createdLinks =
    linksToCreate.length > 0
      ? (
          await prisma.xeroObjectLink.createMany({
            data: linksToCreate.map((target) => ({
              localModel: target.localModel,
              localId: target.localId,
              xeroObjectType: target.xeroObjectType,
              xeroObjectId: target.xeroObjectId,
              xeroObjectNumber: target.xeroObjectNumber ?? null,
              xeroObjectUrl:
                target.xeroObjectUrl ??
                buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
              role: target.role,
              active: true,
              metadata: target.metadata ?? undefined,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

  const createdOperations =
    operationsToCreate.length > 0
      ? (
          await prisma.xeroSyncOperation.createMany({
            data: operationsToCreate,
            skipDuplicates: true,
          })
        ).count
      : 0;

  return {
    scanned: targets.length,
    existingLinks: targets.length - linksToCreate.length,
    createdLinks,
    existingOperations: targets.length - operationsToCreate.length,
    createdOperations,
  };
}

export async function backfillHistoricalXeroObjectLinks(): Promise<XeroHistoricalBackfillResult> {
  const [members, payments, subscriptions] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        seasonYear: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroOnlineInvoiceUrl: true,
      },
    }),
  ]);

  const memberResult = await backfillCanonicalLinkTargets(
    members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
              role: "CONTACT",
              sourceField: "Member.xeroContactId",
            },
          ]
        : []
    )
  );

  const paymentInvoiceResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroInvoiceId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
              xeroObjectNumber: payment.xeroInvoiceNumber ?? null,
              role: "PRIMARY_INVOICE",
              sourceField: "Payment.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  const paymentRefundResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroRefundCreditNoteId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
              role: "REFUND_CREDIT_NOTE",
              sourceField: "Payment.xeroRefundCreditNoteId",
            },
          ]
        : []
    )
  );

  const subscriptionResult = await backfillCanonicalLinkTargets(
    subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
              xeroObjectNumber: subscription.xeroInvoiceNumber ?? null,
              xeroObjectUrl:
                buildXeroObjectUrl("SUBSCRIPTION", subscription.xeroInvoiceId) ?? null,
              role: "SUBSCRIPTION_INVOICE",
              metadata: {
                seasonYear: subscription.seasonYear,
                onlineInvoiceUrl: subscription.xeroOnlineInvoiceUrl ?? null,
              },
              sourceField: "MemberSubscription.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  return {
    completedAt: new Date(),
    members: memberResult,
    paymentInvoices: paymentInvoiceResult,
    paymentRefundCreditNotes: paymentRefundResult,
    subscriptionInvoices: subscriptionResult,
    totals: {
      scanned:
        memberResult.scanned +
        paymentInvoiceResult.scanned +
        paymentRefundResult.scanned +
        subscriptionResult.scanned,
      createdLinks:
        memberResult.createdLinks +
        paymentInvoiceResult.createdLinks +
        paymentRefundResult.createdLinks +
        subscriptionResult.createdLinks,
      createdOperations:
        memberResult.createdOperations +
        paymentInvoiceResult.createdOperations +
        paymentRefundResult.createdOperations +
        subscriptionResult.createdOperations,
    },
  };
}
