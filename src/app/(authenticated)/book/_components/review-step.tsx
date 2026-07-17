"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import { type GuestData } from "@/components/guest-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type LodgeOption } from "@/components/lodge-select";
import { sumDeferredGuestPortionCents } from "@/lib/deferred-guest-portion";
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import { CheckCircle2, CreditCard, Landmark } from "lucide-react";
import type {
  AvailablePromoCode,
  BookingPaymentMethod,
  GroupPaymentMode,
  PriceQuote,
  RoomOption,
  WorkPartyEvent,
} from "./types";

function formatCents(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatSignedCents(cents: number) {
  const prefix = cents > 0 ? "+" : "-";
  return `${prefix}${formatCents(Math.abs(cents))}`;
}

export function ReviewStep({
  checkIn,
  checkOut,
  nights,
  guests,
  priceQuote,
  lodges,
  lodgeId,
  selectedLodge,
  reviewGuestPayload,
  bookingDateStrings,
  perGuestDatesEnabled,
  appliedPromo,
  setAppliedPromo,
  availableCreditCents,
  appliedCreditCents,
  remainingToPay,
  useCredit,
  setUseCredit,
  groupTrip,
  groupBookingsEnabled,
  groupPaymentMode,
  showPaymentMethodChoice,
  paymentMethod,
  setPaymentMethod,
  internetBankingEnabled,
  internetBankingUnavailableReason,
  internetBankingHoldSummary,
  cardPaymentDescription,
  internetBankingPaymentDescription,
  internetBankingUnavailableCopy,
  notes,
  setNotes,
  requiresAdminReviewLocal,
  memberReviewJustification,
  setMemberReviewJustification,
  expectedArrivalTime,
  setExpectedArrivalTime,
  roomRequestEnabled,
  roomOptions,
  requestedRoomId,
  setRequestedRoomId,
  activeWorkPartyEvents,
  attendingWorkParty,
  setAttendingWorkParty,
  selectedWorkPartyEventId,
  setSelectedWorkPartyEventId,
  workPartyError,
  setWorkPartyError,
  workPartyClearedNotice,
  setWorkPartyClearedNotice,
  availablePromoCodes,
  promoCodesEnabled,
  prefillPromoCode,
  setPrefillPromoCode,
  cancelIfGuestsBumped,
  setCancelIfGuestsBumped,
  setStep,
  handleSaveAsDraft,
  handleSubmit,
  submitting,
  savingDraft,
}: {
  checkIn: Date | null;
  checkOut: Date | null;
  nights: number;
  guests: GuestData[];
  priceQuote: PriceQuote;
  lodges: LodgeOption[];
  lodgeId: string | null;
  selectedLodge: LodgeOption | null;
  reviewGuestPayload: GuestData[];
  bookingDateStrings: { checkIn: string; checkOut: string } | null;
  perGuestDatesEnabled: boolean;
  appliedPromo: PromoResult | null;
  setAppliedPromo: Dispatch<SetStateAction<PromoResult | null>>;
  availableCreditCents: number;
  appliedCreditCents: number;
  remainingToPay: number;
  useCredit: boolean;
  setUseCredit: (value: boolean) => void;
  groupTrip: boolean;
  groupBookingsEnabled: boolean;
  groupPaymentMode: GroupPaymentMode;
  showPaymentMethodChoice: boolean;
  paymentMethod: BookingPaymentMethod;
  setPaymentMethod: (method: BookingPaymentMethod) => void;
  internetBankingEnabled: boolean;
  internetBankingUnavailableReason: string | null;
  internetBankingHoldSummary: string | null;
  cardPaymentDescription: string;
  internetBankingPaymentDescription: string;
  internetBankingUnavailableCopy: string;
  notes: string;
  setNotes: (value: string) => void;
  requiresAdminReviewLocal: boolean;
  memberReviewJustification: string;
  setMemberReviewJustification: (value: string) => void;
  expectedArrivalTime: string | null;
  setExpectedArrivalTime: (value: string | null) => void;
  roomRequestEnabled: boolean;
  roomOptions: RoomOption[];
  requestedRoomId: string | null;
  setRequestedRoomId: (value: string | null) => void;
  activeWorkPartyEvents: WorkPartyEvent[];
  attendingWorkParty: boolean;
  setAttendingWorkParty: (value: boolean) => void;
  selectedWorkPartyEventId: string | null;
  setSelectedWorkPartyEventId: (value: string | null) => void;
  workPartyError: string;
  setWorkPartyError: (value: string) => void;
  workPartyClearedNotice: string | null;
  setWorkPartyClearedNotice: (value: string | null) => void;
  availablePromoCodes: AvailablePromoCode[];
  promoCodesEnabled: boolean;
  prefillPromoCode: string | undefined;
  setPrefillPromoCode: (value: string | undefined) => void;
  cancelIfGuestsBumped: boolean;
  setCancelIfGuestsBumped: (value: boolean) => void;
  setStep: (step: "dates" | "guests" | "review" | "pay") => void;
  handleSaveAsDraft: () => void | Promise<void>;
  handleSubmit: () => void | Promise<void>;
  submitting: boolean;
  savingDraft: boolean;
}) {
  const provisionalHoldWillBeCreated =
    guests.some((guest) => !guest.isMember) &&
    priceQuote.nonMemberHoldDecision?.shouldBePending === true;
  // A split happens only when the party mixes member and non-member guests: the
  // member places are charged and held up front (the parent), the non-member
  // places become a provisional linked booking (the child). An all-non-member
  // provisional party is a single hold, not a split.
  //
  // The server split predicate (booking-create.ts) ALSO requires that the
  // member did NOT tick "Only book if my guests can come" (cancelIfGuestsBumped
  // — that flag keeps the whole party as one provisional PENDING booking,
  // nothing charged up front) and that the booking is NOT held for admin review
  // (the whole party waits in AWAITING_REVIEW, nothing split or charged). If we
  // showed the split banner in either case the "today you only pay for the
  // member places / we'll take the guest portion later" claims would be false —
  // so gate on both here to keep the banner honest.
  const hasMemberGuest = guests.some((guest) => guest.isMember);
  const willSplit =
    provisionalHoldWillBeCreated &&
    hasMemberGuest &&
    !cancelIfGuestsBumped &&
    !requiresAdminReviewLocal;

  // Names of the guests that become provisional (the non-members). Sourced from
  // the review payload so the copy can name exactly who is held provisionally.
  const provisionalGuestNames = reviewGuestPayload
    .filter((guest) => !guest.isMember)
    .map((guest) => `${guest.firstName} ${guest.lastName}`.trim())
    .filter(Boolean);
  // The provisional (guest-portion) sub-amount that is charged later rather than
  // today. The SERVER computes this (priceQuote.deferredGuestPortionCents) by
  // pricing the non-member subset through the SAME helper booking-create charges
  // the split child with (#2003) — so this banner's "about $X" equals the real
  // deferred charge even under a group discount, where the non-member subset can
  // fall under minGroupSize while the whole party meets it. We do NOT sum the
  // whole-party non-member rows here: those rows are group-discounted on the
  // whole party and would UNDER-QUOTE the subset that is actually charged. The
  // client sum is only a fallback for an old cached quote predating the field.
  const provisionalGuestPortionCents =
    priceQuote.deferredGuestPortionCents ??
    sumDeferredGuestPortionCents(priceQuote.guests);
  const holdDays = priceQuote.nonMemberHoldDecision?.holdDays ?? 0;
  // Approximate hold deadline: check-in minus the policy's hold-days. The exact
  // hold-until timestamp is set server-side; this is the member-facing "around
  // when" so the copy can say when the second charge is attempted.
  const holdDeadline =
    checkIn && holdDays > 0
      ? new Date(checkIn.getTime() - holdDays * 24 * 60 * 60 * 1000)
      : null;
  const holdDeadlineLabel = holdDeadline
    ? holdDeadline.toLocaleDateString("en-NZ", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  useEffect(() => {
    if (!provisionalHoldWillBeCreated && cancelIfGuestsBumped) {
      setCancelIfGuestsBumped(false);
    }
  }, [cancelIfGuestsBumped, provisionalHoldWillBeCreated, setCancelIfGuestsBumped]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Booking Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {lodges.length > 1 && selectedLodge ? (
            <div className="text-sm">
              <span className="text-muted-foreground">Lodge:</span>{" "}
              <span className="font-medium">{selectedLodge.name}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Check-in:</span>{" "}
              <span className="font-medium">
                {checkIn!.toLocaleDateString("en-NZ", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Check-out:</span>{" "}
              <span className="font-medium">
                {checkOut!.toLocaleDateString("en-NZ", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Nights:</span>{" "}
              <span className="font-medium">{nights}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Guests:</span>{" "}
              <span className="font-medium">{guests.length}</span>
            </div>
          </div>

          <div className="border-t pt-4">
            <h2 className="font-medium mb-2 text-base">Guests</h2>
            {reviewGuestPayload.map((g, i) => {
              const stayStart = g.stayStart ?? bookingDateStrings?.checkIn;
              const stayEnd = g.stayEnd ?? bookingDateStrings?.checkOut;
              const guestNights = priceQuote.guests[i]?.nights ?? 0;

              return (
                <div key={i} className="flex flex-col gap-1 py-1 text-sm sm:flex-row sm:justify-between sm:gap-3">
                  <span>
                    {g.firstName} {g.lastName} ({g.ageTier}, {g.isMember ? "Member" : "Non-member"})
                    {perGuestDatesEnabled && stayStart && stayEnd && (
                      <span className="block text-xs text-muted-foreground">
                        Date In {stayStart} - Date Out {stayEnd} ({guestNights} night{guestNights === 1 ? "" : "s"})
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-medium tabular-nums">
                    {formatCents(priceQuote.guests[i]?.priceCents || 0)}
                  </span>
                </div>
              );
            })}
          </div>

          {appliedPromo && appliedPromo.promoAdjustmentCents !== 0 ? (
            <>
              <div className="border-t pt-4 flex justify-between text-sm">
                <span>Subtotal</span>
                <span>{formatCents(priceQuote.totalPriceCents)}</span>
              </div>
              <div className={`flex justify-between gap-3 text-sm ${appliedPromo.promoAdjustmentCents > 0 ? "text-warning" : "text-success"}`}>
                <span>
                  {appliedPromo.workPartyEvent
                    ? `Working bee discount (${appliedPromo.workPartyEvent.name})`
                    : `Promo adjustment (${appliedPromo.code})`}
                </span>
                <span>{formatSignedCents(appliedPromo.promoAdjustmentCents)}</span>
              </div>
              {appliedCreditCents > 0 && (
                <div className="flex justify-between gap-3 text-sm text-success">
                  <span>Account credit</span>
                  <span>-{formatCents(appliedCreditCents)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-lg">
                <span>{appliedCreditCents > 0 ? "Remaining to pay" : "Total"}</span>
                <span>{formatCents(remainingToPay)}</span>
              </div>
            </>
          ) : (
            <>
              {appliedCreditCents > 0 && (
                <>
                  <div className="border-t pt-4 flex justify-between text-sm">
                    <span>Subtotal</span>
                    <span>{formatCents(priceQuote.totalPriceCents)}</span>
                  </div>
                  <div className="flex justify-between gap-3 text-sm text-success">
                    <span>Account credit</span>
                    <span>-{formatCents(appliedCreditCents)}</span>
                  </div>
                </>
              )}
              <div className={`${appliedCreditCents === 0 ? "border-t pt-4 " : ""}flex justify-between font-bold text-lg`}>
                <span>{appliedCreditCents > 0 ? "Remaining to pay" : "Total"}</span>
                <span>{formatCents(remainingToPay)}</span>
              </div>
            </>
          )}

          {groupTrip && groupBookingsEnabled && (
            <div className="rounded-md border border-info/20 bg-info-muted p-4 text-sm text-info">
              <span className="font-medium">Group trip</span> —{" "}
              {groupPaymentMode === "EACH_PAYS_OWN"
                ? "each person pays their own beds."
                : "you pay for everyone and settle one combined bill."}{" "}
              You&apos;ll get a shareable join link after confirming.
            </div>
          )}

          {availableCreditCents > 0 && (
            <div className="mt-2 rounded-md border border-success/20 bg-success-muted p-4">
              <p className="mb-2 text-sm text-success">
                You have <strong>{formatCents(availableCreditCents)}</strong> in account credit
              </p>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-success">
                <input
                  type="checkbox"
                  checked={useCredit}
                  onChange={(e) => setUseCredit(e.target.checked)}
                  className="rounded border-success/40"
                />
                Apply credit to this booking
              </label>
              {useCredit && remainingToPay === 0 && (
                <p className="mt-2 text-sm font-medium text-success">
                  Credit covers entire booking — no card payment needed
                </p>
              )}
            </div>
          )}

          {showPaymentMethodChoice && (
            <div className="space-y-3 rounded-md border border-border p-4">
              <p className="text-sm font-medium text-foreground">Payment method</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setPaymentMethod("stripe")}
                  aria-pressed={paymentMethod === "stripe"}
                  className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                    paymentMethod === "stripe"
                      ? "border-info bg-info-muted text-info"
                      : "border-border bg-card text-card-foreground hover:border-foreground"
                  }`}
                >
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block font-medium">Card</span>
                    <span className="block text-xs">
                      {cardPaymentDescription}
                    </span>
                    {paymentMethod === "stripe" ? (
                      <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold">
                        <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                        Selected
                      </span>
                    ) : null}
                  </span>
                </button>
                {internetBankingEnabled ? (
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("internet_banking")}
                    aria-pressed={paymentMethod === "internet_banking"}
                    className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                      paymentMethod === "internet_banking"
                        ? "border-info bg-info-muted text-info"
                        : "border-border bg-card text-card-foreground hover:border-foreground"
                    }`}
                  >
                    <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">Internet Banking</span>
                      <span className="block text-xs">
                        {internetBankingPaymentDescription}
                        {internetBankingHoldSummary ? (
                          <span className="mt-1 block">{internetBankingHoldSummary}</span>
                        ) : null}
                      </span>
                      {paymentMethod === "internet_banking" ? (
                        <span className="mt-1 inline-flex items-center gap-1 text-xs font-semibold">
                          <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
                          Selected
                        </span>
                      ) : null}
                    </span>
                  </button>
                ) : internetBankingUnavailableReason ? (
                  <div className="flex min-h-20 items-start gap-3 rounded-md border border-border bg-muted p-3 text-left text-sm text-muted-foreground">
                    <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">Internet Banking</span>
                      <span className="block text-xs">{internetBankingUnavailableCopy}</span>
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any special requirements..."
            />
          </div>
          {requiresAdminReviewLocal && (
            <div className="space-y-2 rounded-md border border-warning/20 bg-warning-muted p-4">
              <Label htmlFor="review-justification" className="text-warning">
                Reason for booking without an adult guest (required)
              </Label>
              <p className="text-sm text-warning">
                This booking includes minors but no adult. Please explain why so an
                admin can review. The booking will be held until an admin approves it,
                and payment cannot be taken until then.
              </p>
              <Textarea
                id="review-justification"
                value={memberReviewJustification}
                onChange={(e) => setMemberReviewJustification(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Explain why an adult is not on the booking..."
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="arrival-time">Expected Arrival Time (optional)</Label>
            <TimePicker
              value={expectedArrivalTime}
              onChange={setExpectedArrivalTime}
            />
          </div>
          {roomRequestEnabled && roomOptions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="requested-room">Preferred room (optional)</Label>
              <Select
                value={requestedRoomId ?? "none"}
                onValueChange={(value) =>
                  setRequestedRoomId(value === "none" ? null : value)
                }
              >
                <SelectTrigger id="requested-room">
                  <SelectValue placeholder="No preference" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No preference</SelectItem>
                  {roomOptions.map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name} ({room.bedCount} {room.bedCount === 1 ? "bed" : "beds"})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                We&apos;ll try to allocate your group to this room, but it
                isn&apos;t guaranteed if it&apos;s full.
              </p>
            </div>
          )}
          {activeWorkPartyEvents.length > 0 && (
            <div className="space-y-3 rounded-md border p-4">
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={attendingWorkParty}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setAttendingWorkParty(checked);
                    setWorkPartyError("");
                    setWorkPartyClearedNotice(null);
                    if (!checked) {
                      setSelectedWorkPartyEventId(null);
                      setAppliedPromo((current) =>
                        current?.workPartyEvent ? null : current
                      );
                    } else if (activeWorkPartyEvents.length === 1) {
                      setSelectedWorkPartyEventId(activeWorkPartyEvents[0].id);
                    }
                  }}
                  className="rounded border-input"
                  disabled={Boolean(appliedPromo && !appliedPromo.workPartyEvent)}
                />
                I am attending a working bee
              </label>
              {appliedPromo && !appliedPromo.workPartyEvent && (
                <p className="text-sm text-muted-foreground">
                  Remove your promo code to select a working bee event — a
                  booking can only use one discount.
                </p>
              )}
              {attendingWorkParty && (
                <div className="space-y-2">
                  {activeWorkPartyEvents.length > 1 && (
                    <select
                      aria-label="Working bee event"
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={selectedWorkPartyEventId ?? ""}
                      onChange={(e) =>
                        setSelectedWorkPartyEventId(e.target.value || null)
                      }
                    >
                      <option value="">Select an event…</option>
                      {activeWorkPartyEvents.map((event) => (
                        <option key={event.id} value={event.id}>
                          {event.name}
                          {event.lodgeName ? ` — held at ${event.lodgeName}` : ""}{" "}
                          ({event.startDate} – {event.endDate})
                        </option>
                      ))}
                    </select>
                  )}
                  {selectedWorkPartyEventId && (
                    (() => {
                      const event = activeWorkPartyEvents.find(
                        (e) => e.id === selectedWorkPartyEventId
                      );
                      if (!event) return null;
                      return (
                        <p className="text-sm text-muted-foreground">
                          {event.discountPercent}% discount on nights
                          between {event.startDate} and {event.endDate}
                          {event.description ? ` — ${event.description}` : ""}.
                        </p>
                      );
                    })()
                  )}
                  {workPartyError && (
                    <p className="text-sm text-danger">{workPartyError}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {workPartyClearedNotice && (
            <div className="rounded-md border border-warning/20 bg-warning-muted p-3 text-sm text-warning">
              &ldquo;{workPartyClearedNotice}&rdquo; no longer overlaps your
              selected dates, so the working bee discount has been
              cleared.
            </div>
          )}
          {availablePromoCodes.length > 0 && !appliedPromo && !attendingWorkParty && (
            <div className="app-callout-brand p-4">
              <p className="mb-2 text-sm font-medium text-foreground">
                You have promo codes available:
              </p>
              <div className="flex flex-wrap gap-2">
                {availablePromoCodes.map((pc) => (
                  <button
                    key={pc.code}
                    type="button"
                    onClick={() => setPrefillPromoCode(pc.code)}
                    className="app-chip-brand font-mono"
                  >
                    {pc.code}
                    {pc.description && (
                      <span className="font-sans font-normal text-brand-charcoal">
                        — {pc.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
          {promoCodesEnabled && (
            <PromoCodeInput
              checkIn={checkIn!}
              checkOut={checkOut!}
              guests={reviewGuestPayload}
              onPromoApplied={setAppliedPromo}
              appliedPromo={appliedPromo}
              lodgeId={lodgeId}
              prefillCode={prefillPromoCode}
              disabled={attendingWorkParty}
              disabledReason="A promo code cannot be combined with a working bee discount. Untick 'I am attending a working bee' to enter a code instead."
            />
          )}
        </CardContent>
      </Card>

      {provisionalHoldWillBeCreated && (
        <div className="space-y-3">
          {willSplit ? (
            <div className="space-y-2 rounded-md border border-warning/20 bg-warning-muted p-4 text-sm text-warning">
              <p>
                <strong>Your non-member guests are held provisionally.</strong>{" "}
                Because your stay is more than {holdDays} day
                {holdDays === 1 ? "" : "s"} away, member and non-member places
                are booked separately.
              </p>
              {provisionalGuestNames.length > 0 && (
                <p>
                  Held provisionally:{" "}
                  <strong>{provisionalGuestNames.join(", ")}</strong>. No bed is
                  reserved for them yet &mdash; members have priority if the
                  lodge fills up.
                </p>
              )}
              <p>
                <strong>
                  Today you only pay for the member places on this booking.
                </strong>{" "}
                Your non-member guests&apos; places (about{" "}
                <strong>{formatCents(provisionalGuestPortionCents)}</strong> at
                non-member rates) are not charged today.
              </p>
              <p>
                If beds are still available
                {holdDeadlineLabel ? ` around ${holdDeadlineLabel}` : ""}, we&apos;ll
                automatically take the non-member portion from your saved payment
                method and your guests are confirmed. If we can&apos;t take
                payment, we&apos;ll contact you to arrange it. If the lodge has
                filled with member bookings by then, that portion is not charged
                and those guests are bumped.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-warning/20 bg-warning-muted p-4 text-sm text-warning">
              <strong>Note:</strong> This booking includes non-member guests.
              Your booking is held provisionally until closer to check-in.
              Members have priority &mdash; no beds are reserved until your
              booking is confirmed and paid.
            </div>
          )}
          {hasMemberGuest && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={cancelIfGuestsBumped}
                onChange={(e) => setCancelIfGuestsBumped(e.target.checked)}
              />
              <span>
                <strong>Only book if my guests can come.</strong> Tick this
                and we&apos;ll keep your whole party together as a single
                provisional booking instead of booking your place now:{" "}
                <strong>no beds are held and nothing is charged up front</strong>
                , and we only confirm and take payment once your guests are
                confirmed closer to your stay.
              </span>
            </label>
          )}
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <Button variant="outline" onClick={() => setStep("guests")}>
          Back
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            variant="outline"
            onClick={handleSaveAsDraft}
            disabled={savingDraft || submitting}
            className="w-full sm:w-auto"
          >
            {savingDraft ? "Saving draft..." : "Save as Draft"}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || savingDraft}
            size="lg"
            className="w-full sm:w-auto"
          >
            {submitting
              ? "Creating booking..."
              : requiresAdminReviewLocal
                ? "Submit for Review"
                : remainingToPay > 0
                  ? "Continue to Payment"
                  : "Confirm Booking"}
          </Button>
        </div>
      </div>
    </div>
  );
}
