import { strToU8, strFromU8 } from "fflate";
import type { Prisma } from "@prisma/client";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { remapImageRefs } from "../media";
import type { BundleEntry } from "../bundle";

// Re-exported for tests and other categories that rewrite image references.
export { remapImageRefs };
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity, type EntityDescriptor } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  hashRow,
  updateDataForMode,
  type CategoryImporter,
  type CategoryApplyResult,
  type CategoryPlanResult,
  type PlanContext,
  type ApplyContext,
  type PlanItem,
} from "../import-types";

// site-content category: CMS pages, keyed site content, and the club theme.
// See docs/config-transfer/decisions/ADR-001.

const PAGE_FILE = "site-content/pages.csv";
const SITE_CONTENT_FILE = "site-content/site-content.csv";
const THEME_FILE = "site-content/theme.json";

/** Allowlisted PageContent fields — no id/updatedByMemberId/timestamps. */
export const PAGE_CONTENT_FIELDS = [
  "slug",
  "path",
  "caption",
  "menuTitle",
  "title",
  "headerText",
  "sortOrder",
  "contentHtml",
  "published",
] as const;

export const SITE_CONTENT_FIELDS = ["key", "contentHtml"] as const;

export const CLUB_THEME_FIELDS = [
  "brandGold",
  "brandCharcoal",
  "brandDeep",
  "brandRidge",
  "brandMist",
  "brandSnow",
  "brandSafety",
  "headingFontKey",
  "bodyFontKey",
  "logoDataUrl",
  "rawCss",
] as const;

export const pageContentDescriptor: EntityDescriptor = registerEntity({
  entity: "page-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: PAGE_FILE,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...PAGE_CONTENT_FIELDS],
});

export const siteContentDescriptor: EntityDescriptor = registerEntity({
  entity: "site-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: SITE_CONTENT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...SITE_CONTENT_FIELDS],
});

export const clubThemeDescriptor: EntityDescriptor = registerEntity({
  entity: "club-theme",
  category: "site-content",
  tier: "key-strong",
  format: "json",
  file: THEME_FILE,
  naturalKey: [],
  singleton: true,
  fields: [...CLUB_THEME_FIELDS],
});

/** Extract MediaImage ids referenced as /api/images/<id> in content HTML. */
export function extractImageIds(html: string): string[] {
  const ids = new Set<string>();
  const re = /\/api\/images\/([A-Za-z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

type PageRow = Record<(typeof PAGE_CONTENT_FIELDS)[number], unknown>;
type SiteRow = Record<(typeof SITE_CONTENT_FIELDS)[number], unknown>;

export function serialisePages(rows: PageRow[]): BundleEntry {
  return {
    path: PAGE_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...PAGE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseSiteContent(rows: SiteRow[]): BundleEntry {
  return {
    path: SITE_CONTENT_FILE,
    category: "site-content",
    rowCount: rows.length,
    bytes: strToU8(serialiseCsv([...SITE_CONTENT_FIELDS], rows)),
  };
}

export function serialiseTheme(
  theme: Record<(typeof CLUB_THEME_FIELDS)[number], unknown> | null,
): BundleEntry | null {
  if (!theme) return null;
  const projected: Record<string, unknown> = {};
  for (const field of CLUB_THEME_FIELDS) projected[field] = theme[field];
  return {
    path: THEME_FILE,
    category: "site-content",
    rowCount: 1,
    bytes: strToU8(JSON.stringify(projected, null, 2)),
  };
}

export const siteContentExporter: CategoryExporter = {
  category: "site-content",
  descriptors: [
    pageContentDescriptor,
    siteContentDescriptor,
    clubThemeDescriptor,
  ],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const pages = await ctx.db.pageContent.findMany({
      orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
      select: {
        slug: true,
        path: true,
        caption: true,
        menuTitle: true,
        title: true,
        headerText: true,
        sortOrder: true,
        contentHtml: true,
        published: true,
      },
    });
    const siteContent = await ctx.db.siteContent.findMany({
      orderBy: { key: "asc" },
      select: { key: true, contentHtml: true },
    });
    const theme = await ctx.db.clubTheme.findUnique({
      where: { id: "default" },
      select: {
        brandGold: true,
        brandCharcoal: true,
        brandDeep: true,
        brandRidge: true,
        brandMist: true,
        brandSnow: true,
        brandSafety: true,
        headingFontKey: true,
        bodyFontKey: true,
        logoDataUrl: true,
        rawCss: true,
      },
    });

    // Reference every image embedded in exported HTML so its bytes are bundled.
    for (const page of pages) {
      for (const id of extractImageIds(page.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }
    for (const row of siteContent) {
      for (const id of extractImageIds(row.contentHtml ?? "")) {
        ctx.media.reference(id);
      }
    }

    const entries: BundleEntry[] = [
      serialisePages(pages),
      serialiseSiteContent(siteContent),
    ];
    const themeEntry = serialiseTheme(theme);
    if (themeEntry) entries.push(themeEntry);
    return entries;
  },
};

// ---------------------------------------------------------------------------
// Import side (plan + apply). Upsert-only, never delete (ADR-002).
// ---------------------------------------------------------------------------

type TypedPage = {
  slug: string;
  path: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  sortOrder: number;
  contentHtml: string;
  published: boolean;
};

function coerceInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function coerceBool(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

function coercePage(row: Record<string, string>): TypedPage {
  return {
    slug: row.slug ?? "",
    path: row.path ?? "",
    caption: row.caption ?? "",
    menuTitle: row.menuTitle ?? "",
    title: row.title ?? "",
    headerText: row.headerText ?? "",
    sortOrder: coerceInt(row.sortOrder, 100),
    contentHtml: row.contentHtml ?? "",
    published: coerceBool(row.published),
  };
}

function readCsvFile(
  files: Map<string, Uint8Array>,
  path: string,
): Record<string, string>[] {
  const bytes = files.get(path);
  if (!bytes) return [];
  return parseCsv(strFromU8(bytes)).rows;
}

function readJsonFile<T>(
  files: Map<string, Uint8Array>,
  path: string,
): T | null {
  const bytes = files.get(path);
  if (!bytes) return null;
  return JSON.parse(strFromU8(bytes)) as T;
}


async function planSiteContent(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const fingerprintParts: string[] = [];

  // Pages (by slug).
  const incomingPages = readCsvFile(ctx.files, PAGE_FILE).map(coercePage);
  if (incomingPages.length > 0) {
    const existing = await ctx.db.pageContent.findMany({
      where: { slug: { in: incomingPages.map((p) => p.slug) } },
      select: {
        slug: true,
        path: true,
        caption: true,
        menuTitle: true,
        title: true,
        headerText: true,
        sortOrder: true,
        contentHtml: true,
        published: true,
      },
    });
    const byslug = new Map(existing.map((row) => [row.slug, row]));
    for (const page of incomingPages) {
      const current = byslug.get(page.slug);
      const currentHash = current
        ? hashRow([...PAGE_CONTENT_FIELDS], current)
        : "absent";
      fingerprintParts.push(`page-content:${page.slug}:${currentHash}`);
      if (!current) {
        items.push({ entity: "page-content", key: page.slug, action: "create" });
      } else {
        const changed = PAGE_CONTENT_FIELDS.filter(
          (f) => String(current[f] ?? "") !== String(page[f] ?? ""),
        );
        items.push(
          changed.length
            ? {
                entity: "page-content",
                key: page.slug,
                action: "update",
                changedFields: [...changed],
              }
            : { entity: "page-content", key: page.slug, action: "unchanged" },
        );
      }
    }
  }

  // Site content (by key).
  const incomingSite = readCsvFile(ctx.files, SITE_CONTENT_FILE);
  if (incomingSite.length > 0) {
    for (const row of incomingSite) {
      const key = row.key ?? "";
      const current = await ctx.db.siteContent.findUnique({
        where: { key: key as never },
        select: { key: true, contentHtml: true },
      });
      fingerprintParts.push(
        `site-content:${key}:${
          current ? hashRow([...SITE_CONTENT_FIELDS], current) : "absent"
        }`,
      );
      if (!current) {
        items.push({ entity: "site-content", key, action: "create" });
      } else {
        items.push(
          String(current.contentHtml) !== String(row.contentHtml ?? "")
            ? { entity: "site-content", key, action: "update", changedFields: ["contentHtml"] }
            : { entity: "site-content", key, action: "unchanged" },
        );
      }
    }
  }

  // Theme (singleton).
  const theme = readJsonFile<Record<string, unknown>>(ctx.files, THEME_FILE);
  if (theme) {
    const current = await ctx.db.clubTheme.findUnique({
      where: { id: "default" },
      select: Object.fromEntries(
        CLUB_THEME_FIELDS.map((f) => [f, true]),
      ) as Record<string, true>,
    });
    fingerprintParts.push(
      `club-theme:default:${
        current ? hashRow([...CLUB_THEME_FIELDS], current) : "absent"
      }`,
    );
    items.push({
      entity: "club-theme",
      key: "default",
      action: current ? "update" : "create",
    });
  }

  if (incomingPages.some((p) => /\/api\/images\//.test(p.contentHtml))) {
    warnings.push(
      "Some pages embed images; their bytes are re-imported and references remapped.",
    );
  }

  return { items, warnings, fingerprintParts };
}

async function applySiteContent(
  ctx: ApplyContext,
): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  const oldToNew = ctx.imageRemap;

  // Pages.
  for (const raw of readCsvFile(ctx.files, PAGE_FILE)) {
    const page = coercePage(raw);
    const html = sanitizePageContentHtml(
      remapImageRefs(page.contentHtml, oldToNew),
    );
    const existing = await ctx.tx.pageContent.findUnique({
      where: { slug: page.slug },
      select: { id: true },
    });
    const data = {
      path: page.path,
      caption: page.caption,
      menuTitle: page.menuTitle,
      title: page.title,
      headerText: page.headerText,
      sortOrder: page.sortOrder,
      contentHtml: html,
      published: page.published,
    };
    await ctx.tx.pageContent.upsert({
      where: { slug: page.slug },
      create: { slug: page.slug, ...data },
      update: updateDataForMode(ctx.mode, raw, data),
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  // Site content.
  for (const row of readCsvFile(ctx.files, SITE_CONTENT_FILE)) {
    const key = row.key ?? "";
    const html = sanitizePageContentHtml(
      remapImageRefs(row.contentHtml ?? "", oldToNew),
    );
    const existing = await ctx.tx.siteContent.findUnique({
      where: { key: key as never },
      select: { id: true },
    });
    await ctx.tx.siteContent.upsert({
      where: { key: key as never },
      create: { key: key as never, contentHtml: html },
      update: updateDataForMode(ctx.mode, row, { contentHtml: html }),
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  // Theme (singleton, replace-present of allowlisted fields).
  const theme = readJsonFile<Record<string, unknown>>(ctx.files, THEME_FILE);
  if (theme) {
    const data: Record<string, unknown> = {};
    for (const field of CLUB_THEME_FIELDS) {
      if (field in theme) data[field] = theme[field];
    }
    const existing = await ctx.tx.clubTheme.findUnique({
      where: { id: "default" },
      select: { id: true },
    });
    // The theme row has required columns with no DB defaults; a create relies on
    // the bundle carrying them (validated by Prisma at runtime). Cast the dynamic
    // projection to the create input.
    await ctx.tx.clubTheme.upsert({
      where: { id: "default" },
      create: { id: "default", ...data } as Prisma.ClubThemeUncheckedCreateInput,
      update: updateDataForMode(ctx.mode, theme, data),
    });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  return result;
}

export const siteContentImporter: CategoryImporter = {
  category: "site-content",
  plan: planSiteContent,
  apply: applySiteContent,
};
