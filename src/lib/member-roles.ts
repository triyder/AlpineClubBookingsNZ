import type { Role } from "@prisma/client";

export const ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export type AppRole = (typeof ROLE_VALUES)[number];

export const MEMBER_LEVEL_ROLE_VALUES = [
  "USER",
] as const satisfies readonly Role[];

export type MemberLevelRole = (typeof MEMBER_LEVEL_ROLE_VALUES)[number];

export const OPERATIONAL_ROLE_VALUES = [
  "ADMIN",
  "LODGE",
] as const satisfies readonly Role[];

// Non-member categories created by booking-request flows. These carry NO access:
// they are deliberately excluded from MEMBER_LEVEL and OPERATIONAL role sets, so
// every existing allowlist permission check treats them as "no access". They are
// also excluded from member rosters and exempt from subscription obligations.
export const NON_MEMBER_ROLE_VALUES = [
  "NON_MEMBER",
  "SCHOOL",
] as const satisfies readonly Role[];

export const ASSIGNABLE_ACCESS_ROLE_VALUES = [
  "USER",
  "ADMIN",
  "LODGE",
] as const satisfies readonly Role[];

export const LEGACY_MEMBERSHIP_CATEGORY_ROLE_VALUES = [
] as const satisfies readonly Role[];

export const MEMBER_IMPORT_ROLE_VALUES = [
  "USER",
  "ADMIN",
] as const satisfies readonly Role[];

export const ROLE_LABELS: Record<AppRole, string> = {
  USER: "User",
  ADMIN: "Admin",
  LODGE: "Lodge",
  NON_MEMBER: "Non-Member",
  SCHOOL: "School",
};

export function isRole(value: string | null | undefined): value is AppRole {
  return ROLE_VALUES.includes(value as AppRole);
}

export function isNonMemberRole(
  role: string | null | undefined,
): role is (typeof NON_MEMBER_ROLE_VALUES)[number] {
  return NON_MEMBER_ROLE_VALUES.includes(
    role as (typeof NON_MEMBER_ROLE_VALUES)[number],
  );
}

export function isMemberLevelRole(
  role: string | null | undefined,
): role is MemberLevelRole {
  return MEMBER_LEVEL_ROLE_VALUES.includes(role as MemberLevelRole);
}

export function isOperationalRole(
  role: string | null | undefined,
): role is (typeof OPERATIONAL_ROLE_VALUES)[number] {
  return OPERATIONAL_ROLE_VALUES.includes(
    role as (typeof OPERATIONAL_ROLE_VALUES)[number],
  );
}

export function isLegacyMembershipCategoryRole(
  role: string | null | undefined,
): role is (typeof LEGACY_MEMBERSHIP_CATEGORY_ROLE_VALUES)[number] {
  return LEGACY_MEMBERSHIP_CATEGORY_ROLE_VALUES.includes(
    role as (typeof LEGACY_MEMBERSHIP_CATEGORY_ROLE_VALUES)[number],
  );
}

export function getAccessRoleOptions(): Array<{
  value: AppRole;
  label: string;
  legacyMembershipCategory: boolean;
  nonMember: boolean;
}> {
  const values: AppRole[] = [...ASSIGNABLE_ACCESS_ROLE_VALUES];

  // Always offer the non-member categories so an admin can classify a record
  // (e.g. a school-booking contact) as School / Non-Member. These grant no access.
  values.push(...NON_MEMBER_ROLE_VALUES);

  return values.map((value) => ({
    value,
    label: ROLE_LABELS[value],
    legacyMembershipCategory: isLegacyMembershipCategoryRole(value),
    nonMember: isNonMemberRole(value),
  }));
}
