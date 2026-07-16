import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("public layout cache writer invalidation", () => {
  it("invalidates modules and derived capacity after module writes", () => {
    const route = source("src/app/api/admin/modules/route.ts");
    expect(route).toContain("PUBLIC_LAYOUT_CACHE_TAGS.modules");
    expect(route).toContain("PUBLIC_LAYOUT_CACHE_TAGS.capacity");
    expect(route.indexOf("invalidatePublicLayoutConfig(")).toBeGreaterThan(
      route.indexOf("await write"),
    );
  });

  it("invalidates capacity after lodge setting writes", () => {
    const route = source("src/app/api/admin/lodge-settings/route.ts");
    expect(route).toContain("invalidatePublicLodgeCapacity();");
    expect(route.indexOf("invalidatePublicLodgeCapacity();")).toBeGreaterThan(
      route.indexOf("await updateLodgeSettings"),
    );
  });

  it("invalidates every imported public-layout config category", () => {
    const route = source("src/app/api/admin/config-transfer/apply/route.ts");
    for (const tag of ["modules", "theme", "capacity", "banners"]) {
      expect(route).toContain(`PUBLIC_LAYOUT_CACHE_TAGS.${tag}`);
    }
    expect(route.indexOf("invalidatePublicLayoutConfig(")).toBeGreaterThan(
      route.indexOf("await applyConfigImport"),
    );
    expect(route).toContain("await primeEmailPalette();");
    expect(route.indexOf("await primeEmailPalette();")).toBeGreaterThan(
      route.indexOf("await applyConfigImport"),
    );
  });
});
