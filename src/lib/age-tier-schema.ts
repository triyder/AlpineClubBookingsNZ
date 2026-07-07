import { AgeTier } from "@prisma/client";
import { z } from "zod";

/**
 * Shared Zod validator for the AgeTier enum.
 * Derived from Prisma's generated AgeTier enum so that adding a new tier
 * to schema.prisma automatically makes all validators accept it.
 */
export const AGE_TIER_VALUES = Object.values(AgeTier) as [
  AgeTier,
  ...AgeTier[],
];

export const ageTierEnum = z.nativeEnum(AgeTier);

/**
 * Person tiers only: NOT_APPLICABLE is the organisation/school member
 * classification (#1440) and is never valid for booking guests or
 * per-tier season rates — those are always people with an age.
 */
const BOOKABLE_AGE_TIER_VALUES = [
  "INFANT",
  "CHILD",
  "YOUTH",
  "ADULT",
] as const satisfies readonly AgeTier[];

export const bookableAgeTierEnum = z.enum(BOOKABLE_AGE_TIER_VALUES);
