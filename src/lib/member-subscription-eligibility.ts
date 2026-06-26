import type { AgeTier } from "@prisma/client";
import {
  getAgeTierSettings,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { refreshFinancialYearConfig } from "@/lib/financial-year-server";
import { loadMembershipLockoutSettings } from "@/lib/membership-lockout-settings";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { requiresPaidSubscriptionForAgeTier as requiresPaidSubscriptionForAgeTierRule } from "@/lib/policies/subscription";

export function requiresPaidSubscriptionForAgeTier(
  ageTier: AgeTier | null | undefined,
  settings: AgeTierSettingData[]
): boolean {
  return requiresPaidSubscriptionForAgeTierRule(ageTier, settings);
}

export async function requiresPaidSubscriptionForAgeTierFromSettings(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  const settings = await getAgeTierSettings();
  return requiresPaidSubscriptionForAgeTier(ageTier, settings);
}

/**
 * Membership subscriptions are invoiced and reconciled through Xero. The
 * booking lockout is enforced only when BOTH:
 *  - the Xero module is effectively enabled (deploy capability AND admin
 *    setting, via loadEffectiveModuleFlags) — otherwise members can never
 *    reach PAID; and
 *  - the admin has the lockout toggle on (MembershipLockoutSettings.enabled).
 *
 * This call also reseeds the financial-year cache for the current instance, so
 * the synchronous season helpers stay correct on every gated booking request.
 */
export async function isSubscriptionEnforcementActive(): Promise<boolean> {
  const flags = await loadEffectiveModuleFlags();
  if (!flags.xeroIntegration) return false;
  const lockout = await loadMembershipLockoutSettings();
  // Reseed the in-process financial-year cache (cheap; uses cached Xero value).
  await refreshFinancialYearConfig();
  return lockout.enabled;
}

/**
 * Booking-time subscription gate: the age-tier rule applies only while the
 * Xero module is effectively enabled. Booking-time policy check sites use
 * this instead of the raw age-tier rule so the Xero-off bypass is consistent.
 */
export async function requiresPaidSubscriptionForBooking(
  ageTier: AgeTier | null | undefined
): Promise<boolean> {
  if (!(await isSubscriptionEnforcementActive())) {
    return false;
  }
  return requiresPaidSubscriptionForAgeTierFromSettings(ageTier);
}
