// Shared types, Prisma selects, and finding/action code tables for the
// booking-vs-Xero repair tool. Extracted verbatim from xero-booking-repair.ts
// as the leaf module of the #1208 item-2 split; the entry re-exports the public
// subset. Import xero source modules directly (no @/lib/xero facade, #1208).
import { Prisma } from "@prisma/client";
import type { XeroOperationRetryMeta } from "@/lib/xero-operation-retry";

export const XERO_BOOKING_REPAIR_FINDING_CODES = [
  "MISSING_PRIMARY_INVOICE",
  "STALE_PRIMARY_INVOICE_DETAILS",
  "CANCELLED_BOOKING_OPEN_INVOICE",
  "MISSING_SUPPLEMENTARY_INVOICE",
  "MISSING_MODIFICATION_CREDIT_NOTE",
  "MISSING_CREDIT_NOTE_ALLOCATION",
  "MISSING_ACCOUNT_CREDIT_NOTE",
  "CANCELLED_IN_FLIGHT_PAYMENT",
  "LATE_CAPTURE_AFTER_CANCELLATION",
  "BLOCKED_BY_XERO_OPERATION",
  "XERO_LINK_MISMATCH",
  "XERO_AMOUNT_MISMATCH",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type XeroBookingRepairFindingCode =
  (typeof XERO_BOOKING_REPAIR_FINDING_CODES)[number];

export const XERO_BOOKING_REPAIR_ACTION_TYPES = [
  "QUEUE_PRIMARY_INVOICE",
  "QUEUE_PRIMARY_INVOICE_UPDATE",
  "QUEUE_SUPPLEMENTARY_INVOICE",
  "QUEUE_MODIFICATION_CREDIT_NOTE",
  "QUEUE_ACCOUNT_CREDIT_NOTE",
  "QUEUE_REFUND_CREDIT_NOTE",
  "QUEUE_CREDIT_NOTE_ALLOCATION",
  "REQUEUE_XERO_OPERATION",
  "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
  "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
  "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
  "SYNC_BOOKING_SCOPED_LINK",
  "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
  "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
  "MARK_MANUAL_REVIEW",
] as const;

export type XeroBookingRepairActionType =
  (typeof XERO_BOOKING_REPAIR_ACTION_TYPES)[number];

export type XeroBookingRepairSeverity =
  | "critical"
  | "warning"
  | "info"
  | "manual_review";

export type XeroBookingRepairActionStatus =
  | "planned"
  | "applied"
  | "queued"
  | "processed"
  | "skipped"
  | "failed"
  | "manual_review";

export interface BookingXeroRepairScope {
  bookingId?: string;
  from?: Date;
  to?: Date;
  all?: boolean;
}

export interface BookingXeroRepairAction {
  key: string;
  bookingId: string;
  type: XeroBookingRepairActionType;
  description: string;
  safeToAutoApply: boolean;
  payload: Record<string, unknown>;
  status: XeroBookingRepairActionStatus;
  resultMessage: string | null;
}

export interface BookingXeroRepairFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairBookingSummary {
  bookingId: string;
  bookingStatus: string;
  paymentId: string | null;
  paymentStatus: string | null;
  memberId: string;
  memberName: string;
  memberEmail: string;
  checkIn: string;
  checkOut: string;
  findings: BookingXeroRepairFinding[];
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairPassReport {
  pass: number;
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  bookings: BookingXeroRepairBookingSummary[];
}

export interface BookingXeroRepairRunSummary {
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  manualReviewBookings: string[];
  xeroConnectionAvailable: boolean;
}

export interface BookingXeroRepairRunReport {
  mode: "dry-run" | "apply";
  scope: {
    bookingId: string | null;
    from: string | null;
    to: string | null;
    all: boolean;
  };
  startedAt: string;
  completedAt: string;
  passes: BookingXeroRepairPassReport[];
  summary: BookingXeroRepairRunSummary;
}

export const bookingRepairSelect = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  memberId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  totalPriceCents: true,
  discountCents: true,
  finalPriceCents: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  payment: {
    select: {
      id: true,
      amountCents: true,
      stripePaymentIntentId: true,
      stripePaymentMethodId: true,
      stripeCustomerId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      status: true,
      refundedAmountCents: true,
      changeFeeCents: true,
      additionalPaymentIntentId: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      xeroRefundCreditNoteId: true,
      creditAppliedCents: true,
      transactions: {
        orderBy: {
          createdAt: "asc",
        },
        select: {
          id: true,
          paymentId: true,
          kind: true,
          source: true,
          stripePaymentIntentId: true,
          amountCents: true,
          refundedAmountCents: true,
          status: true,
          paymentMethodId: true,
          reason: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      createdAt: true,
      updatedAt: true,
    },
  },
  modifications: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      bookingId: true,
      modificationType: true,
      previousData: true,
      newData: true,
      priceDiffCents: true,
      changeFeeCents: true,
      createdAt: true,
    },
  },
  creditsFromCancellation: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      amountCents: true,
      type: true,
      description: true,
      xeroCreditNoteId: true,
      createdAt: true,
    },
  },
});

export type BookingRepairRecord = Prisma.BookingGetPayload<{
  select: typeof bookingRepairSelect;
}>;

export type BookingModificationRecord = BookingRepairRecord["modifications"][number];
export type BookingPaymentRecord = NonNullable<BookingRepairRecord["payment"]>;

export const xeroObjectLinkSelect = Prisma.validator<Prisma.XeroObjectLinkSelect>()({
  id: true,
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  role: true,
  active: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
});

export type XeroObjectLinkRecord = Prisma.XeroObjectLinkGetPayload<{
  select: typeof xeroObjectLinkSelect;
}>;

export const xeroOperationSelect = Prisma.validator<Prisma.XeroSyncOperationSelect>()({
  id: true,
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  status: true,
  idempotencyKey: true,
  correlationKey: true,
  queueType: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  requestPayload: true,
  responsePayload: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  createdByMemberId: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  replayable: true,
});

export type XeroOperationRecord = Prisma.XeroSyncOperationGetPayload<{
  select: typeof xeroOperationSelect;
}>;

export interface ResolvedLocalObject {
  objectId: string;
  objectNumber: string | null;
  objectUrl: string | null;
  source: "field" | "link" | "operation";
  link: XeroObjectLinkRecord | null;
  operation: XeroOperationRecord | null;
  conflicts: string[];
}

export interface BlockingOperationMatch {
  operation: XeroOperationRecord;
  retryMeta: XeroOperationRetryMeta;
}

export interface XeroAmountEvidence {
  source: "link" | "operation-request" | "operation-response";
  amountCents: number;
  linkId?: string;
  operationId?: string;
}

export interface BookingClassificationContext {
  booking: BookingRepairRecord;
  paymentLinks: XeroObjectLinkRecord[];
  bookingLinks: XeroObjectLinkRecord[];
  modificationLinksById: Map<string, XeroObjectLinkRecord[]>;
  paymentOperations: XeroOperationRecord[];
  bookingOperations: XeroOperationRecord[];
  modificationOperationsById: Map<string, XeroOperationRecord[]>;
}

export interface MutableFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actionKeys: string[];
}
