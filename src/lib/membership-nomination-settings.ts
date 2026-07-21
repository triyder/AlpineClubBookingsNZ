import { DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";

// Admin-configurable settings for the membership nomination eligibility gate and
// induction sign-off. Single-row table (id = "default"), same pattern as the
// other settings models (see email-message-settings.ts).
export const MEMBERSHIP_NOMINATION_SETTINGS_ID = "default";

export interface MembershipNominationSettings {
  /** When false the nomination gate is not enforced (any paid member can nominate). */
  gateEnabled: boolean;
  /** Minimum months a member must have belonged before they may nominate. */
  minimumMembershipMonths: number;
  /** Minimum nights a member must have stayed before they may nominate. */
  minimumNights: number;
  /** Number of sign-offs required to complete an induction. */
  requiredSignOffs: number;
  /**
   * Grandfather cutoff. Members whose membership start date is before this are
   * exempt from the gate. Null means no cutoff (everyone is subject to the gate
   * once it is enabled).
   */
  gateEffectiveFrom: Date | null;
}

export interface PersistedMembershipNominationSettings {
  gateEnabled: boolean | null;
  minimumMembershipMonths: number | null;
  minimumNights: number | null;
  requiredSignOffs: number | null;
  gateEffectiveFrom: Date | string | null;
  updatedByMemberId?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

// test seam
export function getDefaultMembershipNominationSettings(): MembershipNominationSettings {
  return { ...DEFAULT_MEMBERSHIP_NOMINATION_SETTINGS };
}

function coerceCount(
  value: number | null | undefined,
  fallback: number,
  min: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded < min ? min : rounded;
}

function coerceDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeMembershipNominationSettings(
  persisted?: Partial<PersistedMembershipNominationSettings> | null,
): MembershipNominationSettings {
  const defaults = getDefaultMembershipNominationSettings();
  return {
    gateEnabled: persisted?.gateEnabled ?? defaults.gateEnabled,
    minimumMembershipMonths: coerceCount(
      persisted?.minimumMembershipMonths,
      defaults.minimumMembershipMonths,
      0,
    ),
    minimumNights: coerceCount(persisted?.minimumNights, defaults.minimumNights, 0),
    requiredSignOffs: coerceCount(
      persisted?.requiredSignOffs,
      defaults.requiredSignOffs,
      1,
    ),
    gateEffectiveFrom: coerceDate(persisted?.gateEffectiveFrom),
  };
}

export async function loadPersistedMembershipNominationSettings(): Promise<PersistedMembershipNominationSettings | null> {
  try {
    return await prisma.membershipNominationSettings.findUnique({
      where: { id: MEMBERSHIP_NOMINATION_SETTINGS_ID },
    });
  } catch {
    // Table may not exist yet (migration not applied); fall back to defaults.
    return null;
  }
}

export async function loadMembershipNominationSettings(): Promise<MembershipNominationSettings> {
  return normalizeMembershipNominationSettings(
    await loadPersistedMembershipNominationSettings(),
  );
}
