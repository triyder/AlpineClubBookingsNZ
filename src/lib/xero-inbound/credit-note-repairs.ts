import { type CreditNote as XeroCreditNote } from "xero-node";
import { CreditType, PaymentSource, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { type AccountCreditAllocationRepairResult, type AccountCreditAllocationTarget, type RefundedPaymentBusinessStateRepairResult } from "./types";
import { buildBookingAppliedCreditDescription, getAmountCentsFromAllocationMetadata, getCreditNoteAmountCents, getCreditNoteIdFromAllocationMetadata, getJsonRecord, getNextRefundedPaymentStatus, getRefundContributionCentsFromCreditNoteMetadata, isIncludedRefundCreditNoteStatus } from "./amounts";
import { findActiveXeroObjectLinks } from "./object-links";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";

export async function resolvePaymentIdsByInvoiceTargets(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[]
) {
  const uniqueInvoiceIds = Array.from(
    new Set(
      allocationTargets
        .map((target) => target.invoiceId)
        .filter((invoiceId): invoiceId is string => Boolean(invoiceId))
    )
  );
  if (uniqueInvoiceIds.length === 0) {
    return new Map<string, string>();
  }

  const paymentIdsByInvoiceId = new Map<string, Set<string>>();
  const directMatches = await prisma.payment.findMany({
    where: {
      xeroInvoiceId: {
        in: uniqueInvoiceIds,
      },
    },
    select: {
      id: true,
      xeroInvoiceId: true,
    },
  });

  for (const payment of directMatches) {
    if (!payment.xeroInvoiceId) {
      continue;
    }

    const ids = paymentIdsByInvoiceId.get(payment.xeroInvoiceId) ?? new Set<string>();
    ids.add(payment.id);
    paymentIdsByInvoiceId.set(payment.xeroInvoiceId, ids);
  }

  const unresolvedInvoiceIds = uniqueInvoiceIds.filter(
    (invoiceId) => (paymentIdsByInvoiceId.get(invoiceId)?.size ?? 0) !== 1
  );
  if (unresolvedInvoiceIds.length > 0) {
    const linkedMatches = await prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        xeroObjectType: "INVOICE",
        xeroObjectId: {
          in: unresolvedInvoiceIds,
        },
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
      },
    });

    for (const link of linkedMatches) {
      const ids = paymentIdsByInvoiceId.get(link.xeroObjectId) ?? new Set<string>();
      ids.add(link.localId);
      paymentIdsByInvoiceId.set(link.xeroObjectId, ids);
    }
  }

  const resolvedPaymentIds = new Map<string, string>();
  for (const invoiceId of uniqueInvoiceIds) {
    const paymentIds = paymentIdsByInvoiceId.get(invoiceId);
    if (paymentIds?.size === 1) {
      resolvedPaymentIds.set(invoiceId, Array.from(paymentIds)[0]);
      continue;
    }

    if ((paymentIds?.size ?? 0) > 1) {
      logger.warn(
        {
          creditNoteId,
          invoiceId,
          matchedPayments: paymentIds?.size ?? 0,
        },
        "Skipping refunded-payment repair because the allocated invoice resolved to multiple local payments"
      );
    }
  }

  return resolvedPaymentIds;
}

export async function repairRefundedPaymentBusinessState(input: {
  creditNoteId: string;
  creditNote: Pick<XeroCreditNote, "status" | "total" | "appliedAmount" | "remainingCredit">;
  directPaymentIds: string[];
  modificationRefundAmountsByPaymentId: Map<string, number>;
}): Promise<RefundedPaymentBusinessStateRepairResult> {
  const directPaymentIds = Array.from(
    new Set(
      input.directPaymentIds.filter(
        (paymentId): paymentId is string => typeof paymentId === "string" && paymentId.trim().length > 0
      )
    )
  );
  const paymentIds = Array.from(
    new Set([
      ...directPaymentIds,
      ...Array.from(input.modificationRefundAmountsByPaymentId.keys()),
    ])
  );
  if (paymentIds.length === 0) {
    return {
      matchedPayments: 0,
      updatedPayments: 0,
    };
  }

  const payments = await prisma.payment.findMany({
    where: {
      id: {
        in: paymentIds,
      },
    },
    select: {
      id: true,
      amountCents: true,
      refundedAmountCents: true,
      status: true,
      // F5 (#1353): Stripe payments get a raise-only ledger floor below.
      source: true,
    },
  });
  if (payments.length === 0) {
    return {
      matchedPayments: 0,
      updatedPayments: 0,
    };
  }

  const [directRefundLinks, modificationAllocationLinks] = await Promise.all([
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: {
          in: paymentIds,
        },
        xeroObjectType: "CREDIT_NOTE",
        role: {
          in: ["REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"],
        },
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
        metadata: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        localModel: "Payment",
        localId: {
          in: paymentIds,
        },
        xeroObjectType: "ALLOCATION",
        role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
        active: true,
      },
      select: {
        localId: true,
        xeroObjectId: true,
        metadata: true,
      },
    }),
  ]);

  const existingModificationCreditNoteIds = Array.from(
    new Set(
      modificationAllocationLinks
        .map((link) => getCreditNoteIdFromAllocationMetadata(link.metadata))
        .filter(
          (creditNoteId): creditNoteId is string =>
            Boolean(creditNoteId) && creditNoteId !== input.creditNoteId
        )
    )
  );
  const validModificationCreditNoteIds = new Set<string>();

  if (existingModificationCreditNoteIds.length > 0) {
    const modificationCreditNotes = await prisma.xeroObjectLink.findMany({
      where: {
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        xeroObjectId: {
          in: existingModificationCreditNoteIds,
        },
        active: true,
      },
      select: {
        xeroObjectId: true,
        metadata: true,
      },
    });

    for (const link of modificationCreditNotes) {
      if (isIncludedRefundCreditNoteStatus(getJsonRecord(link.metadata)?.status)) {
        validModificationCreditNoteIds.add(link.xeroObjectId);
      }
    }
  }

  const directRefundCentsByPaymentId = new Map<string, Map<string, number>>();
  for (const link of directRefundLinks) {
    if (link.xeroObjectId === input.creditNoteId) {
      continue;
    }

    const contributionCents = getRefundContributionCentsFromCreditNoteMetadata(
      link.metadata
    );
    if (contributionCents === null) {
      continue;
    }

    const paymentRefunds =
      directRefundCentsByPaymentId.get(link.localId) ?? new Map<string, number>();
    paymentRefunds.set(link.xeroObjectId, contributionCents);
    directRefundCentsByPaymentId.set(link.localId, paymentRefunds);
  }

  const modificationRefundCentsByPaymentId = new Map<string, Map<string, number>>();
  for (const link of modificationAllocationLinks) {
    const creditNoteId = getCreditNoteIdFromAllocationMetadata(link.metadata);
    if (!creditNoteId || creditNoteId === input.creditNoteId) {
      continue;
    }
    if (!validModificationCreditNoteIds.has(creditNoteId)) {
      continue;
    }

    const contributionCents = getAmountCentsFromAllocationMetadata(link.metadata);
    if (contributionCents === null) {
      continue;
    }

    const paymentRefunds =
      modificationRefundCentsByPaymentId.get(link.localId) ??
      new Map<string, number>();
    paymentRefunds.set(link.xeroObjectId, contributionCents);
    modificationRefundCentsByPaymentId.set(link.localId, paymentRefunds);
  }

  const includesCurrentCreditNoteContribution = isIncludedRefundCreditNoteStatus(
    input.creditNote.status
  );
  const currentCreditNoteAmountCents = includesCurrentCreditNoteContribution
    ? getCreditNoteAmountCents(input.creditNote)
    : null;
  const currentDirectRefundPaymentId =
    currentCreditNoteAmountCents !== null && directPaymentIds.length === 1
      ? directPaymentIds[0]
      : null;

  if (currentCreditNoteAmountCents !== null && directPaymentIds.length > 1) {
    logger.warn(
      {
        creditNoteId: input.creditNoteId,
        matchedPayments: directPaymentIds.length,
      },
      "Skipping direct refunded-payment repair contribution because the Xero credit note resolved to multiple local payments"
    );
  }

  let updatedPayments = 0;

  for (const payment of payments) {
    const directRefundTotalCents = Array.from(
      directRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);
    const modificationRefundTotalCents = Array.from(
      modificationRefundCentsByPaymentId.get(payment.id)?.values() ?? []
    ).reduce((sum, amountCents) => sum + amountCents, 0);

    const currentDirectRefundContributionCents =
      currentCreditNoteAmountCents !== null &&
      currentDirectRefundPaymentId === payment.id
        ? currentCreditNoteAmountCents
        : 0;
    const currentModificationRefundContributionCents =
      includesCurrentCreditNoteContribution
        ? input.modificationRefundAmountsByPaymentId.get(payment.id) ?? 0
        : 0;

    const rawRefundedTotalCents =
      directRefundTotalCents +
      modificationRefundTotalCents +
      currentDirectRefundContributionCents +
      currentModificationRefundContributionCents;
    const nextRefundedTotalCents = Math.min(
      Math.max(rawRefundedTotalCents, 0),
      payment.amountCents
    );

    if (rawRefundedTotalCents > payment.amountCents) {
      logger.warn(
        {
          creditNoteId: input.creditNoteId,
          paymentId: payment.id,
          paymentAmountCents: payment.amountCents,
          rawRefundedTotalCents,
        },
        "Clamping refunded payment state because the derived Xero refund total exceeded the local payment amount"
      );
    }

    // F5 (#1353): for source=STRIPE the local refund ledger is Stripe-truth
    // (written by processed refunds and the recovery machinery) — the repair
    // may RAISE it from Xero-derived totals but must never LOWER it. A lower
    // Xero-derived total means either a refund-delta credit note is missing
    // in Xero (the F4 class this floor stops self-masking: the
    // missing-credit-note detector compares against refundedAmountCents) or
    // an operator voided a refund note in Xero for money Stripe has already
    // paid out. Both are Xero-side divergences to surface, not local-ledger
    // corruption to apply — so keep the ledger, log, and raise the deduped
    // Xero sync alert. Non-Stripe payments (Internet Banking) keep the
    // existing treat-Xero-as-authoritative behaviour: Xero IS their payment
    // rail.
    const isStripePayment = payment.source === PaymentSource.STRIPE;
    let effectiveRefundedTotalCents = nextRefundedTotalCents;
    if (
      isStripePayment &&
      nextRefundedTotalCents < payment.refundedAmountCents
    ) {
      logger.warn(
        {
          creditNoteId: input.creditNoteId,
          paymentId: payment.id,
          localRefundedAmountCents: payment.refundedAmountCents,
          xeroDerivedRefundedTotalCents: nextRefundedTotalCents,
        },
        "Xero-derived refund total is below the local Stripe refund ledger; keeping the local ledger (raise-only floor)"
      );
      await notifyXeroSyncError({
        errorType: "refund-ledger-divergence",
        operation: `inbound-credit-note-repair:${input.creditNoteId}`,
        errorMessage: `Xero-derived refund total (${nextRefundedTotalCents}c) for payment ${payment.id} is below the local Stripe refund ledger (${payment.refundedAmountCents}c). The local ledger was kept (raise-only floor, #1353). Likely causes: a missing refund-delta credit note in Xero, or a refund credit note voided in Xero after Stripe paid the refund out.`,
      });
      effectiveRefundedTotalCents = payment.refundedAmountCents;
    }

    let nextStatus = getNextRefundedPaymentStatus(
      payment.status,
      payment.amountCents,
      effectiveRefundedTotalCents
    );
    if (
      isStripePayment &&
      nextStatus === PaymentStatus.SUCCEEDED &&
      (payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED)
    ) {
      // F5 (#1353): never un-refund a Stripe payment from Xero-derived data.
      nextStatus = null;
    }
    const updates: {
      refundedAmountCents?: number;
      status?: PaymentStatus;
    } = {};

    if (payment.refundedAmountCents !== effectiveRefundedTotalCents) {
      updates.refundedAmountCents = effectiveRefundedTotalCents;
    }
    if (nextStatus && payment.status !== nextStatus) {
      updates.status = nextStatus;
    }

    if (Object.keys(updates).length === 0) {
      continue;
    }

    await prisma.payment.update({
      where: {
        id: payment.id,
      },
      data: updates,
    });
    updatedPayments += 1;
  }

  return {
    matchedPayments: payments.length,
    updatedPayments,
  };
}

export async function resolveAccountCreditPaymentsFromMemberCredits(creditNoteId: string) {
  const credits = await prisma.memberCredit.findMany({
    where: {
      xeroCreditNoteId: creditNoteId,
      type: CreditType.CANCELLATION_REFUND,
      sourceBookingId: {
        not: null,
      },
    },
    select: {
      sourceBookingId: true,
    },
  });

  const bookingIds = Array.from(
    new Set(
      credits
        .map((credit) => credit.sourceBookingId)
        .filter((bookingId): bookingId is string => Boolean(bookingId))
    )
  );

  if (bookingIds.length === 0) {
    return [];
  }

  return prisma.payment.findMany({
    where: {
      bookingId: {
        in: bookingIds,
      },
    },
    select: {
      id: true,
      bookingId: true,
    },
  });
}

export async function repairAccountCreditAllocationBusinessState(
  creditNoteId: string,
  allocationTargets: AccountCreditAllocationTarget[]
): Promise<AccountCreditAllocationRepairResult> {
  if (allocationTargets.length === 0) {
    return {
      matchedPayments: 0,
      createdAppliedCredits: 0,
      updatedAppliedCredits: 0,
      updatedAppliedPayments: 0,
      skippedAllocations: 0,
    };
  }

  let matchedPayments = 0;
  let createdAppliedCredits = 0;
  let updatedAppliedCredits = 0;
  let updatedAppliedPayments = 0;
  let skippedAllocations = 0;

  for (const target of allocationTargets) {
    const linkedPaymentIds = (
      await findActiveXeroObjectLinks("INVOICE", target.invoiceId)
    )
      .filter((link) => link.localModel === "Payment")
      .map((link) => link.localId);
    const paymentWhere = [
      {
        xeroInvoiceId: target.invoiceId,
      },
      ...(linkedPaymentIds.length > 0
        ? [
            {
              id: {
                in: linkedPaymentIds,
              },
            },
          ]
        : []),
    ];
    const paymentCandidates = await prisma.payment.findMany({
      where: {
        OR: paymentWhere,
      },
      select: {
        id: true,
        bookingId: true,
        amountCents: true,
        creditAppliedCents: true,
        booking: {
          select: {
            memberId: true,
          },
        },
      },
    });

    if (paymentCandidates.length !== 1) {
      skippedAllocations += 1;
      logger.warn(
        {
          creditNoteId,
          invoiceId: target.invoiceId,
          matchedPayments: paymentCandidates.length,
        },
        "Skipping account-credit allocation repair because the allocated invoice did not resolve to exactly one local payment"
      );
      continue;
    }

    matchedPayments += 1;
    const payment = paymentCandidates[0];
    const expectedAmountCents = -target.amountCents;
    const expectedDescription = buildBookingAppliedCreditDescription(
      payment.bookingId
    );
    // Serialize each payment's applied-credit repair on the shared reconcile
    // advisory lock so the existing-credit read, the create/link, the aggregate,
    // and the creditAppliedCents write commit atomically. Without the lock two
    // concurrent credit-note events for one payment can interleave and
    // transiently under-set creditAppliedCents; the clamp keeps the applied
    // total within the payment amount (invariant (b),(d), #1234). DB-only work:
    // no external Xero call runs inside this transaction.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const existingAppliedCredits = await tx.memberCredit.findMany({
        where: {
          memberId: payment.booking.memberId,
          appliedToBookingId: payment.bookingId,
          type: CreditType.BOOKING_APPLIED,
          OR: [
            {
              xeroCreditNoteId: creditNoteId,
            },
            {
              xeroCreditNoteId: null,
              amountCents: expectedAmountCents,
            },
          ],
        },
        select: {
          id: true,
          amountCents: true,
          description: true,
          xeroCreditNoteId: true,
        },
      });

      const linkedAppliedCredits = existingAppliedCredits.filter(
        (credit) => credit.xeroCreditNoteId === creditNoteId
      );

      if (linkedAppliedCredits.length === 1) {
        const appliedCredit = linkedAppliedCredits[0];
        const updates: {
          amountCents?: number;
          description?: string;
        } = {};

        if (appliedCredit.amountCents !== expectedAmountCents) {
          updates.amountCents = expectedAmountCents;
        }
        if (appliedCredit.description !== expectedDescription) {
          updates.description = expectedDescription;
        }

        if (Object.keys(updates).length > 0) {
          await tx.memberCredit.update({
            where: {
              id: appliedCredit.id,
            },
            data: updates,
          });
          updatedAppliedCredits += 1;
        }
      } else if (linkedAppliedCredits.length > 1) {
        skippedAllocations += 1;
        logger.warn(
          {
            creditNoteId,
            invoiceId: target.invoiceId,
            bookingId: payment.bookingId,
            appliedCredits: linkedAppliedCredits.length,
          },
          "Skipping account-credit allocation repair because multiple local applied-credit rows already point at this Xero credit note"
        );
      } else {
        const unlinkedExactCredits = existingAppliedCredits.filter(
          (credit) =>
            credit.xeroCreditNoteId === null &&
            credit.amountCents === expectedAmountCents
        );

        if (unlinkedExactCredits.length === 1) {
          await tx.memberCredit.update({
            where: {
              id: unlinkedExactCredits[0].id,
            },
            data: {
              xeroCreditNoteId: creditNoteId,
              description: expectedDescription,
            },
          });
          updatedAppliedCredits += 1;
        } else if (unlinkedExactCredits.length > 1) {
          skippedAllocations += 1;
          logger.warn(
            {
              creditNoteId,
              invoiceId: target.invoiceId,
              bookingId: payment.bookingId,
              appliedCredits: unlinkedExactCredits.length,
            },
            "Skipping account-credit allocation repair because multiple matching unlinked applied-credit rows exist locally"
          );
        } else {
          await tx.memberCredit.create({
            data: {
              memberId: payment.booking.memberId,
              amountCents: expectedAmountCents,
              type: CreditType.BOOKING_APPLIED,
              description: expectedDescription,
              appliedToBookingId: payment.bookingId,
              xeroCreditNoteId: creditNoteId,
            },
          });
          createdAppliedCredits += 1;
        }
      }

      const aggregate = await tx.memberCredit.aggregate({
        where: {
          memberId: payment.booking.memberId,
          appliedToBookingId: payment.bookingId,
          type: CreditType.BOOKING_APPLIED,
        },
        _sum: {
          amountCents: true,
        },
      });
      const appliedCreditTotalCents = Math.min(
        Math.max(-(aggregate._sum.amountCents ?? 0), 0),
        payment.amountCents
      );

      // Compare against the payment's current creditAppliedCents read under the
      // lock; the pre-loop snapshot can be stale, so the write only fires on a
      // real change against the freshly-aggregated (and clamped) total.
      const freshPayment = await tx.payment.findUnique({
        where: {
          id: payment.id,
        },
        select: {
          creditAppliedCents: true,
        },
      });

      if (
        freshPayment &&
        freshPayment.creditAppliedCents !== appliedCreditTotalCents
      ) {
        await tx.payment.update({
          where: {
            id: payment.id,
          },
          data: {
            creditAppliedCents: appliedCreditTotalCents,
          },
        });
        updatedAppliedPayments += 1;
      }
    });
  }

  return {
    matchedPayments,
    createdAppliedCredits,
    updatedAppliedCredits,
    updatedAppliedPayments,
    skippedAllocations,
  };
}
