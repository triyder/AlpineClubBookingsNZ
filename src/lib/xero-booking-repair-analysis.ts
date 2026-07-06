// Booking-level analysis helpers (cancellation credit, modification amounts,
// refund candidates, member name) for the booking-vs-Xero repair tool.
// Extracted verbatim from xero-booking-repair.ts (#1208 item 2).
import { CreditType } from "@prisma/client";
import type {
  BookingModificationRecord,
  BookingRepairRecord,
  XeroOperationRecord,
} from "./xero-booking-repair-types";
import { readJsonRecord, readJsonString } from "./xero-booking-repair-utils";

export function buildMemberName(booking: BookingRepairRecord) {
  return `${booking.member.firstName} ${booking.member.lastName}`.trim();
}

function getCancellationCreditEntries(booking: BookingRepairRecord) {
  const bookingLabel = booking.id.slice(0, 8);
  return booking.creditsFromCancellation.filter(
    (credit) =>
      credit.type === CreditType.CANCELLATION_REFUND &&
      credit.description === `Cancellation refund for booking ${bookingLabel}`
  );
}

export function getCancellationCreditAmountCents(booking: BookingRepairRecord) {
  return getCancellationCreditEntries(booking).reduce(
    (sum, credit) => sum + credit.amountCents,
    0
  );
}

// Pick<> keeps this callable from the retry stack's slim modification select
// (#1356) — one shared definition of a modification's signed net.
export function getModificationNetAmountCents(
  modification: Pick<BookingModificationRecord, "priceDiffCents" | "changeFeeCents">
) {
  return modification.priceDiffCents + modification.changeFeeCents;
}

function modificationChangedBookingDates(modification: BookingModificationRecord) {
  if (modification.modificationType === "DATE_CHANGE") {
    return true;
  }

  const previousData = readJsonRecord(modification.previousData);
  const newData = readJsonRecord(modification.newData);
  if (!previousData || !newData) {
    return false;
  }

  const previousCheckIn = readJsonString(previousData.checkIn);
  const previousCheckOut = readJsonString(previousData.checkOut);
  const newCheckIn = readJsonString(newData.checkIn);
  const newCheckOut = readJsonString(newData.checkOut);

  return (
    Boolean(previousCheckIn && newCheckIn && previousCheckIn !== newCheckIn) ||
    Boolean(previousCheckOut && newCheckOut && previousCheckOut !== newCheckOut)
  );
}

export function getLatestDateChangingModification(booking: BookingRepairRecord) {
  return [...booking.modifications]
    .filter(modificationChangedBookingDates)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
}

export function hasSuccessfulPrimaryInvoiceUpdateAfter(
  operations: XeroOperationRecord[],
  changedAt: Date
) {
  return operations.some(
    (operation) =>
      operation.entityType === "INVOICE" &&
      operation.operationType === "UPDATE" &&
      ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
      operation.createdAt >= changedAt
  );
}

export function hasSuccessfulPrimaryInvoiceCreateAfter(
  operations: XeroOperationRecord[],
  changedAt: Date
) {
  return operations.some(
    (operation) =>
      operation.entityType === "INVOICE" &&
      operation.operationType === "CREATE" &&
      ["SUCCEEDED", "PARTIAL"].includes(operation.status) &&
      operation.createdAt >= changedAt
  );
}

export function getKnownModificationRefundTotalCents(booking: BookingRepairRecord) {
  return booking.modifications.reduce((sum, modification) => {
    const netAmount = getModificationNetAmountCents(modification);
    return netAmount < 0 ? sum + Math.abs(netAmount) : sum;
  }, 0);
}

export function getUnpaidCancellationClearingAmountCents(booking: BookingRepairRecord) {
  if (!booking.payment?.xeroInvoiceId) {
    return 0;
  }

  return Math.max(
    booking.payment.amountCents - booking.payment.refundedAmountCents,
    booking.finalPriceCents + booking.payment.changeFeeCents
  );
}

export function getCashCancellationRefundCandidateCents(booking: BookingRepairRecord) {
  if (!booking.payment) {
    return null;
  }

  if (getCancellationCreditAmountCents(booking) > 0) {
    return null;
  }

  const knownModificationRefundCents = getKnownModificationRefundTotalCents(booking);
  const candidate = booking.payment.refundedAmountCents - knownModificationRefundCents;
  if (candidate <= 0) {
    return 0;
  }

  if (knownModificationRefundCents > 0) {
    return null;
  }

  return candidate;
}
