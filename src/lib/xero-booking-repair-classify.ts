// Per-booking finding/action classification for the booking-vs-Xero repair
// tool. classifyBookingContext is a single sequential function that mutates its
// own local findings/actionMap accumulators; it is kept whole (one function,
// one module) because splitting its inner blocks would edit the function body,
// which #1208 item 2 forbids (behavior-preserving move only). It therefore
// exceeds the ~700-LOC soft cap. Extracted verbatim from xero-booking-repair.ts.
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import type {
  BookingClassificationContext,
  BookingXeroRepairAction,
  BookingXeroRepairBookingSummary,
  MutableFinding,
} from "./xero-booking-repair-types";
import {
  getCapturedRepairTransactions,
  getOutstandingCapturedRefundAmountCents,
  getOutstandingRepairTransactions,
} from "./xero-booking-repair-payments";
import {
  getBlockingOperation,
  isStuckOperation,
  resolveObjectFromCandidates,
} from "./xero-booking-repair-object-resolution";
import {
  getCancellationCreditAmountCents,
  getCashCancellationRefundCandidateCents,
  getKnownModificationRefundTotalCents,
  getLatestDateChangingModification,
  getModificationNetAmountCents,
  getUnpaidCancellationClearingAmountCents,
  hasSuccessfulPrimaryInvoiceCreateAfter,
  hasSuccessfulPrimaryInvoiceUpdateAfter,
} from "./xero-booking-repair-analysis";
import {
  addAction,
  addFinding,
  addXeroAmountMismatchFinding,
  buildBookingSummary,
  buildLinkRepairAction,
  buildManualReviewAction,
  buildRetryAction,
} from "./xero-booking-repair-findings";
import { toDateOnly } from "./xero-booking-repair-utils";

export function classifyBookingContext(
  context: BookingClassificationContext
): BookingXeroRepairBookingSummary {
  const { booking } = context;
  const findings: MutableFinding[] = [];
  const actionMap = new Map<string, BookingXeroRepairAction>();
  const payment = booking.payment;
  const capturedPaymentTransactions = getCapturedRepairTransactions(payment);
  const outstandingPaymentTransactions = getOutstandingRepairTransactions(payment);
  const outstandingCapturedRefundAmountCents =
    getOutstandingCapturedRefundAmountCents(payment);
  const paymentLinks = context.paymentLinks;
  const paymentOperations = context.paymentOperations;
  const bookingLinks = context.bookingLinks;
  const bookingOperations = context.bookingOperations;
  const primaryInvoice = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroInvoiceId,
        fieldObjectNumber: payment.xeroInvoiceNumber,
        fieldObjectUrl: payment.xeroInvoiceId
          ? buildXeroInvoiceUrl(payment.xeroInvoiceId)
          : null,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      })
    : null;

  if (payment && primaryInvoice?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Primary invoice references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Primary invoice references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        primaryInvoiceId: primaryInvoice.objectId,
        conflictingInvoiceIds: primaryInvoice.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && primaryInvoice && !payment.xeroInvoiceId) {
    const action = addAction(actionMap, {
      key: `payment-field:primary-invoice:${payment.id}:${primaryInvoice.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
      description: "Backfill payment.xeroInvoiceId from an existing Xero invoice link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        xeroInvoiceNumber: primaryInvoice.objectNumber,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "The primary Xero invoice exists, but the payment record is missing its invoice id.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        source: primaryInvoice.source,
      },
      actionKeys: [action.key],
    });
  }

  if (
    payment &&
    payment.xeroInvoiceId &&
    (!primaryInvoice?.link || primaryInvoice.objectId === payment.xeroInvoiceId)
  ) {
    const hasPrimaryInvoiceLink = paymentLinks.some(
      (link) =>
        link.xeroObjectType === "INVOICE" &&
        link.role === "PRIMARY_INVOICE" &&
        link.xeroObjectId === payment.xeroInvoiceId
    );
    if (!hasPrimaryInvoiceLink) {
      const action = addAction(actionMap, {
        key: `payment-link:primary-invoice:${payment.id}:${payment.xeroInvoiceId}`,
        bookingId: booking.id,
        type: "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
        description: "Backfill the missing PRIMARY_INVOICE Xero link from the payment record.",
        safeToAutoApply: true,
        payload: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
          xeroInvoiceNumber: payment.xeroInvoiceNumber,
        },
      });
      addFinding(findings, {
        code: "XERO_LINK_MISMATCH",
        severity: "warning",
        summary: "The payment record points at a Xero invoice, but the PRIMARY_INVOICE link is missing.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
        },
        actionKeys: [action.key],
      });
    }
  }

  if (booking.status === "PAID") {
    if (payment && !primaryInvoice) {
      const blockingOperation = getBlockingOperation(
        paymentOperations,
        "INVOICE",
        "CREATE"
      );
      if (blockingOperation && blockingOperation.retryMeta.supported) {
        const action = addAction(
          actionMap,
          buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
        );
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary: "A failed or partial Xero booking invoice operation is blocking the primary invoice.",
          safeToAutoApply: true,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
            lastErrorCode: blockingOperation.operation.lastErrorCode,
            lastErrorMessage: blockingOperation.operation.lastErrorMessage,
          },
          actionKeys: [action.key],
        });
      } else if (blockingOperation) {
        const summary = isStuckOperation(blockingOperation.operation)
          ? "A pending or running Xero booking invoice operation looks stuck."
          : "A Xero booking invoice operation is already pending or running.";
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary,
          safeToAutoApply: false,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
          },
          actionKeys: [],
        });
      } else {
        const action = addAction(actionMap, {
          key: `queue:primary-invoice:${booking.id}`,
          bookingId: booking.id,
          type: "QUEUE_PRIMARY_INVOICE",
          description: "Queue a missing primary Xero invoice for this confirmed or paid booking.",
          safeToAutoApply: true,
          payload: {
            bookingId: booking.id,
          },
        });
        addFinding(findings, {
          code: "MISSING_PRIMARY_INVOICE",
          severity: "critical",
          summary: "The booking is confirmed or paid locally, but no primary Xero invoice can be resolved.",
          safeToAutoApply: true,
          details: {
            paymentId: payment.id,
          },
          actionKeys: [action.key],
        });
      }
    }
  }

  const latestDateChangingModification = getLatestDateChangingModification(booking);
  if (
    payment &&
    primaryInvoice &&
    latestDateChangingModification &&
    !hasSuccessfulPrimaryInvoiceCreateAfter(
      paymentOperations,
      latestDateChangingModification.createdAt
    ) &&
    !hasSuccessfulPrimaryInvoiceUpdateAfter(
      paymentOperations,
      latestDateChangingModification.createdAt
    )
  ) {
    const updateOperationsAfterLatestDateChange = paymentOperations.filter(
      (operation) =>
        operation.entityType === "INVOICE" &&
        operation.operationType === "UPDATE" &&
        operation.createdAt >= latestDateChangingModification.createdAt
    );
    const blockingOperation = getBlockingOperation(
      updateOperationsAfterLatestDateChange,
      "INVOICE",
      "UPDATE"
    );

    if (blockingOperation && blockingOperation.retryMeta.supported) {
      const action = addAction(
        actionMap,
        buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
      );
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary: "A failed or partial Xero primary invoice update is blocking current booking date narration.",
        safeToAutoApply: true,
        details: {
          modificationId: latestDateChangingModification.id,
          operationId: blockingOperation.operation.id,
          operationStatus: blockingOperation.operation.status,
        },
        actionKeys: [action.key],
      });
    } else if (blockingOperation) {
      const summary = isStuckOperation(blockingOperation.operation)
        ? "A pending or running Xero primary invoice update looks stuck."
        : "A Xero primary invoice update is already pending or running.";
      addFinding(findings, {
        code: "BLOCKED_BY_XERO_OPERATION",
        severity: "warning",
        summary,
        safeToAutoApply: false,
        details: {
          modificationId: latestDateChangingModification.id,
          operationId: blockingOperation.operation.id,
          operationStatus: blockingOperation.operation.status,
        },
        actionKeys: [],
      });
    } else {
      const action = addAction(actionMap, {
        key: `queue:primary-invoice-update:${booking.id}:${latestDateChangingModification.id}`,
        bookingId: booking.id,
        type: "QUEUE_PRIMARY_INVOICE_UPDATE",
        description: "Queue an update to refresh the primary Xero invoice date fields and line narration.",
        safeToAutoApply: true,
        payload: {
          bookingId: booking.id,
          bookingModificationId: latestDateChangingModification.id,
          xeroInvoiceId: primaryInvoice.objectId,
        },
      });
      addFinding(findings, {
        code: "STALE_PRIMARY_INVOICE_DETAILS",
        severity: "warning",
        summary: "The booking dates changed after the primary Xero invoice was created, but no invoice update has succeeded.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          modificationId: latestDateChangingModification.id,
          xeroInvoiceId: primaryInvoice.objectId,
          currentCheckIn: toDateOnly(booking.checkIn),
          currentCheckOut: toDateOnly(booking.checkOut),
        },
        actionKeys: [action.key],
      });
    }
  }

  for (const modification of booking.modifications) {
    const modificationLinks = context.modificationLinksById.get(modification.id) ?? [];
    const modificationOperations =
      context.modificationOperationsById.get(modification.id) ?? [];
    const netAmountCents = getModificationNetAmountCents(modification);

    if (netAmountCents > 0 && primaryInvoice) {
      const supplementaryInvoice = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      });

      if (!supplementaryInvoice) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "INVOICE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero supplementary invoice operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:supplementary-invoice:${modification.id}`,
            bookingId: booking.id,
            type: "QUEUE_SUPPLEMENTARY_INVOICE",
            description: "Queue the missing Xero supplementary invoice for a price-increase booking modification.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              bookingModificationId: modification.id,
              priceDiffCents: Math.max(modification.priceDiffCents, 0),
              changeFeeCents: modification.changeFeeCents,
            },
          });
          addFinding(findings, {
            code: "MISSING_SUPPLEMENTARY_INVOICE",
            severity: "critical",
            summary: "A booking modification increased the amount owing, but no supplementary Xero invoice exists.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              netAmountCents,
              priceDiffCents: modification.priceDiffCents,
              changeFeeCents: modification.changeFeeCents,
            },
            actionKeys: [action.key],
          });
        }
      } else {
        addXeroAmountMismatchFinding({
          findings,
          actionMap,
          bookingId: booking.id,
          expectedAmountCents: netAmountCents,
          resolved: supplementaryInvoice,
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "INVOICE",
          role: "SUPPLEMENTARY_INVOICE",
          entityType: "INVOICE",
          operationType: "CREATE",
          summary:
            "The supplementary invoice amount evidence does not match the local booking modification amount.",
          details: {
            modificationId: modification.id,
            netAmountCents,
            priceDiffCents: modification.priceDiffCents,
            changeFeeCents: modification.changeFeeCents,
          },
        });

        if (!supplementaryInvoice.link && supplementaryInvoice.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "INVOICE",
              xeroObjectId: supplementaryInvoice.objectId,
              xeroObjectNumber: supplementaryInvoice.objectNumber,
              xeroObjectUrl: supplementaryInvoice.objectUrl,
              role: "SUPPLEMENTARY_INVOICE",
              description:
                "Backfill the SUPPLEMENTARY_INVOICE link from a completed Xero operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary: "A supplementary invoice exists in operation history, but its booking-modification link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              xeroInvoiceId: supplementaryInvoice.objectId,
            },
            actionKeys: [action.key],
          });
        }
      }
    }

    if (netAmountCents < 0 && primaryInvoice) {
      const modificationCreditNote = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!modificationCreditNote) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero modification credit note operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:mod-credit-note:${modification.id}`,
            bookingId: booking.id,
            type: "QUEUE_MODIFICATION_CREDIT_NOTE",
            description:
              "Queue the missing Xero modification credit note for a price-decrease booking modification.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              bookingModificationId: modification.id,
              refundAmountCents: Math.abs(netAmountCents),
            },
          });
          addFinding(findings, {
            code: "MISSING_MODIFICATION_CREDIT_NOTE",
            severity: "critical",
            summary: "A booking modification reduced the amount owing, but no modification Xero credit note exists.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              refundAmountCents: Math.abs(netAmountCents),
              priceDiffCents: modification.priceDiffCents,
              changeFeeCents: modification.changeFeeCents,
            },
            actionKeys: [action.key],
          });
        }
      } else {
        addXeroAmountMismatchFinding({
          findings,
          actionMap,
          bookingId: booking.id,
          expectedAmountCents: Math.abs(netAmountCents),
          resolved: modificationCreditNote,
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "CREDIT_NOTE",
          role: "MODIFICATION_CREDIT_NOTE",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          summary:
            "The modification credit-note amount evidence does not match the local booking modification refund amount.",
          details: {
            modificationId: modification.id,
            refundAmountCents: Math.abs(netAmountCents),
            priceDiffCents: modification.priceDiffCents,
            changeFeeCents: modification.changeFeeCents,
          },
        });

        if (!modificationCreditNote.link && modificationCreditNote.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: modificationCreditNote.objectId,
              xeroObjectNumber: modificationCreditNote.objectNumber,
              xeroObjectUrl: modificationCreditNote.objectUrl,
              role: "MODIFICATION_CREDIT_NOTE",
              description:
                "Backfill the MODIFICATION_CREDIT_NOTE link from a completed Xero operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary:
              "A modification credit note exists in operation history, but its booking-modification link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              xeroCreditNoteId: modificationCreditNote.objectId,
            },
            actionKeys: [action.key],
          });
        }

        const allocation = resolveObjectFromCandidates({
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });

        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            modificationOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking a modification credit note allocation.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:allocation:${modification.id}:${modificationCreditNote.objectId}`,
              bookingId: booking.id,
              type: "QUEUE_CREDIT_NOTE_ALLOCATION",
              description:
                "Queue the missing Xero allocation linking the modification credit note back to the primary invoice.",
              safeToAutoApply: true,
              payload: {
                localModel: "BookingModification",
                localId: modification.id,
                creditNoteId: modificationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: Math.abs(netAmountCents),
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            });
            addFinding(findings, {
              code: "MISSING_CREDIT_NOTE_ALLOCATION",
              severity: "critical",
              summary: "A modification credit note exists, but it is not allocated back to the original invoice.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                creditNoteId: modificationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: Math.abs(netAmountCents),
              },
              actionKeys: [action.key],
            });
          }
        } else {
          addXeroAmountMismatchFinding({
            findings,
            actionMap,
            bookingId: booking.id,
            expectedAmountCents: Math.abs(netAmountCents),
            resolved: allocation,
            links: modificationLinks,
            operations: modificationOperations,
            xeroObjectType: "ALLOCATION",
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            entityType: "ALLOCATION",
            operationType: "ALLOCATE",
            summary:
              "The modification credit-note allocation amount evidence does not match the local booking modification refund amount.",
            details: {
              modificationId: modification.id,
              creditNoteId: modificationCreditNote.objectId,
              invoiceId: primaryInvoice.objectId,
              amountCents: Math.abs(netAmountCents),
            },
          });

          if (!allocation.link && allocation.operation) {
            const action = addAction(
              actionMap,
              buildLinkRepairAction({
                bookingId: booking.id,
                localModel: "BookingModification",
                localId: modification.id,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: allocation.objectId,
                xeroObjectNumber: allocation.objectNumber,
                xeroObjectUrl: allocation.objectUrl,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
                description:
                  "Backfill the missing MODIFICATION_CREDIT_NOTE_ALLOCATION link from a completed Xero allocation operation.",
              })
            );
            addFinding(findings, {
              code: "XERO_LINK_MISMATCH",
              severity: "warning",
              summary: "A modification credit-note allocation exists in operation history, but its link is missing.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                allocationId: allocation.objectId,
              },
              actionKeys: [action.key],
            });
          }
        }
      }
    }
  }

  const refundCreditNote = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroRefundCreditNoteId,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      })
    : null;

  if (payment && refundCreditNote?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Refund credit note references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Refund credit note references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
        conflictingCreditNoteIds: refundCreditNote.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && refundCreditNote && !payment.xeroRefundCreditNoteId) {
    const action = addAction(actionMap, {
      key: `payment-field:refund-credit-note:${payment.id}:${refundCreditNote.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
      description:
        "Backfill payment.xeroRefundCreditNoteId from an existing refund credit note link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroRefundCreditNoteId: refundCreditNote.objectId,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "A refund credit note exists, but the payment record is missing its xeroRefundCreditNoteId.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && refundCreditNote) {
    const refundAmountCents = getCashCancellationRefundCandidateCents(booking);
    if (refundAmountCents !== null && refundAmountCents > 0) {
      addXeroAmountMismatchFinding({
        findings,
        actionMap,
        bookingId: booking.id,
        expectedAmountCents: refundAmountCents,
        resolved: refundCreditNote,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        summary:
          "The refund credit-note amount evidence does not match the local cash refund amount.",
        details: {
          paymentId: payment.id,
          refundAmountCents,
          paymentRefundedAmountCents: payment.refundedAmountCents,
        },
      });
    }
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    capturedPaymentTransactions.length === 0 &&
    primaryInvoice
  ) {
    const clearingAmountCents = getUnpaidCancellationClearingAmountCents(booking);
    if (clearingAmountCents > 0) {
      const cancellationCreditNote = resolveObjectFromCandidates({
        links: bookingLinks,
        operations: bookingOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!cancellationCreditNote) {
        const blockingOperation = getBlockingOperation(
          bookingOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero cancellation credit note operation is blocking an unpaid cancelled booking from clearing its invoice.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:cancelled-open-invoice:${booking.id}`,
            bookingId: booking.id,
            type: "QUEUE_MODIFICATION_CREDIT_NOTE",
            description:
              "Queue the missing Xero credit note needed to clear the original invoice for a cancelled unpaid booking.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              refundAmountCents: clearingAmountCents,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The booking was cancelled before payment succeeded, but the original Xero invoice still needs a clearing credit note.",
            safeToAutoApply: true,
            details: {
              paymentId: payment?.id ?? null,
              invoiceId: primaryInvoice.objectId,
              clearingAmountCents,
            },
            actionKeys: [action.key],
          });
        }
      } else {
        const allocation = resolveObjectFromCandidates({
          links: bookingLinks,
          operations: bookingOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });
        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            bookingOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking an unpaid cancelled booking from clearing its invoice.",
              safeToAutoApply: true,
              details: {
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:cancelled-allocation:${booking.id}:${cancellationCreditNote.objectId}`,
              bookingId: booking.id,
              type: "QUEUE_CREDIT_NOTE_ALLOCATION",
              description:
                "Queue the missing Xero allocation that clears the original invoice for a cancelled unpaid booking.",
              safeToAutoApply: true,
              payload: {
                localModel: "Booking",
                localId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: clearingAmountCents,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            });
            addFinding(findings, {
              code: "MISSING_CREDIT_NOTE_ALLOCATION",
              severity: "critical",
              summary:
                "The cancellation credit note exists, but it is not allocated back to the cancelled booking invoice.",
              safeToAutoApply: true,
              details: {
                bookingId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: clearingAmountCents,
              },
              actionKeys: [action.key],
            });
          }
        }
      }
    }
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    outstandingPaymentTransactions.length > 0
  ) {
    const outstandingPaymentIntentIds = [
      ...new Set(
        outstandingPaymentTransactions.map(
          (transaction) => transaction.stripePaymentIntentId
        )
      ),
    ];
    const action = addAction(actionMap, {
      key: `cancel-inflight-payment:${booking.id}:${payment.id}`,
      bookingId: booking.id,
      type: "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
      description:
        "Verify and cancel any in-flight Stripe payment intents, then mark only those uncaptured local transactions as failed.",
      safeToAutoApply: true,
      payload: {
        bookingId: booking.id,
        paymentId: payment.id,
        paymentIntentIds: outstandingPaymentIntentIds,
      },
    });
    addFinding(findings, {
      code: "CANCELLED_IN_FLIGHT_PAYMENT",
      severity: "critical",
      summary:
        "The booking is cancelled, but one or more Stripe payment intents are still pending or processing.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        paymentIntentIds: outstandingPaymentIntentIds,
        outstandingTransactions: outstandingPaymentTransactions.map((transaction) => ({
          kind: transaction.kind,
          paymentIntentId: transaction.stripePaymentIntentId,
          status: transaction.status,
          amountCents: transaction.amountCents,
          refundedAmountCents: transaction.refundedAmountCents,
        })),
      },
      actionKeys: [action.key],
    });
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    outstandingCapturedRefundAmountCents > 0
  ) {
    const lateCaptureTransactions = capturedPaymentTransactions.filter(
      (transaction) => transaction.amountCents > transaction.refundedAmountCents
    );
    const refundAmountCents = outstandingCapturedRefundAmountCents;
    const action = addAction(actionMap, {
      key: `late-capture-refund:${booking.id}:${payment.id}:${refundAmountCents}`,
      bookingId: booking.id,
      type: "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
      description:
        "Automatically refund the late Stripe capture for a cancelled booking and queue the matching Xero refund note if needed.",
      safeToAutoApply: true,
      payload: {
        bookingId: booking.id,
        paymentId: payment.id,
        refundAmountCents,
        invoiceId: primaryInvoice?.objectId ?? null,
      },
    });
    addFinding(findings, {
      code: "LATE_CAPTURE_AFTER_CANCELLATION",
      severity: "critical",
      summary:
        "Stripe captured payment after the booking had already been cancelled.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        paymentIntentIds: lateCaptureTransactions.map(
          (transaction) => transaction.stripePaymentIntentId
        ),
        refundAmountCents,
        invoiceId: primaryInvoice?.objectId ?? null,
      },
      actionKeys: [action.key],
    });
  }

  if (booking.status === "CANCELLED" && payment) {
    const cancellationCreditAmountCents = getCancellationCreditAmountCents(booking);
    if (cancellationCreditAmountCents > 0) {
      const accountCreditNote = resolveObjectFromCandidates({
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "ACCOUNT_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!accountCreditNote) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero account-credit note operation is blocking a cancelled booking credit refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:account-credit-note:${payment.id}:${cancellationCreditAmountCents}`,
            bookingId: booking.id,
            type: "QUEUE_ACCOUNT_CREDIT_NOTE",
            description:
              "Queue the missing unapplied Xero account-credit note for a cancelled booking credit refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
          });
          addFinding(findings, {
            code: "MISSING_ACCOUNT_CREDIT_NOTE",
            severity: "critical",
            summary:
              "The cancelled booking created local account credit, but no corresponding unapplied Xero credit note exists.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }

    if (primaryInvoice && !refundCreditNote) {
      const cashCancellationRefundCents = getCashCancellationRefundCandidateCents(booking);
      if (cashCancellationRefundCents === null) {
        const action = addAction(
          actionMap,
          buildManualReviewAction(
            booking.id,
            "Cancelled booking has refunded cash locally, but the missing Xero cancellation credit note amount is ambiguous."
          )
        );
        addFinding(findings, {
          code: "MANUAL_REVIEW_REQUIRED",
          severity: "manual_review",
          summary:
            "The booking appears to have a cash cancellation refund, but the missing Xero refund note amount cannot be derived safely from local history.",
          safeToAutoApply: false,
          details: {
            paymentId: payment.id,
            refundedAmountCents: payment.refundedAmountCents,
            knownModificationRefundCents: getKnownModificationRefundTotalCents(booking),
          },
          actionKeys: [action.key],
        });
      } else if (cashCancellationRefundCents > 0) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero refund credit note operation is blocking a cancelled booking cash refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:refund-credit-note:${payment.id}:${cashCancellationRefundCents}`,
            bookingId: booking.id,
            type: "QUEUE_REFUND_CREDIT_NOTE",
            description:
              "Queue the missing Xero refund credit note for a cancelled booking cash refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The cancelled booking refunded cash locally, but no Xero refund credit note can be resolved for that cancellation.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }
  }

  return buildBookingSummary(context, findings, actionMap);
}
