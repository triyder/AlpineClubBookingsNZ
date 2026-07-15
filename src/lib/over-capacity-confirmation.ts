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
 *
 * Whole-lodge-held nights (ADR-001, issue #118) are deliberately EXCLUDED: a
 * held night is pinned to availableBeds 0 (never negative) so it can never enter
 * this confirmable set. The over-capacity override must not be able to bypass an
 * exclusive hold (decision 5); held nights are reported separately by
 * wholeLodgeBlockedNights and refused via WholeLodgeHoldBlockedError.
 */
export function overCapacityNights(capacity: {
  nightDetails: NightAvailability[];
}): OverCapacityNight[] {
  return capacity.nightDetails
    .filter((night) => night.availableBeds < 0 && !night.wholeLodgeHeld)
    .map((night) => ({
      date: formatDateOnly(night.date),
      availableBeds: night.availableBeds,
    }));
}

/**
 * The whole-lodge-held nights of a capacity result (ADR-001, issue #118), as
 * YYYY-MM-DD. These are the nights an exclusive hold on another overlapping
 * booking hard-blocks. Distinct from overCapacityNights: held nights are NOT
 * confirmable — an admin who confirms the over-capacity override is still
 * refused admission onto them (decision 5).
 */
export function wholeLodgeBlockedNights(capacity: {
  nightDetails: NightAvailability[];
}): string[] {
  return capacity.nightDetails
    .filter((night) => night.wholeLodgeHeld)
    .map((night) => formatDateOnly(night.date));
}

/**
 * Non-confirmable capacity refusal (ADR-001, issue #118). Raised when an admin
 * over-capacity override (`confirmOverCapacity`) would admit a guest onto a
 * night that is exclusively held for another booking. Unlike
 * OverCapacityConfirmationRequiredError there is no confirm that clears it — to
 * add anyone the admin must remove or adjust the hold (decision 5).
 *
 * This error only ever reaches admin override paths, so its message is
 * admin-facing. Members never see it: to them a held night is indistinguishable
 * from a full lodge (decision 6) and they fall through the ordinary no-space /
 * over-capacity-confirm path. It carries the blocked nights for admin surfacing
 * (issue #119).
 */
export class WholeLodgeHoldBlockedError extends ApiError {
  readonly code = "WHOLE_LODGE_HOLD_BLOCKED";
  constructor(public blockedNights: string[]) {
    super(
      "One or more nights are exclusively held for another booking and cannot be overbooked.",
      409,
    );
    this.name = "WholeLodgeHoldBlockedError";
  }
}
