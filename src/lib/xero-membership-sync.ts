/**
 * Membership subscription verification and Xero invoice sync.
 *
 * Determines membership subscription status per season by reading
 * matching Xero invoices, refreshes the cached online-invoice URLs, and
 * provides the cron-side `refreshAllMembershipStatuses` driver that
 * walks the incremental membership-invoice cursor.
 */

import { Invoice, type XeroClient } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "./prisma";
import { getSeasonYear } from "./pricing";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  XeroDailyLimitError,
} from "./xero-api-client";
import { getAccountMapping } from "./xero-mappings";
import { requiresPaidSubscriptionForAgeTierFromSettings } from "@/lib/member-subscription-eligibility";
import {
  getXeroSyncCursor,
  getXeroSyncCursorMetadata,
  parseXeroError,
  throttle,
  upsertXeroSyncCursor,
} from "./xero-sync-cursors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMBERSHIP_SYNC_CURSOR_RESOURCE = "MEMBERSHIP_INVOICE_SYNC";
const MEMBERSHIP_CURSOR_OVERLAP_MS = 2 * 60 * 1000;
const MEMBERSHIP_SYNC_THROTTLE_MS = 1200;
const XERO_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MembershipSubscriptionStatus =
  | "PAID"
  | "UNPAID"
  | "OVERDUE"
  | "NOT_INVOICED"
  | "NOT_REQUIRED";

interface CheckMembershipStatusOptions {
  changedInvoiceIds?: Set<string>;
  forceRefreshOnlineInvoiceUrl?: boolean;
}

// ---------------------------------------------------------------------------
// Cursor / season helpers
// ---------------------------------------------------------------------------

function getMembershipSyncCursorScope(seasonYear: number): string {
  return `season:${seasonYear}`;
}

function getMembershipSeasonWindow(seasonYear: number): {
  start: Date;
  end: Date;
} {
  return {
    start: new Date(Date.UTC(seasonYear, 3, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(seasonYear + 1, 2, 31, 23, 59, 59, 999)),
  };
}

function buildMembershipInvoiceWhereClause(
  seasonYear: number,
  xeroContactId?: string
): string {
  const conditions = [
    `Date >= DateTime(${seasonYear},4,1)`,
    `Date <= DateTime(${seasonYear + 1},3,31)`,
    `Type=="ACCREC"`,
  ];

  if (xeroContactId) {
    conditions.unshift(`Contact.ContactID=guid("${xeroContactId}")`);
  }

  return conditions.join(" AND ");
}

function invoiceTextSuggestsMembershipSubscription(
  value: string | null | undefined
): boolean {
  const normalized = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return normalized.includes("subscription") && normalized.includes("member");
}

function didMembershipStatusChange(
  previous:
    | {
        status: string;
        xeroInvoiceId: string | null;
        paidAt: Date | null;
        xeroOnlineInvoiceUrl?: string | null;
      }
    | null,
  next: {
    status: string;
    xeroInvoiceId?: string;
    paidAt?: Date;
    xeroOnlineInvoiceUrl?: string | null;
  }
): boolean {
  return (
    !previous ||
    previous.status !== next.status ||
    previous.xeroInvoiceId !== (next.xeroInvoiceId ?? null) ||
    (previous.paidAt?.getTime() ?? null) !== (next.paidAt?.getTime() ?? null) ||
    (previous.xeroOnlineInvoiceUrl ?? null) !==
      (next.xeroOnlineInvoiceUrl ?? null)
  );
}

async function listChangedMembershipInvoices(input: {
  xero: XeroClient;
  tenantId: string;
  seasonYear: number;
  ifModifiedSince?: Date;
}): Promise<Invoice[]> {
  const invoices: Invoice[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await callXeroApi(
      () =>
        input.xero.accountingApi.getInvoices(
          input.tenantId,
          input.ifModifiedSince,
          buildMembershipInvoiceWhereClause(input.seasonYear),
          "UpdatedDateUTC ASC",
          undefined,
          undefined,
          undefined,
          undefined,
          page,
          false,
          false,
          undefined,
          false,
          XERO_PAGE_SIZE
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "refreshAllMembershipStatuses",
        context: `refreshAllMembershipStatuses incremental page ${page}`,
      }
    );

    const pageInvoices = response.body.invoices ?? [];
    invoices.push(...pageInvoices);

    page += 1;
    hasMore = pageInvoices.length === XERO_PAGE_SIZE;
  }

  return invoices;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

export function shouldBackfillMembershipStatus(input: {
  memberUpdatedAt: Date;
  subscription:
    | {
        status: string;
        xeroInvoiceId: string | null;
        updatedAt: Date;
      }
    | null
    | undefined;
}): boolean {
  if (!input.subscription) {
    return true;
  }

  return input.memberUpdatedAt.getTime() > input.subscription.updatedAt.getTime();
}

export async function flushMemberSubscriptionHistory(memberId: string): Promise<{
  seasonYears: number[];
  deletedCount: number;
  deactivatedLinkCount: number;
}> {
  return prisma.$transaction(async (tx) => {
    const subscriptions = await tx.memberSubscription.findMany({
      where: { memberId },
      select: {
        id: true,
        seasonYear: true,
      },
    });

    if (subscriptions.length === 0) {
      return {
        seasonYears: [],
        deletedCount: 0,
        deactivatedLinkCount: 0,
      };
    }

    const subscriptionIds = subscriptions.map((subscription) => subscription.id);
    const seasonYears = Array.from(
      new Set(subscriptions.map((subscription) => subscription.seasonYear))
    ).sort((left, right) => right - left);

    const deactivatedLinks = await tx.xeroObjectLink.updateMany({
      where: {
        localModel: "MemberSubscription",
        localId: { in: subscriptionIds },
        active: true,
      },
      data: {
        active: false,
      },
    });
    const deletedSubscriptions = await tx.memberSubscription.deleteMany({
      where: {
        id: { in: subscriptionIds },
      },
    });

    return {
      seasonYears,
      deletedCount: deletedSubscriptions.count,
      deactivatedLinkCount: deactivatedLinks.count,
    };
  });
}

export async function syncMemberSubscriptionHistoryForLinkedContact(
  memberId: string,
  options?: {
    seasonYears?: number[];
    forceRefreshOnlineInvoiceUrl?: boolean;
  }
): Promise<{
  seasonYears: number[];
  syncedCount: number;
  results: Array<{
    seasonYear: number;
    status: MembershipSubscriptionStatus;
    xeroInvoiceId?: string;
    paidAt?: Date;
    xeroOnlineInvoiceUrl?: string | null;
  }>;
  errors: Array<{ seasonYear: number; error: string }>;
}> {
  const seasonYears = Array.from(
    new Set(
      (options?.seasonYears?.length
        ? options.seasonYears
        : [getSeasonYear(new Date())]
      ).filter(
        (seasonYear): seasonYear is number =>
          Number.isInteger(seasonYear) &&
          seasonYear >= 2020 &&
          seasonYear <= 2040
      )
    )
  ).sort((left, right) => right - left);

  const results: Array<{
    seasonYear: number;
    status: MembershipSubscriptionStatus;
    xeroInvoiceId?: string;
    paidAt?: Date;
    xeroOnlineInvoiceUrl?: string | null;
  }> = [];
  const errors: Array<{ seasonYear: number; error: string }> = [];

  for (const seasonYear of seasonYears) {
    try {
      const result = await checkMembershipStatus(memberId, seasonYear, {
        forceRefreshOnlineInvoiceUrl:
          options?.forceRefreshOnlineInvoiceUrl ?? true,
      });
      results.push({
        seasonYear,
        ...result,
      });
    } catch (error) {
      errors.push({
        seasonYear,
        error: parseXeroError(error),
      });

      if (error instanceof XeroDailyLimitError) {
        break;
      }
    }
  }

  return {
    seasonYears,
    syncedCount: results.length,
    results,
    errors,
  };
}

export async function checkMembershipStatus(
  memberId: string,
  seasonYear?: number,
  options?: CheckMembershipStatusOptions
): Promise<{
  status: MembershipSubscriptionStatus;
  xeroInvoiceId?: string;
  paidAt?: Date;
  xeroOnlineInvoiceUrl?: string | null;
}> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
  });
  if (!member) throw new Error(`Member not found: ${memberId}`);

  const year = seasonYear ?? getSeasonYear(new Date());
  const subscriptionRequired =
    member.role !== "ADMIN" &&
    (await requiresPaidSubscriptionForAgeTierFromSettings(member.ageTier));

  if (!subscriptionRequired) {
    await prisma.memberSubscription.upsert({
      where: {
        memberId_seasonYear: { memberId, seasonYear: year },
      },
      update: {
        status: "NOT_REQUIRED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroOnlineInvoiceUrl: null,
        paidAt: null,
      },
      create: {
        memberId,
        seasonYear: year,
        status: "NOT_REQUIRED",
        xeroInvoiceId: null,
        xeroInvoiceNumber: null,
        xeroOnlineInvoiceUrl: null,
        paidAt: null,
      },
    });

    return { status: "NOT_REQUIRED" };
  }

  if (!member.xeroContactId) {
    return { status: "NOT_INVOICED" };
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const existingSubscription = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: { memberId, seasonYear: year },
    },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      xeroOnlineInvoiceUrl: true,
      paidAt: true,
    },
  });
  const correlationKey = buildXeroIdempotencyKey(
    "member",
    memberId,
    "subscription",
    year,
    "fetch",
    "v1"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "SUBSCRIPTION",
    operationType: "FETCH",
    localModel: "Member",
    localId: memberId,
    correlationKey,
    requestPayload: {
      memberId,
      seasonYear: year,
      xeroContactId: member.xeroContactId,
      changedInvoiceIds: options?.changedInvoiceIds
        ? Array.from(options.changedInvoiceIds)
        : [],
    },
  });

  try {
    // Fetch invoices for this contact, filtered to the season year to avoid pagination issues.
    // Season year runs April to March, so filter invoices from season start to end.
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined, // ifModifiedSince
          buildMembershipInvoiceWhereClause(
            year,
            member.xeroContactId ?? undefined
          ), // where
          undefined, // order
          undefined, // iDs
          undefined, // invoiceNumbers
          undefined, // contactIDs
          undefined, // statuses
          1, // page
          false // includeArchived
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "checkMembershipStatus",
        context: `checkMembershipStatus(${memberId})`,
      }
    );

    const invoices = response.body.invoices ?? [];

    // Look for subscription invoices matching the season year
    const subscriptionAccountCode =
      (await getAccountMapping("subscriptionIncome")) ?? "203";
    const subscriptionInvoice = findSubscriptionInvoice(
      invoices,
      year,
      subscriptionAccountCode
    );

    if (!subscriptionInvoice) {
      await prisma.memberSubscription.upsert({
        where: {
          memberId_seasonYear: { memberId, seasonYear: year },
        },
        update: {
          status: "NOT_INVOICED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroOnlineInvoiceUrl: null,
          paidAt: null,
        },
        create: {
          memberId,
          seasonYear: year,
          status: "NOT_INVOICED",
          xeroInvoiceId: null,
          xeroInvoiceNumber: null,
          xeroOnlineInvoiceUrl: null,
          paidAt: null,
        },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: {
          fetchedInvoices: invoices.length,
          previousStatus: existingSubscription?.status ?? null,
          nextStatus: "NOT_INVOICED",
          matchedInvoiceId: null,
        },
      });

      return { status: "NOT_INVOICED" };
    }

    const status = determineSubscriptionStatus(subscriptionInvoice);
    const matchedInvoiceId = subscriptionInvoice.invoiceID ?? null;
    const matchedInvoiceNumber = subscriptionInvoice.invoiceNumber ?? null;
    const matchedInvoiceChanged = Boolean(
      matchedInvoiceId && options?.changedInvoiceIds?.has(matchedInvoiceId)
    );

    let onlineInvoiceUrl =
      existingSubscription?.xeroInvoiceId === matchedInvoiceId
        ? existingSubscription.xeroOnlineInvoiceUrl ?? null
        : null;
    const shouldRefreshOnlineInvoiceUrl = Boolean(
      matchedInvoiceId &&
        (options?.forceRefreshOnlineInvoiceUrl ||
          !existingSubscription ||
          existingSubscription.xeroInvoiceId !== matchedInvoiceId ||
          existingSubscription.xeroInvoiceNumber !== matchedInvoiceNumber ||
          existingSubscription.status !== status.status ||
          (existingSubscription.paidAt?.getTime() ?? null) !==
            (status.paidAt?.getTime() ?? null) ||
          (matchedInvoiceChanged && !existingSubscription.xeroOnlineInvoiceUrl))
    );

    if (matchedInvoiceId && shouldRefreshOnlineInvoiceUrl) {
      try {
        const onlineRes = await callXeroApi(
          () =>
            xero.accountingApi.getOnlineInvoice(tenantId, matchedInvoiceId),
          {
            operation: "getOnlineInvoice",
            resourceType: "ONLINE_INVOICE",
            workflow: "checkMembershipStatus",
            context: `getOnlineInvoice(${matchedInvoiceId})`,
          }
        );
        const onlineInvoices = onlineRes.body.onlineInvoices;
        if (onlineInvoices && onlineInvoices.length > 0) {
          onlineInvoiceUrl = onlineInvoices[0].onlineInvoiceUrl ?? null;
        }
      } catch {
        // Non-critical — continue without online URL
      }
    }

    // Update local MemberSubscription record
    const subscriptionRecord = await prisma.memberSubscription.upsert({
      where: {
        memberId_seasonYear: { memberId, seasonYear: year },
      },
      update: {
        status: status.status,
        xeroInvoiceId: matchedInvoiceId,
        xeroInvoiceNumber: matchedInvoiceNumber,
        xeroOnlineInvoiceUrl: onlineInvoiceUrl,
        paidAt: status.paidAt,
      },
      create: {
        memberId,
        seasonYear: year,
        status: status.status,
        xeroInvoiceId: matchedInvoiceId,
        xeroInvoiceNumber: matchedInvoiceNumber,
        xeroOnlineInvoiceUrl: onlineInvoiceUrl,
        paidAt: status.paidAt,
      },
    });

    await completeXeroSyncOperation(operation.id, {
      responsePayload: {
        fetchedInvoices: invoices.length,
        matchedInvoiceId,
        matchedInvoiceNumber,
        previousStatus: existingSubscription?.status ?? null,
        nextStatus: status.status,
        previousPaidAt: existingSubscription?.paidAt ?? null,
        nextPaidAt: status.paidAt ?? null,
        onlineInvoiceUrl,
        onlineInvoiceFetched: shouldRefreshOnlineInvoiceUrl,
      },
      xeroObjectType: matchedInvoiceId ? "SUBSCRIPTION" : null,
      xeroObjectId: matchedInvoiceId,
      xeroObjectNumber: matchedInvoiceNumber,
      xeroObjectUrl: matchedInvoiceId
        ? buildXeroInvoiceUrl(matchedInvoiceId)
        : null,
      extraLinks: matchedInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscriptionRecord.id,
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: matchedInvoiceId,
              xeroObjectNumber: matchedInvoiceNumber,
              xeroObjectUrl: buildXeroInvoiceUrl(matchedInvoiceId),
              role: "SUBSCRIPTION_INVOICE",
              metadata: {
                seasonYear: year,
                onlineInvoiceUrl,
              },
            },
          ]
        : [],
    });

    return {
      status: status.status,
      xeroInvoiceId: matchedInvoiceId ?? undefined,
      paidAt: status.paidAt,
      xeroOnlineInvoiceUrl: onlineInvoiceUrl,
    };
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

/**
 * Find a subscription invoice among a list of Xero invoices for a given
 * season year. Exported for testing.
 */
export function findSubscriptionInvoice(
  invoices: Invoice[],
  seasonYear: number,
  subscriptionAccountCode: string = "203"
): Invoice | null {
  const SUBSCRIPTION_ACCOUNT_CODE = subscriptionAccountCode;
  const seasonStart = new Date(seasonYear, 3, 1); // April 1
  const seasonEndExclusive = new Date(seasonYear + 1, 3, 1); // April 1 next year (exclusive)

  for (const invoice of invoices) {
    // Check if invoice date falls within the season year [seasonStart, seasonEndExclusive)
    const invoiceDate = invoice.date ? new Date(invoice.date) : null;
    if (!invoiceDate) continue;

    if (invoiceDate < seasonStart || invoiceDate >= seasonEndExclusive) continue;

    // Check if any line item uses account code 203 (Annual Subs)
    const hasSubsAccountCode = invoice.lineItems?.some(
      (li) => li.accountCode === SUBSCRIPTION_ACCOUNT_CODE
    );

    const hasRefMatch = invoiceTextSuggestsMembershipSubscription(
      invoice.reference
    );
    const hasDescriptionMatch = invoice.lineItems?.some((lineItem) =>
      invoiceTextSuggestsMembershipSubscription(lineItem.description)
    );

    if (hasSubsAccountCode || hasRefMatch || hasDescriptionMatch) {
      return invoice;
    }
  }

  return null;
}

/**
 * Determine subscription status from a Xero invoice. Exported for testing.
 */
export function determineSubscriptionStatus(invoice: Invoice): {
  status: "PAID" | "UNPAID" | "OVERDUE";
  paidAt?: Date;
} {
  const invoiceStatus = invoice.status;

  if (invoiceStatus === Invoice.StatusEnum.PAID) {
    // Use fullyPaidOnDate if available, otherwise fall back to updatedDateUTC
    const paidAt = invoice.fullyPaidOnDate
      ? new Date(invoice.fullyPaidOnDate)
      : invoice.updatedDateUTC
        ? new Date(invoice.updatedDateUTC)
        : undefined;
    return { status: "PAID", paidAt };
  }

  if (
    invoiceStatus === Invoice.StatusEnum.AUTHORISED ||
    invoiceStatus === Invoice.StatusEnum.SUBMITTED
  ) {
    // Check if it's past due
    const dueDate = invoice.dueDate ? new Date(invoice.dueDate) : null;
    if (dueDate && dueDate < new Date()) {
      return { status: "OVERDUE" };
    }
    return { status: "UNPAID" };
  }

  // Draft or voided invoices — treat as not yet properly invoiced
  return { status: "UNPAID" };
}

/**
 * Refresh membership status for all active members. Called by the daily
 * cron job.
 */
export async function refreshAllMembershipStatuses(
  seasonYear?: number,
  options?: {
    includeBackfillCandidates?: boolean;
  }
): Promise<{
  seasonYear: number;
  cursorFrom: string | null;
  cursorTo: string | null;
  changedInvoices: number;
  changedInvoiceIds: string[];
  affectedMembers: number;
  checked: number;
  updated: number;
  errors: number;
  errorDetails: Array<{ member: string; error: string }>;
}> {
  const year = seasonYear ?? getSeasonYear(new Date());
  const syncStartedAt = new Date();
  const cursor = await getXeroSyncCursor(
    MEMBERSHIP_SYNC_CURSOR_RESOURCE,
    getMembershipSyncCursorScope(year)
  );
  const cursorMetadata = getXeroSyncCursorMetadata(cursor?.metadata);
  const ifModifiedSince = cursor?.cursorDateTime
    ? new Date(cursor.cursorDateTime.getTime() - MEMBERSHIP_CURSOR_OVERLAP_MS)
    : undefined;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const { start: windowStart, end: windowEnd } =
    getMembershipSeasonWindow(year);

  const changedInvoices = await listChangedMembershipInvoices({
    xero,
    tenantId,
    seasonYear: year,
    ifModifiedSince,
  });
  const changedContactIds = Array.from(
    new Set(
      changedInvoices
        .map((invoice) => invoice.contact?.contactID)
        .filter((contactId): contactId is string => Boolean(contactId))
    )
  );
  const retryMemberIds = Array.from(new Set(cursorMetadata.retryMemberIds ?? []));
  const memberWhereClauses: Array<Record<string, unknown>> = [];
  if (changedContactIds.length > 0) {
    memberWhereClauses.push({ xeroContactId: { in: changedContactIds } });
  }
  if (retryMemberIds.length > 0) {
    memberWhereClauses.push({ id: { in: retryMemberIds } });
  }

  const incrementalAffectedMembers =
    memberWhereClauses.length === 0
      ? []
      : await prisma.member.findMany({
          where: {
            active: true,
            OR: memberWhereClauses,
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            xeroContactId: true,
            updatedAt: true,
          },
        });

  const backfillCandidates = options?.includeBackfillCandidates
    ? await prisma.member.findMany({
        where: {
          active: true,
          xeroContactId: { not: null },
        },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          xeroContactId: true,
          updatedAt: true,
          subscriptions: {
            where: { seasonYear: year },
            select: {
              status: true,
              xeroInvoiceId: true,
              updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
            take: 1,
          },
        },
      })
    : [];

  const affectedMembers = new Map<
    string,
    {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      xeroContactId: string | null;
      updatedAt: Date;
    }
  >();

  for (const member of incrementalAffectedMembers) {
    affectedMembers.set(member.id, member);
  }

  for (const member of backfillCandidates) {
    if (
      !shouldBackfillMembershipStatus({
        memberUpdatedAt: member.updatedAt,
        subscription: member.subscriptions[0] ?? null,
      })
    ) {
      continue;
    }

    affectedMembers.set(member.id, {
      id: member.id,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      xeroContactId: member.xeroContactId,
      updatedAt: member.updatedAt,
    });
  }

  const affectedMembersList = Array.from(affectedMembers.values());

  logger.info(
    {
      job: "xero-membership-refresh",
      seasonYear: year,
      cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
      changedInvoices: changedInvoices.length,
      changedContacts: changedContactIds.length,
      retryMembers: retryMemberIds.length,
      backfillCandidates: backfillCandidates.length,
      affectedMembers: affectedMembersList.length,
      includeBackfillCandidates: Boolean(options?.includeBackfillCandidates),
    },
    "Refreshing membership subscriptions from the incremental Xero invoice cursor"
  );

  const changedInvoiceIdsByContact = new Map<string, Set<string>>();
  for (const invoice of changedInvoices) {
    const contactId = invoice.contact?.contactID;
    const invoiceId = invoice.invoiceID;
    if (!contactId || !invoiceId) {
      continue;
    }

    const existingIds =
      changedInvoiceIdsByContact.get(contactId) ?? new Set<string>();
    existingIds.add(invoiceId);
    changedInvoiceIdsByContact.set(contactId, existingIds);
  }

  let checked = 0;
  let updated = 0;
  let errors = 0;
  const errorDetails: Array<{ member: string; error: string }> = [];
  const nextRetryMemberIds: string[] = [];

  for (let index = 0; index < affectedMembersList.length; index += 1) {
    const member = affectedMembersList[index];
    try {
      const before = await prisma.memberSubscription.findFirst({
        where: { memberId: member.id, seasonYear: year },
        select: {
          status: true,
          xeroInvoiceId: true,
          paidAt: true,
          xeroOnlineInvoiceUrl: true,
        },
      });
      const result = await checkMembershipStatus(member.id, year, {
        changedInvoiceIds: member.xeroContactId
          ? changedInvoiceIdsByContact.get(member.xeroContactId)
          : undefined,
      });
      checked++;

      if (didMembershipStatusChange(before, result)) {
        updated++;
      }
    } catch (err) {
      if (err instanceof XeroDailyLimitError) {
        nextRetryMemberIds.push(
          member.id,
          ...affectedMembersList
            .slice(index + 1)
            .map((remaining) => remaining.id)
        );
        logger.warn(
          { job: "xero-membership-refresh", checked, errors, seasonYear: year },
          "Aborting membership refresh: Xero daily API limit reached"
        );
        errorDetails.push({
          member: "SYSTEM",
          error:
            "Xero daily API limit reached — deferring remaining affected members",
        });
        errors++;
        break;
      }

      nextRetryMemberIds.push(member.id);
      errors++;
      const memberLabel = `${member.firstName} ${member.lastName} (${member.email})`;
      errorDetails.push({ member: memberLabel, error: parseXeroError(err) });
    }

    await throttle(MEMBERSHIP_SYNC_THROTTLE_MS);
  }

  const completedAt = new Date();
  await upsertXeroSyncCursor({
    resourceType: MEMBERSHIP_SYNC_CURSOR_RESOURCE,
    scope: getMembershipSyncCursorScope(year),
    cursorDateTime: syncStartedAt,
    lastSuccessfulSyncAt: completedAt,
    metadata: {
      retryMemberIds: Array.from(new Set(nextRetryMemberIds)),
      changedInvoiceCount: changedInvoices.length,
      affectedMemberCount: affectedMembersList.length,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
    },
  });

  return {
    seasonYear: year,
    cursorFrom: cursor?.cursorDateTime?.toISOString() ?? null,
    cursorTo: syncStartedAt.toISOString(),
    changedInvoices: changedInvoices.length,
    changedInvoiceIds: Array.from(
      new Set(
        changedInvoices
          .map((invoice) => invoice.invoiceID)
          .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
      )
    ),
    affectedMembers: affectedMembersList.length,
    checked,
    updated,
    errors,
    errorDetails,
  };
}
