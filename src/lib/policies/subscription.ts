import type { AgeTier } from "@prisma/client";
import type { AgeTierSettingData } from "./age-tier";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  if (!ageTier) {
    return true;
  }

  // NOT_APPLICABLE is the organisation/school tier (#1440): it never has a
  // settings row, and without this it would inherit the missing-row default
  // of `true` — imposing an age-based subscription requirement on accounts
  // that have no age.
  if (ageTier === "NOT_APPLICABLE") {
    return false;
  }

  return (
    settings.find((setting) => setting.tier === ageTier)
      ?.subscriptionRequiredForBooking ?? true
  );
}
