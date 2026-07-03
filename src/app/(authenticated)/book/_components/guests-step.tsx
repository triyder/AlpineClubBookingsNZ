"use client";

import Link from "next/link";
import { GuestForm, type GuestData } from "@/components/guest-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatLocalDateOnly } from "@/lib/date-only";
import {
  getFamilyMemberBookingActionLabel,
  getFamilyMemberBookingBlockMessage,
} from "@/lib/family-booking";
import {
  PROFILE_FAMILY_GROUP_RETURN_TO_BOOK,
  type FamilyMember,
  type GroupPaymentMode,
  type PriceQuote,
} from "./types";

export function GuestsStep({
  checkIn,
  checkOut,
  nights,
  familyMembers,
  guests,
  lodgeCapacity,
  addFamilyMemberAsGuest,
  showInviteFamilyGroupMembersLink,
  handleGuestsChange,
  perGuestDatesEnabled,
  handlePerGuestDatesEnabledChange,
  multiDateRangesEnabled,
  handleMultiDateRangesEnabledChange,
  priceQuote,
  groupBookingsEnabled,
  groupTrip,
  setGroupTrip,
  groupPaymentMode,
  setGroupPaymentMode,
  setStep,
  handleGuestsDone,
  priceLoading,
}: {
  checkIn: Date | null;
  checkOut: Date | null;
  nights: number;
  familyMembers: FamilyMember[];
  guests: GuestData[];
  lodgeCapacity: number;
  addFamilyMemberAsGuest: (fm: FamilyMember) => void;
  showInviteFamilyGroupMembersLink: boolean;
  handleGuestsChange: (nextGuests: GuestData[]) => void;
  perGuestDatesEnabled: boolean;
  handlePerGuestDatesEnabledChange: (enabled: boolean) => void;
  multiDateRangesEnabled: boolean;
  handleMultiDateRangesEnabledChange: (enabled: boolean) => void;
  priceQuote: PriceQuote | null;
  groupBookingsEnabled: boolean;
  groupTrip: boolean;
  setGroupTrip: (value: boolean) => void;
  groupPaymentMode: GroupPaymentMode;
  setGroupPaymentMode: (mode: GroupPaymentMode) => void;
  setStep: (step: "dates" | "guests" | "review" | "pay") => void;
  handleGuestsDone: () => void | Promise<void>;
  priceLoading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Add Guests
          {checkIn && checkOut && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              {checkIn.toLocaleDateString("en-NZ")} - {checkOut.toLocaleDateString("en-NZ")} ({nights} night{nights !== 1 ? "s" : ""})
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {familyMembers.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Quick add family members</p>
            <div className="grid gap-2">
              {familyMembers.map((fm) => {
                const alreadyAdded = guests.some((g) => g.memberId === fm.id);
                const blocked = fm.canBeBooked === false;
                const label = fm.relationship === "self"
                  ? `${fm.firstName} ${fm.lastName} (You)`
                  : `${fm.firstName} ${fm.lastName} (${fm.ageTier})`;
                const blockMessage = getFamilyMemberBookingBlockMessage(fm);
                const actionLabel = getFamilyMemberBookingActionLabel(fm);
                return (
                  <div
                    key={fm.id}
                    className={blocked ? "rounded-md border border-amber-200 bg-amber-50 p-3" : ""}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={alreadyAdded ? "secondary" : fm.relationship === "self" ? "default" : "outline"}
                        size="sm"
                        disabled={alreadyAdded || guests.length >= lodgeCapacity || blocked}
                        onClick={() => addFamilyMemberAsGuest(fm)}
                      >
                        {alreadyAdded ? "\u2713 " : "+ "}
                        {label}
                      </Button>
                      {blocked && actionLabel && (
                        actionLabel === "Complete details" ? (
                          <Button asChild variant="outline" size="sm">
                            <Link href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}>
                              {actionLabel}
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-xs font-medium text-amber-800">
                            {actionLabel}
                          </span>
                        )
                      )}
                    </div>
                    {blocked && blockMessage && (
                      <p className="mt-2 text-sm text-amber-800">{blockMessage}</p>
                    )}
                    {blocked && fm.missingFields && fm.missingFields.length > 0 && (
                      <p className="mt-1 text-xs text-amber-700">
                        Missing: {fm.missingFields.join(", ")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {showInviteFamilyGroupMembersLink && (
          <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/50 p-4">
            <p className="text-sm text-slate-600">
              No other family group members are available to quick add yet.{" "}
              <Link
                href={PROFILE_FAMILY_GROUP_RETURN_TO_BOOK}
                className="font-medium text-indigo-700 underline underline-offset-4 hover:text-indigo-800"
              >
                Invite family group members
              </Link>
              .
            </p>
          </div>
        )}
        <GuestForm
          guests={guests}
          onGuestsChange={handleGuestsChange}
          maxGuests={lodgeCapacity}
          bookingCheckIn={checkIn ? formatLocalDateOnly(checkIn) : undefined}
          bookingCheckOut={checkOut ? formatLocalDateOnly(checkOut) : undefined}
          perGuestDatesEnabled={perGuestDatesEnabled}
          onPerGuestDatesEnabledChange={handlePerGuestDatesEnabledChange}
          multiDateRangesEnabled={multiDateRangesEnabled}
          onMultiDateRangesEnabledChange={handleMultiDateRangesEnabledChange}
          nightlyPriceForGuest={(guestIndex, nightKey) => {
            const g = priceQuote?.guests[guestIndex];
            if (!g?.perNightCents || !g?.nightDates) return null;
            const idx = g.nightDates.findIndex(
              (d) => d.slice(0, 10) === nightKey,
            );
            return idx >= 0 ? g.perNightCents[idx] : null;
          }}
        />
        {groupBookingsEnabled && (
          <div className="space-y-3 rounded-md border border-slate-200 p-4">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input
                type="checkbox"
                checked={groupTrip}
                onChange={(e) => setGroupTrip(e.target.checked)}
                className="rounded border-slate-300"
              />
              Make this a group trip
            </label>
            <p className="text-sm text-muted-foreground">
              Others can join this trip with their own booking via a link
              you share after you confirm.
            </p>
            {groupTrip && (
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="groupPaymentMode"
                    checked={groupPaymentMode === "EACH_PAYS_OWN"}
                    onChange={() => setGroupPaymentMode("EACH_PAYS_OWN")}
                  />
                  Each person pays their own beds
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="groupPaymentMode"
                    checked={groupPaymentMode === "ORGANISER_PAYS"}
                    onChange={() => setGroupPaymentMode("ORGANISER_PAYS")}
                  />
                  You pay for everyone (settle one combined bill)
                </label>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-between pt-4">
          <Button variant="outline" onClick={() => setStep("dates")}>
            Back
          </Button>
          <Button onClick={handleGuestsDone} disabled={priceLoading || guests.length === 0}>
            {priceLoading ? "Calculating price..." : "Continue"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
