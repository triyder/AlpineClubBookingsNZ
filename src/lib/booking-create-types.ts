/**
 * Shared types and structured errors for the booking-creation service.
 *
 * These declarations were extracted verbatim from `booking-create.ts` so the
 * orchestrators and the promo/guest helper modules can share them without a
 * circular dependency. `@/lib/booking-create` re-exports the public members so
 * existing importers keep working unchanged.
 */
import { AgeTier, BookingStatus, type Booking, type BookingGuest } from "@prisma/client";
import type { GroupDiscountConfig } from "@/lib/pricing";
import type { BookingPaymentMethod } from "@/lib/booking-payment-methods";
import type { InternetBankingPaymentSettingsValues } from "@/lib/internet-banking-settings";
import type { GuestNightInput } from "@/lib/booking-guest-stay-ranges";

export type BookingWithGuests = Booking & { guests: BookingGuest[] };

export interface BookingGuestInput {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: Date | null;
  stayEnd?: Date | null;
  // Explicit included nights (issue #713). When present, the guest stays
  // exactly these nights (which may be non-contiguous) and stayStart/stayEnd
  // are the derived min/max envelope.
  nights?: ReadonlyArray<GuestNightInput> | null;
}

interface BaseInput {
  effectiveMemberId: string;
  isOnBehalf: boolean;
  sessionUserId: string;
  checkIn: Date;
  checkOut: Date;
  guests: BookingGuestInput[];
  notes?: string;
  promoCodeStr?: string;
  promoGuestIndexes?: number[];
  // Work party (working bee) event the booker is attending. Mutually
  // exclusive with promoCodeStr; resolves to the event's internal promo.
  workPartyEventId?: string;
  expectedArrivalTime?: string;
  requestedRoomId?: string;
  // "Only book if my guests can come": cancel the whole booking instead of the
  // default partial bump when non-member guests lose capacity.
  cancelIfGuestsBumped?: boolean;
  groupDiscount?: GroupDiscountConfig;
  memberReviewJustification?: string;
  // Group booking (shareable join code): when set, the created (primary)
  // booking is linked to the organiser's booking via parentBookingId, so a
  // joiner's stay is grouped with the event. Existing callers leave this
  // undefined, which persists null exactly as before.
  parentBookingId?: string;
  // Group booking, ORGANISER_PAYS mode: when true the created booking is
  // flagged organiserSettled, so the joiner is never billed for it and cannot
  // pay it themselves; the organiser settles the group total. Only the
  // group-join path sets this; everyone else leaves it undefined (false).
  organiserSettled?: boolean;
}

export type DraftBookingInput = BaseInput;

export interface ConfirmedBookingInput extends BaseInput {
  applyCreditCents?: number;
  status: BookingStatus;
  shouldBePending: boolean;
  holdDays: number;
  paymentMethod?: BookingPaymentMethod;
  internetBankingSettings?: InternetBankingPaymentSettingsValues;
  /**
   * When set, the group roster row is written in the same transaction as the
   * child booking (#1039 item 2): a concurrent duplicate join aborts here and
   * rolls the booking back instead of leaving an orphaned booking or a
   * duplicate roster row. A row left by a cancelled/bumped join is reused.
   */
  groupJoin?: { groupBookingId: string; joinerMemberId: string };
}

/**
 * Thrown inside the booking transaction when the joiner already has a live
 * join in this group; the group route maps it to a 409 and the transaction
 * rollback discards the duplicate child booking.
 */
export class GroupJoinConflictError extends Error {
  constructor() {
    super("You have already joined this group");
    this.name = "GroupJoinConflictError";
  }
}

export type ConfirmedBookingOutcome =
  | { type: "created"; booking: BookingWithGuests; bumpedBookingIds: string[]; isZeroDollarConfirmed: boolean }
  | { type: "capacityExceeded"; fullNights: string[] };

export type WaitlistedBookingInput = BaseInput;

export interface WaitlistedBookingResult {
  booking: BookingWithGuests;
  position: number;
}

/**
 * Thrown when promo code validation fails inside the booking transaction.
 * The route handler turns this into a 400 response.
 */
export class BookingPromoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingPromoError";
  }
}

/**
 * Thrown when the no-adult rule trips for a member-created booking but the
 * caller did not supply `memberReviewJustification`. Members must explain
 * why they are booking minors without an adult before the booking can be
 * persisted for admin review.
 */
export class BookingReviewJustificationRequiredError extends Error {
  constructor() {
    super(
      "A reason is required when booking minors without an adult guest. Please explain so an admin can review."
    );
    this.name = "BookingReviewJustificationRequiredError";
  }
}
