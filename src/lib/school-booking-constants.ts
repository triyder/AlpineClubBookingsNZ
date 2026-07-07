/**
 * Client-safe constants for the school booking flow.
 *
 * Kept separate from `school-booking-request.ts` (which pulls in prisma, email
 * and bcrypt) so the public `"use client"` form can import these without
 * bundling server-only code.
 */

/**
 * Soft cap on a school group's bed count (students + teachers/parent helpers).
 * A club member must stay on to host, so groups above this may be declined
 * unless the remaining beds (up to the lodge capacity) include a member staying
 * with the group. Surfaced only as a warning on the public form; the hard
 * limit stays the lodge capacity.
 */
export const DEFAULT_SCHOOL_GROUP_SOFT_CAP = 25;

/**
 * @deprecated Prefer the per-lodge value resolved from LodgeSettings
 * (loadLodgeSettings().schoolGroupSoftCap). This constant is the fallback
 * when a lodge has no configured cap.
 */
export const SCHOOL_GROUP_SOFT_CAP = DEFAULT_SCHOOL_GROUP_SOFT_CAP;
