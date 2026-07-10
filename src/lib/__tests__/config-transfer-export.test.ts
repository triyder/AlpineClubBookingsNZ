import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ReadDb } from "@/lib/config-transfer/export-types";

function stubDb(): ReadDb {
  return {
    pageContent: {
      findMany: vi.fn().mockResolvedValue([
        {
          slug: "about",
          path: "/about",
          caption: "",
          menuTitle: "About",
          title: "About Us",
          headerText: "",
          sortOrder: 1,
          contentHtml: '<p>Hi</p><img src="/api/images/img123">',
          published: true,
        },
      ]),
    },
    siteContent: {
      findMany: vi.fn().mockResolvedValue([
        { key: "FOOTER_BLURB", contentHtml: "<p>Footer</p>" },
      ]),
    },
    clubTheme: {
      findUnique: vi.fn().mockResolvedValue({
        brandGold: "#e0a800",
        brandCharcoal: "#222",
        brandDeep: "#111",
        brandRidge: "#333",
        brandMist: "#eee",
        brandSnow: "#fff",
        brandSafety: "#f00",
        headingFontKey: "LEAGUE_SPARTAN",
        bodyFontKey: "INTER",
        logoDataUrl: null,
        rawCss: "",
      }),
    },
    mediaImage: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "img123",
          filename: "logo.png",
          contentType: "image/png",
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ]),
    },
  } as unknown as ReadDb;
}

describe("config-transfer export", () => {
  it("exports site-content into a valid bundle with pages, theme, and media", async () => {
    const result = await buildConfigExport({
      db: stubDb(),
      categories: ["site-content"],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });

    expect(result.imageCount).toBe(1);
    expect(result.categories).toEqual(["site-content"]);

    const { manifest, files } = readBundle(result.zip);
    expect(manifest.includedCategories).toEqual(["site-content"]);

    const paths = manifest.files.map((f) => f.path).sort();
    expect(paths).toContain("site-content/pages.csv");
    expect(paths).toContain("site-content/site-content.csv");
    expect(paths).toContain("site-content/theme.json");
    expect(paths).toContain("media/img123.png");
    expect(paths).toContain("media/media-map.json");

    // Pages CSV round-trips the allowlisted row (and only allowlisted columns).
    const pages = parseCsv(strFromU8(files.get("site-content/pages.csv")!));
    expect(pages.rows).toHaveLength(1);
    expect(pages.rows[0].slug).toBe("about");
    expect(pages.rows[0].title).toBe("About Us");
    expect(pages.headers).not.toContain("id");
    expect(pages.headers).not.toContain("updatedByMemberId");

    // Media map links the referenced image id to its bundled bytes.
    const mediaMap = JSON.parse(
      strFromU8(files.get("media/media-map.json")!),
    ) as Record<string, { path: string; contentType: string }>;
    expect(mediaMap.img123.path).toBe("media/img123.png");
    expect(mediaMap.img123.contentType).toBe("image/png");
  });

  it("omits a category that produced no entries", async () => {
    const result = await buildConfigExport({
      db: stubDb(),
      categories: [],
      includeDoorCodes: false,
      appVersion: "0.10.1",
      prismaMigration: null,
      generatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(result.categories).toEqual([]);
    const { manifest } = readBundle(result.zip);
    expect(manifest.includedCategories).toEqual([]);
    expect(manifest.files).toHaveLength(0);
  });
});
