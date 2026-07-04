// Booking modification boundary (issue #1138). The former single-file module
// was split into three cohesive modules and this file is now a pure barrel,
// so everything importable from "@/lib/booking-modify" is unchanged:
// - booking-modify-validation: edit-eligibility validation + shared loaded types
// - booking-modify-plan: the in-transaction modify pipeline (guest plan,
//   repricing, promo changes, change fee, guest/chore writes)
// - booking-modify-settlement: settlement handoff and lifecycle transitions

export {
  assertBookingModifiable,
  assertBookingNotQuotePriced,
  BookingModifyReviewJustificationRequiredError,
  hasOutstandingAdditionalPayment,
  isBookingFullyPaidForGuestNameEdits,
  isQuotePricedBooking,
  QUOTE_PRICED_EDIT_BLOCK_MESSAGE,
  resolveTargetDates,
  type BatchModifyInput,
  type BookingModificationSettlementMethod,
  type LoadedBookingForModify,
  type LoadedPromoRedemption,
  type ResolvedTargetDates,
} from "@/lib/booking-modify-validation";
export {
  applyChoreCleanup,
  applyGuestChanges,
  applyPromoCodeChanges,
  calculateModificationChangeFee,
  calculateModifiedPricing,
  loadActiveSeasonRates,
  lockedNightPricesForGuest,
  prepareGuestPlan,
  resolveGuestNameUpdates,
  type GuestPlan,
  type PricingResult,
  type PromoChangeResult,
  type ResolvedGuestNameUpdate,
} from "@/lib/booking-modify-plan";
export {
  applyLifecycleTransitions,
  applyPaymentAdjustments,
  calculateModificationSettlementOptions,
  type BookingModificationSettlementOptions,
  type LifecycleTransitionResult,
  type PaymentAdjustmentResult,
} from "@/lib/booking-modify-settlement";
