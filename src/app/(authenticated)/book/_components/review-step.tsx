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
import { PromoCodeInput, type PromoResult } from "@/components/promo-code-input";
import { TimePicker } from "@/components/time-picker";
import { CreditCard, Landmark } from "lucide-react";
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
              <span className="text-gray-500">Lodge:</span>{" "}
              <span className="font-medium">{selectedLodge.name}</span>
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-gray-500">Check-in:</span>{" "}
              <span className="font-medium">
                {checkIn!.toLocaleDateString("en-NZ", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Check-out:</span>{" "}
              <span className="font-medium">
                {checkOut!.toLocaleDateString("en-NZ", {
                  weekday: "short", day: "numeric", month: "short", year: "numeric",
                })}
              </span>
            </div>
            <div>
              <span className="text-gray-500">Nights:</span>{" "}
              <span className="font-medium">{nights}</span>
            </div>
            <div>
              <span className="text-gray-500">Guests:</span>{" "}
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
                <div key={i} className="flex justify-between gap-3 text-sm py-1">
                  <span>
                    {g.firstName} {g.lastName} ({g.ageTier}, {g.isMember ? "Member" : "Non-member"})
                    {perGuestDatesEnabled && stayStart && stayEnd && (
                      <span className="block text-xs text-gray-500">
                        Date In {stayStart} - Date Out {stayEnd} ({guestNights} night{guestNights === 1 ? "" : "s"})
                      </span>
                    )}
                  </span>
                  <span className="font-medium">
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
              <div className={`flex justify-between text-sm ${appliedPromo.promoAdjustmentCents > 0 ? "text-orange-700" : "text-green-600"}`}>
                <span>
                  {appliedPromo.workPartyEvent
                    ? `Working bee discount (${appliedPromo.workPartyEvent.name})`
                    : `Promo adjustment (${appliedPromo.code})`}
                </span>
                <span>{formatSignedCents(appliedPromo.promoAdjustmentCents)}</span>
              </div>
              {appliedCreditCents > 0 && (
                <div className="flex justify-between text-sm text-green-600">
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
                  <div className="flex justify-between text-sm text-green-600">
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
            <div className="rounded-md border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
              <span className="font-medium">Group trip</span> —{" "}
              {groupPaymentMode === "EACH_PAYS_OWN"
                ? "each person pays their own beds."
                : "you pay for everyone and settle one combined bill."}{" "}
              You&apos;ll get a shareable join link after confirming.
            </div>
          )}

          {availableCreditCents > 0 && (
            <div className="rounded-md bg-green-50 border border-green-200 p-4 mt-2">
              <p className="text-sm text-green-800 mb-2">
                You have <strong>{formatCents(availableCreditCents)}</strong> in account credit
              </p>
              <label className="flex items-center gap-2 text-sm text-green-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useCredit}
                  onChange={(e) => setUseCredit(e.target.checked)}
                  className="rounded border-green-300"
                />
                Apply credit to this booking
              </label>
              {useCredit && remainingToPay === 0 && (
                <p className="mt-2 text-sm font-medium text-green-700">
                  Credit covers entire booking — no card payment needed
                </p>
              )}
            </div>
          )}

          {showPaymentMethodChoice && (
            <div className="space-y-3 rounded-md border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-900">Payment method</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setPaymentMethod("stripe")}
                  className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                    paymentMethod === "stripe"
                      ? "border-blue-500 bg-blue-50 text-blue-950"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                  }`}
                >
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    <span className="block font-medium">Card</span>
                    <span className="block text-xs opacity-80">
                      {cardPaymentDescription}
                    </span>
                  </span>
                </button>
                {internetBankingEnabled ? (
                  <button
                    type="button"
                    onClick={() => setPaymentMethod("internet_banking")}
                    className={`flex min-h-20 items-start gap-3 rounded-md border p-3 text-left text-sm ${
                      paymentMethod === "internet_banking"
                        ? "border-blue-500 bg-blue-50 text-blue-950"
                        : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                    }`}
                  >
                    <Landmark className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">Internet Banking</span>
                      <span className="block text-xs opacity-80">
                        {internetBankingPaymentDescription}
                        {internetBankingHoldSummary ? (
                          <span className="mt-1 block">{internetBankingHoldSummary}</span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                ) : internetBankingUnavailableReason ? (
                  <div className="flex min-h-20 items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-left text-sm text-slate-500">
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
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4">
              <Label htmlFor="review-justification" className="text-amber-900">
                Reason for booking without an adult guest (required)
              </Label>
              <p className="text-sm text-amber-900">
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
                    <p className="text-sm text-red-600">{workPartyError}</p>
                  )}
                </div>
              )}
            </div>
          )}
          {workPartyClearedNotice && (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
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
          <div className="rounded-md bg-yellow-50 p-4 text-sm text-yellow-800">
            <strong>Note:</strong> This booking includes non-member guests.
            {guests.some((g) => g.isMember)
              ? " By default your own place is booked and paid for now to hold it, while your non-member guests are held provisionally as a linked booking \u2014 no beds are reserved for them until they are confirmed and paid for closer to check-in. Members have priority if the lodge fills up."
              : " Your booking is held provisionally until closer to check-in. Members have priority \u2014 no beds are reserved until your booking is confirmed and paid."}
          </div>
          {guests.some((g) => g.isMember) && (
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

      <div className="flex justify-between">
        <Button variant="outline" onClick={() => setStep("guests")}>
          Back
        </Button>
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={handleSaveAsDraft}
            disabled={savingDraft || submitting}
          >
            {savingDraft ? "Saving draft..." : "Save as Draft"}
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || savingDraft} size="lg">
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
