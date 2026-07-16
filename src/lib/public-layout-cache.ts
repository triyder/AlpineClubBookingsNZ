import "server-only";

import { revalidateTag } from "next/cache";

export const PUBLIC_LAYOUT_CACHE_TAGS = {
  capacity: "public-layout:capacity",
  modules: "public-layout:modules",
  banners: "public-layout:banners",
  theme: "public-layout:theme",
  identity: "public-layout:identity",
} as const;

export function invalidatePublicLayoutConfig(
  ...tags: Array<
    (typeof PUBLIC_LAYOUT_CACHE_TAGS)[keyof typeof PUBLIC_LAYOUT_CACHE_TAGS]
  >
): void {
  for (const tag of tags) revalidateTag(tag, "max");
}

export function invalidatePublicLodgeCapacity(): void {
  invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.capacity);
}

/**
 * Invalidate the DB-first club-identity tag (E3 #1929). Called from the club
 * identity admin PUT, the lodges write routes (default lodge name feeds the
 * identity), and config-transfer apply. Lodge capacity shares the identity's
 * default-lodge dependency, so callers pair this with the capacity tag.
 */
export function invalidatePublicClubIdentity(): void {
  invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.identity);
}
