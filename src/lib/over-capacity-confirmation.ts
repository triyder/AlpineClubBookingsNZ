import { ApiError } from "@/lib/api-error";
import type { NightAvailability } from "@/lib/capacity";
import { formatDateOnly } from "@/lib/date-only";

// Lives in its own module, NOT in @/lib/capacity: a dozen-plus test files
// blanket-mock "@/lib/capacity" with non-spreading factories, and the routes'
// instanceof checks need the real class at runtime.

export type OverCapacityNight = { date: string; availableBeds: number };

/**
 * Admin override over-capacity signal (issue #1668). Raised when target nights
 * exceed lodge capacity and the admin has not (yet) confirmed the overbooking.
 * The per-lodge capacity lock is still taken; only the availability *decision*
 * becomes warn-and-confirm. Routes translate this to a 409 with the code and
 * night list so the UI can prompt for an explicit confirm.
 */
export class OverCapacityConfirmationRequiredError extends ApiError {
  readonly code = "OVER_CAPACITY_CONFIRM_REQUIRED";
  constructor(public nightDetails: OverCapacityNight[]) {
    super(
      "The target nights are over lodge capacity. Confirm the override to proceed.",
      409,
    );
    this.name = "OverCapacityConfirmationRequiredError";
  }
}

/**
 * The over-capacity nights of a checkCapacityForGuestRanges result: the nights
 * whose availableBeds went negative (guests baked into occupancy), as
 * YYYY-MM-DD. Not valid for checkCapacity, whose availableBeds excludes the
 * proposed guests — use checkCapacityForGuestRanges under override.
 */
export function overCapacityNights(capacity: {
  nightDetails: NightAvailability[];
}): OverCapacityNight[] {
  return capacity.nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => ({
      date: formatDateOnly(night.date),
      availableBeds: night.availableBeds,
    }));
}
