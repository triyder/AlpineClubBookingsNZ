import { prisma } from "@/lib/prisma";

// Admin-configurable settings for the booking lockout that blocks members with
// an unpaid annual subscription. Single-row table (id = "default"), same
// pattern as membership-nomination-settings.ts.
export const MEMBERSHIP_LOCKOUT_SETTINGS_ID = "default";

export interface MembershipLockoutSettings {
  /** Master toggle. When false, no booking is blocked for an unpaid subscription. */
  enabled: boolean;
  /**
   * Membership financial year-end month (1-12), or null to follow the connected
   * Xero organisation's accounting financial year.
   */
  financialYearEndMonthOverride: number | null;
  /**
   * When true, an invoice whose reference/description text reads like a
   * membership subscription also counts during detection, in addition to the
   * configured account/item code.
   */
  textFallbackEnabled: boolean;
}

export interface PersistedMembershipLockoutSettings {
  enabled: boolean | null;
  financialYearEndMonthOverride: number | null;
  textFallbackEnabled: boolean | null;
  updatedByMemberId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

function getDefaultMembershipLockoutSettings(): MembershipLockoutSettings {
  return {
    enabled: true,
    financialYearEndMonthOverride: null,
    textFallbackEnabled: true,
  };
}

function coerceYearEndOverride(
  value: number | null | undefined,
): number | null {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 12 ? rounded : null;
}

export function normalizeMembershipLockoutSettings(
  persisted?: Partial<PersistedMembershipLockoutSettings> | null,
): MembershipLockoutSettings {
  const defaults = getDefaultMembershipLockoutSettings();
  return {
    enabled: persisted?.enabled ?? defaults.enabled,
    financialYearEndMonthOverride: coerceYearEndOverride(
      persisted?.financialYearEndMonthOverride,
    ),
    textFallbackEnabled:
      persisted?.textFallbackEnabled ?? defaults.textFallbackEnabled,
  };
}

export async function loadPersistedMembershipLockoutSettings(): Promise<PersistedMembershipLockoutSettings | null> {
  try {
    return await prisma.membershipLockoutSettings.findUnique({
      where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    });
  } catch {
    // Table may not exist yet (migration not applied); fall back to defaults.
    return null;
  }
}

export async function loadMembershipLockoutSettings(): Promise<MembershipLockoutSettings> {
  return normalizeMembershipLockoutSettings(
    await loadPersistedMembershipLockoutSettings(),
  );
}
