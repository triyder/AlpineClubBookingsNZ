import "server-only";

import { revalidateTag } from "next/cache";

export const PUBLIC_LAYOUT_CACHE_TAGS = {
  capacity: "public-layout:capacity",
  modules: "public-layout:modules",
  banners: "public-layout:banners",
  theme: "public-layout:theme",
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
