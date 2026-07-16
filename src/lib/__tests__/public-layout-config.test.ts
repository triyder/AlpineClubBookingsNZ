import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  unstableCache: vi.fn(
    (loader: () => Promise<unknown>) => loader,
  ),
  capacity: vi.fn(async () => 20),
  modules: vi.fn(async () => ({ analytics: true })),
  banners: vi.fn(async () => []),
  theme: vi.fn(async () => ({ appCss: "" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  unstable_cache: mocks.unstableCache,
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getDefaultLodgeCapacity: mocks.capacity,
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.modules,
}));
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: mocks.banners,
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: mocks.theme,
}));

import {
  getCachedCurrentSiteBanners,
  getCachedDefaultLodgeCapacity,
  getCachedEffectiveModuleFlags,
  getCachedWebsiteThemeRenderState,
} from "@/lib/public-layout-config";
import {
  invalidatePublicLayoutConfig,
  invalidatePublicLodgeCapacity,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

describe("public layout config cache", () => {
  beforeEach(() => {
    mocks.revalidateTag.mockClear();
  });

  it("uses independent short-lived tagged caches for non-security config", () => {
    expect(mocks.unstableCache.mock.calls).toEqual([
      [mocks.capacity, ["public-layout-default-lodge-capacity"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.capacity], revalidate: 15,
      }],
      [mocks.modules, ["public-layout-module-flags"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.modules], revalidate: 15,
      }],
      [mocks.banners, ["public-layout-site-banners"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.banners], revalidate: 15,
      }],
      [mocks.theme, ["public-layout-theme"], {
        tags: [PUBLIC_LAYOUT_CACHE_TAGS.theme], revalidate: 15,
      }],
    ]);
  });

  it("delegates cached reads to their existing sources of truth", async () => {
    await Promise.all([
      getCachedDefaultLodgeCapacity(),
      getCachedEffectiveModuleFlags(),
      getCachedCurrentSiteBanners(),
      getCachedWebsiteThemeRenderState(),
    ]);
    expect(mocks.capacity).toHaveBeenCalledOnce();
    expect(mocks.modules).toHaveBeenCalledOnce();
    expect(mocks.banners).toHaveBeenCalledOnce();
    expect(mocks.theme).toHaveBeenCalledOnce();
  });

  it("invalidates every requested tag with stale-while-revalidate semantics", () => {
    invalidatePublicLayoutConfig(
      PUBLIC_LAYOUT_CACHE_TAGS.modules,
      PUBLIC_LAYOUT_CACHE_TAGS.banners,
      PUBLIC_LAYOUT_CACHE_TAGS.theme,
    );
    expect(mocks.revalidateTag.mock.calls).toEqual([
      [PUBLIC_LAYOUT_CACHE_TAGS.modules, "max"],
      [PUBLIC_LAYOUT_CACHE_TAGS.banners, "max"],
      [PUBLIC_LAYOUT_CACHE_TAGS.theme, "max"],
    ]);
  });

  it("provides a capacity-specific invalidation for bed configuration writes", () => {
    invalidatePublicLodgeCapacity();
    expect(mocks.revalidateTag).toHaveBeenCalledWith(
      PUBLIC_LAYOUT_CACHE_TAGS.capacity,
      "max",
    );
  });
});
