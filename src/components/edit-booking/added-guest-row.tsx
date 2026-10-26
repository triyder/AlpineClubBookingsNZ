"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { renderAddedGuestConsent } from "@/components/edit-booking/guest-consent-notes";
import { shiftDateOnly } from "@/components/edit-booking/stay-nights";
import type { NewGuest } from "@/components/edit-booking/types";
import { getAgeTierLabel, type AgeTierOption } from "@/lib/use-age-tier-options";

/**
 * One person this edit is adding, before it is saved.
 *
 * Moved out of `edit-booking-panel.tsx` (#2690).
 */
export function AddedGuestRow({
  guest,
  ageTierOptions,
  perGuestDatesEnabled,
  checkIn,
  checkOut,
  stayStartMax,
  onUpdateRange,
  onRemove,
}: {
  guest: NewGuest;
  ageTierOptions: AgeTierOption[];
  perGuestDatesEnabled: boolean;
  checkIn: string;
  checkOut: string;
  /** #4030 review S3: the latest Date In this row may take, when narrower than the stay. */
  stayStartMax?: string;
  onUpdateRange: (field: "stayStart" | "stayEnd", value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-2 bg-success-3 rounded px-2">
      <div>
        <p className="font-medium">
          {guest.firstName} {guest.lastName}
          <span className="ml-2 text-xs text-success-11 font-normal">NEW</span>
        </p>
        <p className="text-sm text-muted-foreground">
          {getAgeTierLabel(ageTierOptions, guest.ageTier)} &middot; {guest.isMember ? "Member" : "Non-member"}
        </p>
        {/*
          MG4 (#2309): what saving will do to this person's consent,
          before the booker saves. Rendered from the SHARED badge
          function so the wording here and on the booking page after the
          save cannot drift, and only for a cross-family member guest —
          every other added row is byte-identical to before.
        */}
        {renderAddedGuestConsent(guest)}
        {perGuestDatesEnabled ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`added-${guest.key}-stay-start`} className="text-xs">
                Date In
              </Label>
              <Input
                id={`added-${guest.key}-stay-start`}
                type="date"
                value={guest.stayStart ?? checkIn}
                min={checkIn}
                max={[shiftDateOnly(guest.stayEnd ?? checkOut, -1), stayStartMax]
                  .filter((value): value is string => Boolean(value))
                  .sort()[0]}
                onChange={(e) => onUpdateRange("stayStart", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`added-${guest.key}-stay-end`} className="text-xs">
                Date Out
              </Label>
              <Input
                id={`added-${guest.key}-stay-end`}
                type="date"
                value={guest.stayEnd ?? checkOut}
                min={shiftDateOnly(guest.stayStart ?? checkIn, 1)}
                max={checkOut}
                onChange={(e) => onUpdateRange("stayEnd", e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="text-danger-11 hover:text-danger-11"
        onClick={onRemove}
      >
        Remove
      </Button>
    </div>
  );
}
