import "server-only";

import { unstable_cache } from "next/cache";
import { getClubIdentity } from "@/lib/club-identity-settings";
import { getWebsiteThemeRenderState } from "@/lib/club-theme";
import { getDefaultLodgeCapacity } from "@/lib/lodge-capacity";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getCurrentSiteBanners } from "@/lib/site-banners";
import { PUBLIC_LAYOUT_CACHE_TAGS } from "@/lib/public-layout-cache";

const SHORT_CONFIG_TTL_SECONDS = 15;

export const getCachedDefaultLodgeCapacity = unstable_cache(
  getDefaultLodgeCapacity,
  ["public-layout-default-lodge-capacity"],
  {
    tags: [PUBLIC_LAYOUT_CACHE_TAGS.capacity],
    revalidate: SHORT_CONFIG_TTL_SECONDS,
  },
);

export const getCachedEffectiveModuleFlags = unstable_cache(
  loadEffectiveModuleFlags,
  ["public-layout-module-flags"],
  {
    tags: [PUBLIC_LAYOUT_CACHE_TAGS.modules],
    revalidate: SHORT_CONFIG_TTL_SECONDS,
  },
);

export const getCachedCurrentSiteBanners = unstable_cache(
  getCurrentSiteBanners,
  ["public-layout-site-banners"],
  {
    tags: [PUBLIC_LAYOUT_CACHE_TAGS.banners],
    revalidate: SHORT_CONFIG_TTL_SECONDS,
  },
);

export const getCachedWebsiteThemeRenderState = unstable_cache(
  getWebsiteThemeRenderState,
  ["public-layout-theme"],
  {
    tags: [PUBLIC_LAYOUT_CACHE_TAGS.theme],
    revalidate: SHORT_CONFIG_TTL_SECONDS,
  },
);

// DB-first club identity (E3 #1929): tagged cache for layout/header/server
// consumption. Invalidated (identity tag) on the club-identity admin PUT, the
// lodge write routes (default lodge name feeds the identity), and config
// transfer apply.
export const getCachedClubIdentity = unstable_cache(
  getClubIdentity,
  ["public-layout-club-identity"],
  {
    tags: [PUBLIC_LAYOUT_CACHE_TAGS.identity],
    revalidate: SHORT_CONFIG_TTL_SECONDS,
  },
);
