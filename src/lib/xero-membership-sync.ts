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
import { getResolvedAccountMapping } from "./xero-mappings";
import { getSeasonStartMonth } from "@/lib/financial-year";
import { loadMembershipLockoutSettings } from "@/lib/membership-lockout-settings";
import { requiresPaidSubscriptionForAgeTierFromSettings } from "@/lib/member-subscription-eligibility";
import { roleNeverRequiresSubscription } from "@/lib/member-subscription-defaults";
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
  // Season starts on the first of the month after the financial year-end and
  // runs until the instant before the next season starts. Using an exclusive
  // next-season boundary keeps this correct for any year-end month, including
  // 30-day end months and a December (calendar-year) year-end.
  const startMonth = getSeasonStartMonth(); // 1-12
  const start = new Date(Date.UTC(seasonYear, startMonth - 1, 1, 0, 0, 0, 0));
  const nextStart = new Date(
    Date.UTC(seasonYear + 1, startMonth - 1, 1, 0, 0, 0, 0)
  );
  return { start, end: new Date(nextStart.getTime() - 1) };
}

function buildMembershipInvoiceWhereClause(
  seasonYear: number,
  xeroContactId?: string
): string {
  const startMonth = getSeasonStartMonth(); // 1-12
  const conditions = [
    `Date >= DateTime(${seasonYear},${startMonth},1)`,
    `Date < DateTime(${seasonYear + 1},${startMonth},1)`,
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

// test seam
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
        manuallyMarkedPaidAt: true,
        chargeCoverage: { select: { id: true } },
      },
    });

    if (subscriptions.length === 0) {
      return {
        seasonYears: [],
        deletedCount: 0,
        deactivatedLinkCount: 0,
      };
    }

    // Durable charge coverage is financial history and must never be flushed
    // by a contact resync/unlink. The same holds for a manual mark-paid row
    // (#1944): it records a real cash payment taken outside Xero, so deleting
    // it on link/push/unlink would let a later re-sync recreate NOT_INVOICED
    // and the billing sweep re-invoice a member who already paid. Only
    // legacy/unbilled derived rows are reset.
    const subscriptionIds = subscriptions
      .filter(
        (subscription) =>
          !subscription.chargeCoverage && !subscription.manuallyMarkedPaidAt
      )
      .map((subscription) => subscription.id);
    const seasonYears = Array.from(
      new Set(subscriptions.map((subscription) => subscription.seasonYear))
    ).sort((left, right) => right - left);

    const deactivatedLinks = subscriptionIds.length > 0 ? await tx.xeroObjectLink.updateMany({
      where: {
        localModel: "MemberSubscription",
        localId: { in: subscriptionIds },
        active: true,
      },
      data: {
        active: false,
      },
    }) : { count: 0 };
    const deletedSubscriptions = subscriptionIds.length > 0 ? await tx.memberSubscription.deleteMany({
      where: {
        id: { in: subscriptionIds },
      },
    }) : { count: 0 };

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

/**
 * #1944 non-clobber write fence for Xero-derived subscription state that does
 * NOT link a real Xero invoice (NOT_REQUIRED / NOT_INVOICED / a matched invoice
 * missing its identifier). A row with manual mark-paid provenance and no Xero
 * invoice link records a cash payment taken outside Xero and must never be
 * downgraded by discovery. checkMembershipStatus reads a guard up front, but
 * multiple Xero round-trips happen between that read and the write, so a manual
 * mark-paid landing mid-sync would be clobbered by a blind upsert. This fence
 * re-applies the guard atomically at write time: the conditional updateMany
 * only touches rows that either carry no manual provenance or carry a real
 * Xero invoice link (Xero is authoritative once an invoice links), and
 * create-if-missing covers the no-row case without racing a concurrent writer.
 * Any row the write does touch has its manual provenance cleared, so a row can
 * never read e.g. "NOT_INVOICED (manual)".
 *
 * Returns the surviving row when the fence blocks the write so callers can
 * report the preserved (manual PAID) state instead of the discarded one.
 */
async function writeXeroDerivedSubscriptionState(input: {
  memberId: string;
  seasonYear: number;
  status: MembershipSubscriptionStatus;
  paidAt?: Date | null;
}): Promise<{
  written: boolean;
  survivingStatus: MembershipSubscriptionStatus;
  survivingPaidAt: Date | null;
  survivingOnlineInvoiceUrl: string | null;
}> {
  const data = {
    status: input.status,
    xeroInvoiceId: null,
    xeroInvoiceNumber: null,
    xeroOnlineInvoiceUrl: null,
    paidAt: input.paidAt ?? null,
    manuallyMarkedPaidAt: null,
    manuallyMarkedPaidByMemberId: null,
    manualPaymentNote: null,
  };
  const updated = await prisma.memberSubscription.updateMany({
    where: {
      memberId: input.memberId,
      seasonYear: input.seasonYear,
      OR: [{ manuallyMarkedPaidAt: null }, { xeroInvoiceId: { not: null } }],
    },
    data,
  });
  if (updated.count === 0) {
    const created = await prisma.memberSubscription.createMany({
      data: [
        { memberId: input.memberId, seasonYear: input.seasonYear, ...data },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      // A row exists but the fence excluded it: it is manually marked paid
      // with no Xero invoice link (or was created concurrently). Preserve it.
      const surviving = await prisma.memberSubscription.findUnique({
        where: {
          memberId_seasonYear: {
            memberId: input.memberId,
            seasonYear: input.seasonYear,
          },
        },
        select: { status: true, paidAt: true, xeroOnlineInvoiceUrl: true },
      });
      if (surviving) {
        return {
          written: false,
          survivingStatus: surviving.status as MembershipSubscriptionStatus,
          survivingPaidAt: surviving.paidAt,
          survivingOnlineInvoiceUrl: surviving.xeroOnlineInvoiceUrl,
        };
      }
    }
  }
  return {
    written: true,
    survivingStatus: input.status,
    survivingPaidAt: input.paidAt ?? null,
    survivingOnlineInvoiceUrl: null,
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

  // #1944 non-clobber guard: never let Xero discovery downgrade a subscription
  // that was manually marked paid outside the Xero pipeline. The finance:edit
  // manual mark-paid action sets status = PAID with provenance and never creates
  // a Xero invoice, so a manual PAID row carries no xeroInvoiceId. If Xero later
  // links a real subscription invoice to this row (xeroInvoiceId becomes set),
  // this guard no longer fires and Xero is authoritative again, exactly as
  // before. This early return is the fast path (it also avoids spending Xero
  // API budget on a row discovery cannot change); the authoritative protection
  // is the write-time fence in writeXeroDerivedSubscriptionState, which
  // re-applies the same condition atomically at each non-linking write so a
  // manual mark-paid landing mid-sync (after this read, across the Xero
  // round-trips below) is still preserved.
  const manualPaidGuard = await prisma.memberSubscription.findUnique({
    where: { memberId_seasonYear: { memberId, seasonYear: year } },
    select: {
      status: true,
      manuallyMarkedPaidAt: true,
      xeroInvoiceId: true,
      xeroOnlineInvoiceUrl: true,
      paidAt: true,
    },
  });
  if (manualPaidGuard?.manuallyMarkedPaidAt && !manualPaidGuard.xeroInvoiceId) {
    return {
      status: manualPaidGuard.status,
      paidAt: manualPaidGuard.paidAt ?? undefined,
      xeroOnlineInvoiceUrl: manualPaidGuard.xeroOnlineInvoiceUrl,
    };
  }

  const subscriptionRequired =
    !roleNeverRequiresSubscription(member.role) &&
    (await requiresPaidSubscriptionForAgeTierFromSettings(member.ageTier));

  if (!subscriptionRequired) {
    const write = await writeXeroDerivedSubscriptionState({
      memberId,
      seasonYear: year,
      status: "NOT_REQUIRED",
    });
    if (!write.written) {
      return {
        status: write.survivingStatus,
        paidAt: write.survivingPaidAt ?? undefined,
        xeroOnlineInvoiceUrl: write.survivingOnlineInvoiceUrl,
      };
    }

    return { status: "NOT_REQUIRED" };
  }

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
      chargeCoverage: {
        select: {
          charge: {
            select: {
              xeroInvoiceId: true,
            },
          },
        },
      },
    },
  });
  const immutableChargeInvoiceId =
    existingSubscription?.chargeCoverage?.charge.xeroInvoiceId ?? null;

  // Family-billed subscriptions can be covered by an invoice issued to another
  // member. In that case the covered member does not need their own Xero contact,
  // and contact-scoped discovery would fail to find (and then clear) the durable
  // invoice identity persisted by the subscription billing workflow.
  if (!member.xeroContactId && !immutableChargeInvoiceId) {
    return { status: "NOT_INVOICED" };
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
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
      immutableChargeInvoiceId,
      changedInvoiceIds: options?.changedInvoiceIds
        ? Array.from(options.changedInvoiceIds)
        : [],
    },
  });

  try {
    // A charge snapshot owns an immutable invoice identity. Fetch that invoice
    // directly, including for non-recipient family members. Legacy subscriptions
    // without charge coverage retain contact-scoped discovery.
    const response = immutableChargeInvoiceId
      ? await callXeroApi(
          () =>
            xero.accountingApi.getInvoice(
              tenantId,
              immutableChargeInvoiceId
            ),
          {
            operation: "getInvoice",
            resourceType: "INVOICE",
            workflow: "checkMembershipStatus",
            context: `checkMembershipStatus(${memberId}, immutable charge invoice)`,
          }
        )
      : await callXeroApi(
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

    // Look for subscription invoices matching the season year. Detection
    // criteria (account code, item code, text fallback) are admin-configurable.
    let subscriptionInvoice: Invoice | undefined | null;
    if (immutableChargeInvoiceId) {
      subscriptionInvoice = invoices.find(
        (invoice) => invoice.invoiceID === immutableChargeInvoiceId
      );
    } else {
      const subscriptionMapping =
        await getResolvedAccountMapping("subscriptionIncome");
      const lockoutSettings = await loadMembershipLockoutSettings();
      subscriptionInvoice = findSubscriptionInvoice(invoices, year, {
        accountCode: subscriptionMapping.code ?? "203",
        itemCode: subscriptionMapping.itemCode,
        textFallbackEnabled: lockoutSettings.textFallbackEnabled,
      });
    }

    if (!subscriptionInvoice) {
      const write = await writeXeroDerivedSubscriptionState({
        memberId,
        seasonYear: year,
        status: "NOT_INVOICED",
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: {
          fetchedInvoices: invoices.length,
          previousStatus: existingSubscription?.status ?? null,
          nextStatus: write.survivingStatus,
          matchedInvoiceId: null,
          preservedManualPayment: !write.written,
        },
      });

      if (!write.written) {
        return {
          status: write.survivingStatus,
          paidAt: write.survivingPaidAt ?? undefined,
          xeroOnlineInvoiceUrl: write.survivingOnlineInvoiceUrl,
        };
      }

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

    // Update local MemberSubscription record. When a real Xero invoice links
    // (matchedInvoiceId set), Xero is authoritative even over a manual
    // mark-paid that landed mid-sync, and the write clears the manual
    // provenance columns so a row can never read e.g. "UNPAID (manual)"
    // (#1944). In the degenerate case where the matched invoice carries no
    // identifier, nothing links, so the manual-payment write fence applies as
    // for the other non-linking writes.
    let subscriptionRecordId: string | null = null;
    if (matchedInvoiceId) {
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
          manuallyMarkedPaidAt: null,
          manuallyMarkedPaidByMemberId: null,
          manualPaymentNote: null,
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
      subscriptionRecordId = subscriptionRecord.id;
    } else {
      const write = await writeXeroDerivedSubscriptionState({
        memberId,
        seasonYear: year,
        status: status.status,
        paidAt: status.paidAt ?? null,
      });
      if (!write.written) {
        await completeXeroSyncOperation(operation.id, {
          responsePayload: {
            fetchedInvoices: invoices.length,
            matchedInvoiceId: null,
            matchedInvoiceNumber,
            previousStatus: existingSubscription?.status ?? null,
            nextStatus: write.survivingStatus,
            preservedManualPayment: true,
          },
        });
        return {
          status: write.survivingStatus,
          paidAt: write.survivingPaidAt ?? undefined,
          xeroOnlineInvoiceUrl: write.survivingOnlineInvoiceUrl,
        };
      }
    }

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
      extraLinks: matchedInvoiceId && subscriptionRecordId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscriptionRecordId,
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

export interface SubscriptionInvoiceMatchOptions {
  /** Chart-of-account code that marks a line as a membership subscription. */
  accountCode: string;
  /** Optional Xero item code that also marks a line as a subscription. */
  itemCode?: string | null;
  /**
   * When true (default), an invoice whose reference/description text reads like
   * a membership subscription also matches, in addition to account/item code.
   */
  textFallbackEnabled?: boolean;
}

/**
 * Find a subscription invoice among a list of Xero invoices for a given season
 * year. An invoice within the season window matches if any line uses the
 * configured account code OR the configured item code, or (when the text
 * fallback is enabled) its reference/description reads like a subscription.
 * Exported for testing.
 */
export function findSubscriptionInvoice(
  invoices: Invoice[],
  seasonYear: number,
  options: SubscriptionInvoiceMatchOptions
): Invoice | null {
  const { accountCode, itemCode, textFallbackEnabled = true } = options;
  const startMonth = getSeasonStartMonth(); // 1-12
  const seasonStart = new Date(seasonYear, startMonth - 1, 1);
  const seasonEndExclusive = new Date(seasonYear + 1, startMonth - 1, 1);

  for (const invoice of invoices) {
    // Check if invoice date falls within the season year [seasonStart, seasonEndExclusive)
    const invoiceDate = invoice.date ? new Date(invoice.date) : null;
    if (!invoiceDate) continue;

    if (invoiceDate < seasonStart || invoiceDate >= seasonEndExclusive) continue;

    // Match on the configured chart-of-account code (e.g. 203 "Annual Subs").
    const hasAccountCode = invoice.lineItems?.some(
      (li) => li.accountCode === accountCode
    );

    // Match on the configured Xero item code, when one is set.
    const hasItemCode = itemCode
      ? invoice.lineItems?.some((li) => li.itemCode === itemCode)
      : false;

    let hasTextMatch = false;
    if (textFallbackEnabled) {
      const hasRefMatch = invoiceTextSuggestsMembershipSubscription(
        invoice.reference
      );
      const hasDescriptionMatch = invoice.lineItems?.some((lineItem) =>
        invoiceTextSuggestsMembershipSubscription(lineItem.description)
      );
      hasTextMatch = Boolean(hasRefMatch || hasDescriptionMatch);
    }

    if (hasAccountCode || hasItemCode || hasTextMatch) {
      return invoice;
    }
  }

  return null;
}

// test seam
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
  const changedInvoiceIds = Array.from(
    new Set(
      changedInvoices
        .map((invoice) => invoice.invoiceID)
        .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
    )
  );
  const changedChargeCoverage = changedInvoiceIds.length > 0
    ? await prisma.membershipSubscriptionChargeCoverage.findMany({
        where: {
          charge: { xeroInvoiceId: { in: changedInvoiceIds } },
          subscription: { member: { active: true, archivedAt: null } },
        },
        select: {
          charge: { select: { xeroInvoiceId: true } },
          subscription: {
            select: {
              member: {
                select: {
                  id: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                  xeroContactId: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      })
    : [];
  const changedCoveredMemberIds = Array.from(new Set(
    changedChargeCoverage.map((coverage) => coverage.subscription.member.id)
  ));
  const retryMemberIds = Array.from(new Set(cursorMetadata.retryMemberIds ?? []));
  const memberWhereClauses: Array<Record<string, unknown>> = [];
  if (changedContactIds.length > 0) {
    memberWhereClauses.push({ xeroContactId: { in: changedContactIds } });
  }
  if (retryMemberIds.length > 0) {
    memberWhereClauses.push({ id: { in: retryMemberIds } });
  }
  if (changedCoveredMemberIds.length > 0) {
    memberWhereClauses.push({ id: { in: changedCoveredMemberIds } });
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
  const changedInvoiceIdsByCoveredMember = new Map<string, Set<string>>();
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
  for (const coverage of changedChargeCoverage) {
    const invoiceId = coverage.charge.xeroInvoiceId;
    if (!invoiceId) continue;
    const memberId = coverage.subscription.member.id;
    const existingIds = changedInvoiceIdsByCoveredMember.get(memberId) ?? new Set<string>();
    existingIds.add(invoiceId);
    changedInvoiceIdsByCoveredMember.set(memberId, existingIds);
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
        changedInvoiceIds: new Set([
          ...(member.xeroContactId
            ? changedInvoiceIdsByContact.get(member.xeroContactId) ?? []
            : []),
          ...(changedInvoiceIdsByCoveredMember.get(member.id) ?? []),
        ]),
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
    changedInvoiceIds,
    affectedMembers: affectedMembersList.length,
    checked,
    updated,
    errors,
    errorDetails,
  };
}
