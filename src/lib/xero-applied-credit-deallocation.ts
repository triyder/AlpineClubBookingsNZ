import { PaymentSource } from "@prisma/client";
import { prisma } from "./prisma";
import {
  deriveBookingAppliedCreditCents,
  lockMemberCreditLedger,
} from "./member-credit";
import { callXeroApi, getAuthenticatedXeroClient } from "./xero-api-client";
import { formatDate } from "./xero-invoice-helpers";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  sanitizeForJson,
} from "./xero-sync";
import {
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
} from "./xero-operation-outbox-payload";
import { XeroAppliedCreditOperationBusyError } from "./xero-applied-credit-operation-serialization";

const APPLIED_CREDIT_ALLOCATION_ROLE = "APPLIED_CREDIT_ALLOCATION";
const APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE =
  "APPLIED_CREDIT_REMAINDER_ALLOCATION";

interface DeallocationRow {
  id: string;
  xeroCreditNoteId: string;
  amountCents: number;
  createdAt: Date;
}

export interface PlannedAppliedCreditDeallocationGroup {
  xeroCreditNoteId: string;
  currentCents: number;
  targetCents: number;
  rowTargets: Array<{ id: string; currentCents: number; targetCents: number }>;
}

/** Reduce newest slices first; lot order is conservation-neutral. */
export function planAppliedCreditDeallocation(
  rows: DeallocationRow[],
  desiredAppliedCents: number
): PlannedAppliedCreditDeallocationGroup[] {
  const total = rows.reduce((sum, row) => sum + row.amountCents, 0);
  let toRelease = Math.max(0, total - Math.max(0, desiredAppliedCents));
  const targets = new Map<string, number>();
  for (const row of [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
  )) {
    const released = Math.min(row.amountCents, toRelease);
    targets.set(row.id, row.amountCents - released);
    toRelease -= released;
  }

  const groups = new Map<string, PlannedAppliedCreditDeallocationGroup>();
  for (const row of rows) {
    const targetCents = targets.get(row.id) ?? row.amountCents;
    const group = groups.get(row.xeroCreditNoteId) ?? {
      xeroCreditNoteId: row.xeroCreditNoteId,
      currentCents: 0,
      targetCents: 0,
      rowTargets: [],
    };
    group.currentCents += row.amountCents;
    group.targetCents += targetCents;
    group.rowTargets.push({ id: row.id, currentCents: row.amountCents, targetCents });
    groups.set(row.xeroCreditNoteId, group);
  }
  return [...groups.values()].filter((group) => group.targetCents < group.currentCents);
}

type ProviderAllocation = { allocationID: string; amountCents: number };

type AllocationLinkSnapshot = {
  id: string;
  localModel: string;
  localId: string;
  xeroObjectId: string;
  role: string;
  metadata: unknown;
};

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function linkMatchesGroup(
  link: AllocationLinkSnapshot,
  creditNoteId: string,
  invoiceId: string
): boolean {
  const metadata = metadataRecord(link.metadata);
  return (
    metadata?.creditNoteId === creditNoteId && metadata?.invoiceId === invoiceId
  );
}

function linkedCurrentCents(links: AllocationLinkSnapshot[]): number | null {
  if (links.length === 0) return null;
  const byAnchor = new Map<string, number>();
  for (const link of links) {
    const metadata = metadataRecord(link.metadata);
    const value =
      typeof metadata?.rowTargetCents === "number"
        ? metadata.rowTargetCents
        : typeof metadata?.amountCents === "number"
          ? metadata.amountCents
          : null;
    if (value === null || !Number.isInteger(value) || value < 0) return null;
    const anchor = `${link.localModel}:${link.localId}:${link.role}`;
    const existing = byAnchor.get(anchor);
    if (existing !== undefined && existing !== value) return null;
    byAnchor.set(anchor, value);
  }
  return [...byAnchor.values()].reduce((sum, value) => sum + value, 0);
}

async function readAffectedLinks(params: {
  paymentId: string;
  invoiceId: string;
  group: PlannedAppliedCreditDeallocationGroup;
}): Promise<AllocationLinkSnapshot[]> {
  const rowIds = params.group.rowTargets.map((row) => row.id);
  const links = await prisma.xeroObjectLink.findMany({
    where: {
      active: true,
      xeroObjectType: "ALLOCATION",
      OR: [
        {
          localModel: "MemberCreditNoteAllocation",
          localId: { in: rowIds },
          role: APPLIED_CREDIT_ALLOCATION_ROLE,
        },
        {
          localModel: "Payment",
          localId: params.paymentId,
          role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
        },
      ],
    },
    select: {
      id: true,
      localModel: true,
      localId: true,
      xeroObjectId: true,
      role: true,
      metadata: true,
    },
  });
  return links.filter((link) =>
    linkMatchesGroup(
      link,
      params.group.xeroCreditNoteId,
      params.invoiceId
    )
  );
}

function centsFromXeroAmount(amount: unknown): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
  const cents = Math.round(amount * 100);
  return Math.abs(amount * 100 - cents) < 0.0001 ? cents : null;
}

async function readInvoiceAllocations(
  creditNoteId: string,
  invoiceId: string
): Promise<ProviderAllocation[]> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "deallocateExcessAppliedCreditForBooking",
      context: `getCreditNote(${creditNoteId})`,
    }
  );
  return (response.body.creditNotes?.[0]?.allocations ?? [])
    .filter((allocation) => allocation.invoice?.invoiceID === invoiceId)
    .map((allocation) => {
      const amountCents = centsFromXeroAmount(allocation.amount);
      if (!allocation.allocationID || amountCents === null) {
        throw new Error(
          `Xero allocation for credit note ${creditNoteId} and invoice ${invoiceId} has no safe ID/integer-cent amount`
        );
      }
      return { allocationID: allocation.allocationID, amountCents };
    });
}

async function checkpoint(params: {
  operationId: string;
  bookingId: string;
  group: PlannedAppliedCreditDeallocationGroup;
  phase: "BEFORE_DELETE" | "PROVIDER_VERIFIED";
  providerAllocations: ProviderAllocation[];
  priorLinks: AllocationLinkSnapshot[];
  providerMatch: string;
}) {
  const current = await prisma.xeroSyncOperation.findUnique({
    where: { id: params.operationId },
    select: { requestPayload: true },
  });
  const payload = metadataRecord(current?.requestPayload) ?? {};
  const previousHistory = Array.isArray(payload.history)
    ? payload.history.filter(
        (entry): entry is Record<string, unknown> => metadataRecord(entry) !== null
      )
    : [];
  const entry = {
    creditNoteId: params.group.xeroCreditNoteId,
    currentCents: params.group.currentCents,
    targetCents: params.group.targetCents,
    rowTargets: params.group.rowTargets,
    phase: params.phase,
    providerMatch: params.providerMatch,
    providerAllocations: params.providerAllocations,
    allocationIds: params.providerAllocations.map(
      (allocation) => allocation.allocationID
    ),
    priorLinks: params.priorLinks.map((link) => ({
      id: link.id,
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectId: link.xeroObjectId,
      role: link.role,
      metadata: link.metadata,
    })),
  };
  // Append rather than replace: BEFORE_DELETE and PROVIDER_VERIFIED are both
  // durable evidence, including every row's cents and the provider IDs seen at
  // that phase. This is the recovery/audit trail for multi-note and retry runs.
  const history = [...previousHistory, entry];
  await prisma.xeroSyncOperation.update({
    where: { id: params.operationId },
    data: {
      requestPayload: sanitizeForJson({
        queueType: XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        bookingId: params.bookingId,
        checkpoint: entry,
        history,
      }),
    },
  });
}

async function applyLocalGroup(params: {
  memberId: string;
  paymentId: string;
  invoiceId: string;
  group: PlannedAppliedCreditDeallocationGroup;
  providerAllocations: ProviderAllocation[];
  priorLinks: AllocationLinkSnapshot[];
}) {
  await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(params.memberId, tx);
    const current = await tx.memberCreditNoteAllocation.findMany({
      where: { id: { in: params.group.rowTargets.map((row) => row.id) } },
      select: { id: true, amountCents: true },
    });
    const byId = new Map(current.map((row) => [row.id, row.amountCents]));
    const alreadyApplied = params.group.rowTargets.every((row) =>
      row.targetCents === 0 ? !byId.has(row.id) : byId.get(row.id) === row.targetCents
    );
    if (!alreadyApplied) {
      for (const row of params.group.rowTargets) {
        if (byId.get(row.id) !== row.currentCents) {
          throw new Error(`Applied-credit allocation row ${row.id} changed during Xero deallocation`);
        }
      }
      for (const row of params.group.rowTargets) {
        if (row.targetCents === 0) {
          await tx.memberCreditNoteAllocation.delete({ where: { id: row.id } });
        } else if (row.targetCents !== row.currentCents) {
          await tx.memberCreditNoteAllocation.update({
            where: { id: row.id },
            data: { amountCents: row.targetCents },
          });
        }
      }
    }
    const rowIds = params.group.rowTargets.map((row) => row.id);
    await tx.xeroObjectLink.updateMany({
      where: {
        xeroObjectType: "ALLOCATION",
        active: true,
        OR: [
          {
            localModel: "MemberCreditNoteAllocation",
            localId: { in: rowIds },
            role: APPLIED_CREDIT_ALLOCATION_ROLE,
          },
          {
            id: {
              in: params.priorLinks
                .filter(
                  (link) =>
                    link.localModel === "Payment" &&
                    link.role === APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE
                )
                .map((link) => link.id),
            },
          },
        ],
      },
      data: { active: false },
    });

    if (params.group.targetCents <= 0) return;

    const hasRemainderAnchor = params.priorLinks.some(
      (link) =>
        link.localModel === "Payment" &&
        link.role === APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE
    );
    const positiveRows = params.group.rowTargets.filter(
      (row) => row.targetCents > 0
    );
    const anchors = hasRemainderAnchor
      ? [
          {
            localModel: "Payment",
            localId: params.paymentId,
            role: APPLIED_CREDIT_REMAINDER_ALLOCATION_ROLE,
            targetCents: params.group.targetCents,
          },
        ]
      : positiveRows.map((row) => ({
          localModel: "MemberCreditNoteAllocation",
          localId: row.id,
          role: APPLIED_CREDIT_ALLOCATION_ROLE,
          targetCents: row.targetCents,
        }));

    for (const anchor of anchors) {
      for (const allocation of params.providerAllocations) {
        await tx.xeroObjectLink.upsert({
          where: {
            localModel_localId_xeroObjectType_xeroObjectId_role: {
              localModel: anchor.localModel,
              localId: anchor.localId,
              xeroObjectType: "ALLOCATION",
              xeroObjectId: allocation.allocationID,
              role: anchor.role,
            },
          },
          create: {
            localModel: anchor.localModel,
            localId: anchor.localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: allocation.allocationID,
            role: anchor.role,
            active: true,
            metadata: sanitizeForJson({
              creditNoteId: params.group.xeroCreditNoteId,
              invoiceId: params.invoiceId,
              amountCents: allocation.amountCents,
              rowTargetCents: anchor.targetCents,
              providerAllocationIdVerified: true,
            }),
          },
          update: {
            active: true,
            metadata: sanitizeForJson({
              creditNoteId: params.group.xeroCreditNoteId,
              invoiceId: params.invoiceId,
              amountCents: allocation.amountCents,
              rowTargetCents: anchor.targetCents,
              providerAllocationIdVerified: true,
            }),
          },
        });
      }
    }
  });
}

/**
 * Converges provider allocations to the current local applied-credit total.
 * GET supplies real Xero allocation IDs; any uncheckpointed mismatch fails
 * loudly rather than deleting a guessed/manual allocation.
 */
export async function deallocateExcessAppliedCreditForBooking(
  bookingId: string,
  options: { syncOperationId: string }
): Promise<void> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { payment: true },
  });
  if (
    !booking?.payment ||
    booking.payment.source !== PaymentSource.INTERNET_BANKING ||
    !booking.payment.xeroInvoiceId
  ) {
    await completeXeroSyncOperation(options.syncOperationId, {
      responsePayload: { skipped: true, reason: "No allocated Internet-Banking invoice." },
    });
    return;
  }

  const conflicting = await prisma.xeroSyncOperation.findFirst({
    where: {
      id: { not: options.syncOperationId },
      localModel: "Payment",
      localId: booking.payment.id,
      queueType: {
        in: [
          XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
          XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
        ],
      },
      status: "RUNNING",
    },
    select: { id: true },
  });
  if (conflicting) {
    throw new XeroAppliedCreditOperationBusyError(
      `Applied-credit operation ${conflicting.id} is still running; retrying deallocation`
    );
  }

  const desiredAppliedCents = await deriveBookingAppliedCreditCents(bookingId);
  const rows = await prisma.memberCreditNoteAllocation.findMany({
    where: { appliedToBookingId: bookingId },
    select: { id: true, xeroCreditNoteId: true, amountCents: true, createdAt: true },
  });
  const groups = planAppliedCreditDeallocation(rows, desiredAppliedCents);
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  for (const group of groups) {
    const priorLinks = await readAffectedLinks({
      paymentId: booking.payment.id,
      invoiceId: booking.payment.xeroInvoiceId,
      group,
    });
    let provider = await readInvoiceAllocations(
      group.xeroCreditNoteId,
      booking.payment.xeroInvoiceId
    );
    let providerTotal = provider.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id: options.syncOperationId },
      select: { requestPayload: true },
    });
    const payload = operation?.requestPayload as Record<string, unknown> | null;
    const saved = payload?.checkpoint as Record<string, unknown> | undefined;
    const savedIds = Array.isArray(saved?.allocationIds)
      ? saved.allocationIds.filter((id): id is string => typeof id === "string")
      : [];
    const checkpointMatchesGroup =
      saved?.creditNoteId === group.xeroCreditNoteId &&
      saved?.currentCents === group.currentCents &&
      saved?.targetCents === group.targetCents;
    const currentTotalHasLocalProvenance =
      providerTotal === group.currentCents &&
      linkedCurrentCents(priorLinks) === group.currentCents;
    const targetTotalHasCheckpointProvenance =
      providerTotal === group.targetCents && checkpointMatchesGroup;
    const checkpointedPartial =
      checkpointMatchesGroup &&
      providerTotal < group.currentCents &&
      provider.every((allocation) => savedIds.includes(allocation.allocationID));
    if (
      !currentTotalHasLocalProvenance &&
      !targetTotalHasCheckpointProvenance &&
      !checkpointedPartial
    ) {
      throw new Error(
        `Ambiguous Xero allocation total/provenance for credit note ${group.xeroCreditNoteId}: provider=${providerTotal}c local=${group.currentCents}c target=${group.targetCents}c; no matching active local links or durable checkpoint prove these provider allocation IDs`
      );
    }

    if (providerTotal !== group.targetCents) {
      await checkpoint({
        operationId: options.syncOperationId,
        bookingId,
        group,
        phase: "BEFORE_DELETE",
        providerAllocations: provider,
        priorLinks,
        providerMatch: checkpointedPartial
          ? "CHECKPOINTED_PARTIAL_PROVIDER_IDS"
          : "LOCAL_LINK_TOTAL_AND_XERO_NOTE_INVOICE_MATCH",
      });
      for (const allocation of provider) {
        await callXeroApi(
          () => xero.accountingApi.deleteCreditNoteAllocations(
            tenantId, group.xeroCreditNoteId, allocation.allocationID
          ),
          {
            operation: "deleteCreditNoteAllocations",
            resourceType: "ALLOCATION",
            workflow: "deallocateExcessAppliedCreditForBooking",
            context: `deleteCreditNoteAllocations(${group.xeroCreditNoteId}, ${allocation.allocationID})`,
          }
        );
      }
      if (group.targetCents > 0) {
        const idempotencyKey = buildXeroIdempotencyKey(
          "credit-note", group.xeroCreditNoteId, "invoice", booking.payment.xeroInvoiceId,
          "deallocation-recreate", group.currentCents, group.targetCents, "v1"
        );
        await callXeroApi(
          () => xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            group.xeroCreditNoteId,
            { allocations: [{
              invoice: { invoiceID: booking.payment!.xeroInvoiceId! },
              amount: group.targetCents / 100,
              date: formatDate(new Date()),
            }] },
            undefined,
            idempotencyKey
          ),
          {
            operation: "createCreditNoteAllocation",
            resourceType: "ALLOCATION",
            workflow: "deallocateExcessAppliedCreditForBooking",
            context: `recreateCreditNoteAllocation(${group.xeroCreditNoteId})`,
          }
        );
      }
      provider = await readInvoiceAllocations(group.xeroCreditNoteId, booking.payment.xeroInvoiceId);
      providerTotal = provider.reduce((sum, allocation) => sum + allocation.amountCents, 0);
      if (providerTotal !== group.targetCents) {
        throw new Error(
          `Xero deallocation verification failed for ${group.xeroCreditNoteId}: provider=${providerTotal}c target=${group.targetCents}c`
        );
      }
    }
    await checkpoint({
      operationId: options.syncOperationId,
      bookingId,
      group,
      phase: "PROVIDER_VERIFIED",
      providerAllocations: provider,
      priorLinks,
      providerMatch:
        providerTotal === group.targetCents
          ? "TARGET_TOTAL_WITH_ACTUAL_XERO_ALLOCATION_IDS"
          : "UNREACHABLE",
    });
    await applyLocalGroup({
      memberId: booking.memberId,
      paymentId: booking.payment.id,
      invoiceId: booking.payment.xeroInvoiceId,
      group,
      providerAllocations: provider,
      priorLinks,
    });
  }

  await completeXeroSyncOperation(options.syncOperationId, {
    responsePayload: {
      bookingId,
      invoiceId: booking.payment.xeroInvoiceId,
      desiredAppliedCents,
      adjustedCreditNotes: groups.length,
    },
  });
}
