import { strToU8, strFromU8 } from "fflate";
import type { Prisma } from "@prisma/client";

import { sanitizePageContentHtml } from "@/lib/page-content-html";
import {
  canUnpublishPage,
  isReservedPageSlug,
  isValidPageSlug,
  PAGE_CONTENT_LIMITS,
  SITE_CONTENT_KEYS,
  SITE_CONTENT_LIMITS,
  SYSTEM_PAGE_SLUGS,
  toPagePath,
} from "@/lib/page-content";
import { remapImageRefs } from "../media";
import type { BundleEntry } from "../bundle";

// Re-exported for tests and other categories that rewrite image references.
export { remapImageRefs };
import { serialiseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  applyRow,
  changedFields,
  hashRow,
  planActionFor,
  updateDataForMode,
  type CategoryImporter,
  type CategoryApplyResult,
  type CategoryPlanResult,
  type PlanContext,
  type ApplyContext,
  type PlanItem,
  type ReadDb,
} from "../import-types";
import {
  RowValidator,
  asStr,
  nz,
  readCsvRows,
  strictBool,
  strictInt,
  type Valid,
} from "../values";

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

registerEntity({
  entity: "page-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: PAGE_FILE,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...PAGE_CONTENT_FIELDS],
});

registerEntity({
  entity: "site-content",
  category: "site-content",
  tier: "key-strong",
  format: "csv",
  file: SITE_CONTENT_FILE,
  naturalKey: ["key"],
  singleton: false,
  fields: [...SITE_CONTENT_FIELDS],
});

registerEntity({
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
// Import side (plan + apply). Upsert-only, never delete (ADR-002). Row
// validation is strict (errors block apply); pages and site content are
// batch-loaded, and the same parsed rows feed plan and apply.
// ---------------------------------------------------------------------------

interface ParsedPageRow {
  raw: Record<string, string>;
  slug: string;
  data: {
    path: string;
    caption: string;
    menuTitle: string;
    title: string;
    headerText: string;
    sortOrder: number;
    contentHtml: string;
    published: boolean;
  };
}

/**
 * Strict page-slug cell: the same rules the admin page-content route applies
 * (src/app/api/admin/page-content/route.ts). A hand-edited bundle must not
 * write a slug the admin UI would reject — or one whose segments shadow a
 * reserved application route (admin, api, book, ...).
 */
function strictPageSlug(value: unknown): Valid<string> {
  const s = asStr(value).trim();
  if (s === "") return { ok: false, message: "must not be blank" };
  if (s.length > PAGE_CONTENT_LIMITS.slugMax) {
    return {
      ok: false,
      message: `must be at most ${PAGE_CONTENT_LIMITS.slugMax} characters`,
    };
  }
  if (!isValidPageSlug(s)) {
    return {
      ok: false,
      message: `"${s}" is not a valid page slug (lowercase letters, numbers, and hyphens, with optional forward slashes between segments)`,
    };
  }
  if (isReservedPageSlug(s)) {
    return { ok: false, message: `"${s}" uses a reserved route segment` };
  }
  return { ok: true, value: s };
}

/**
 * Field-cap parity with the admin route's zod schemas: the same
 * PAGE_CONTENT_LIMITS values, measured the same way (`trimmed` mirrors the
 * schema's .trim(); headerText/contentHtml are capped untrimmed, exactly like
 * the route, and BEFORE sanitisation, exactly like the route). The returned
 * value is the MEASURED form — trimmed fields come back trimmed, mirroring
 * zod's .trim() transform, so the import stores exactly what the admin route
 * would store (#1732).
 */
function withinCap(
  value: unknown,
  max: number,
  trimmed: boolean,
): Valid<string> {
  const s = trimmed ? asStr(value).trim() : asStr(value);
  if (s.length > max) {
    return { ok: false, message: `must be at most ${max} characters` };
  }
  return { ok: true, value: s };
}

/** Title parity: required (unless merge keeps the existing one) and capped. */
function strictPageTitle(value: unknown, blankOk: boolean): Valid<string> {
  if (nz(value) === null && !blankOk) {
    return { ok: false, message: "must not be blank" };
  }
  return withinCap(value, PAGE_CONTENT_LIMITS.titleMax, true);
}

/**
 * sortOrder parity: the admin route's 0–9999 range, plus its system-page rule
 * — the menu order of home/404 is fixed, so a bundle must not move an existing
 * system page to any other value. Re-importing the page's CURRENT order stays
 * legal: seeded databases hold home at the starter order until an admin edit
 * normalises it to the fixed one, and a healthy export must round-trip clean.
 */
function strictPageSortOrder(
  value: unknown,
  slug: string,
  currentSortOrder: number | null,
): Valid<number> {
  const parsed = strictInt(value);
  if (!parsed.ok) return parsed;
  const n = parsed.value;
  if (
    n < PAGE_CONTENT_LIMITS.sortOrderMin ||
    n > PAGE_CONTENT_LIMITS.sortOrderMax
  ) {
    return {
      ok: false,
      message: `must be between ${PAGE_CONTENT_LIMITS.sortOrderMin} and ${PAGE_CONTENT_LIMITS.sortOrderMax}`,
    };
  }
  const fixedOrder = SYSTEM_PAGE_SLUGS.get(slug);
  if (
    fixedOrder !== undefined &&
    currentSortOrder !== null &&
    n !== fixedOrder &&
    n !== currentSortOrder
  ) {
    return {
      ok: false,
      message: `menu order for system page "${slug}" is fixed at ${fixedOrder} and cannot be changed`,
    };
  }
  return parsed;
}

/**
 * published parity: pages the admin route refuses to unpublish — system pages
 * (home, 404) and built-in design pages (canUnpublishPage) — must not be
 * hidden by a bundle either.
 */
function strictPagePublished(value: unknown, slug: string): Valid<boolean> {
  const parsed = strictBool(value);
  if (!parsed.ok) return parsed;
  if (!parsed.value && !canUnpublishPage(slug)) {
    return {
      ok: false,
      message: `page "${slug}" cannot be hidden from the public site`,
    };
  }
  return parsed;
}

/** Validate + build a page row; blanks legal only where merge keeps existing. */
function parsePageRow(
  index: number,
  raw: Record<string, string>,
  blankOk: boolean,
  errors: string[],
  /** The existing DB row for this slug (allowlisted projection), if any. */
  current: Record<string, unknown> | null,
): ParsedPageRow | null {
  const v = new RowValidator(PAGE_FILE, index, errors);
  const slug = v.custom("slug", strictPageSlug(raw.slug), "");
  // Field caps + system-page protections: parity with the admin route's zod
  // schemas and PUT/PATCH guards (src/app/api/admin/page-content/route.ts),
  // through the shared PAGE_CONTENT_LIMITS / SYSTEM_PAGE_SLUGS /
  // canUnpublishPage. Violations are row errors that block apply. The trimmed
  // fields (caption/menuTitle/title) keep the validator's TRIMMED value — the
  // admin route stores the zod-trimmed form, so the import must too. parsePageRow
  // feeds plan and apply alike, so the change preview diffs against the trimmed
  // value apply would write: a legacy row whose stored value is untrimmed plans
  // as one update, then converges to "unchanged" on re-import (#1732).
  const caption = v.custom(
    "caption",
    withinCap(raw.caption, PAGE_CONTENT_LIMITS.captionMax, true),
    "",
  );
  const menuTitle = v.custom(
    "menuTitle",
    withinCap(raw.menuTitle, PAGE_CONTENT_LIMITS.menuTitleMax, true),
    "",
  );
  const title = v.custom("title", strictPageTitle(raw.title, blankOk), "");
  v.custom(
    "headerText",
    withinCap(raw.headerText, PAGE_CONTENT_LIMITS.headerTextMax, false),
    "",
  );
  v.custom(
    "contentHtml",
    withinCap(raw.contentHtml, PAGE_CONTENT_LIMITS.contentHtmlMax, false),
    "",
  );
  const currentSortOrder =
    typeof current?.sortOrder === "number" ? current.sortOrder : null;
  const sortOrder =
    nz(raw.sortOrder) === null && blankOk
      ? 100
      : v.custom(
          "sortOrder",
          strictPageSortOrder(raw.sortOrder ?? "", slug, currentSortOrder),
          0,
        );
  const published =
    nz(raw.published) === null && blankOk
      ? false
      : v.custom(
          "published",
          strictPagePublished(raw.published ?? "", slug),
          false,
        );
  if (!v.ok) return null;
  return {
    raw,
    slug,
    data: {
      // Derived from the slug, never trusted from the file — a crafted path
      // cell could otherwise disagree with the slug (mirrors the admin route).
      path: toPagePath(slug),
      caption,
      menuTitle,
      title,
      // Stored sanitised, exactly like the admin write path. Both plan and
      // apply consume this value, so the change preview diffs against what
      // apply would actually write.
      headerText: sanitizePageContentHtml(raw.headerText ?? ""),
      sortOrder,
      contentHtml: raw.contentHtml ?? "",
      published,
    },
  };
}

function readThemeFile(
  files: Map<string, Uint8Array>,
  errors: string[],
): Record<string, unknown> | null {
  const bytes = files.get(THEME_FILE);
  if (!bytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(bytes));
  } catch (error) {
    errors.push(
      `${THEME_FILE}: not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
    );
    return null;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    errors.push(`${THEME_FILE}: must be a JSON object`);
    return null;
  }
  const record = json as Record<string, unknown>;
  let ok = true;
  for (const field of CLUB_THEME_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value !== null && typeof value !== "string") {
      errors.push(`${THEME_FILE}: ${field} — must be a string (or null)`);
      ok = false;
    }
  }
  return ok ? record : null;
}

interface SiteContentBatch {
  pages: Map<string, Record<string, unknown> & { id?: string }>;
  siteContent: Map<string, { id: string; key: string; contentHtml: string }>;
  theme: Record<string, unknown> | null;
}

/** O(1) membership for the recognised keyed site-content keys. */
const SITE_CONTENT_KEY_SET: ReadonlySet<string> = new Set(SITE_CONTENT_KEYS);

/**
 * Strict site-content key cell: parity with the admin keyed site-content
 * route's `z.enum(SITE_CONTENT_KEYS)` (src/app/api/admin/site-content/route.ts).
 * We validate against that write allowlist — not the wider Prisma enum via
 * strictEnum — because the DB `key` column is an enum: an unrecognised key from
 * a hand-edited bundle must fail here as a clean row error, before it reaches
 * the batch `findMany`, where Prisma would otherwise throw a validation error
 * against the enum column instead of surfacing the row.
 */
function strictSiteContentKey(value: unknown): Valid<string> {
  const s = asStr(value).trim();
  if (s === "") return { ok: false, message: "must not be blank" };
  if (!SITE_CONTENT_KEY_SET.has(s)) {
    return {
      ok: false,
      message: `"${s}" is not a recognised site-content key`,
    };
  }
  return { ok: true, value: s };
}

async function loadSiteContentBatch(
  db: ReadDb,
  slugs: string[],
  keys: string[],
): Promise<SiteContentBatch> {
  const [pageRows, siteRows, theme] = await Promise.all([
    slugs.length
      ? db.pageContent.findMany({
          where: { slug: { in: slugs } },
          select: {
            id: true,
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
        })
      : Promise.resolve([]),
    keys.length
      ? db.siteContent.findMany({
          where: { key: { in: keys as never[] } },
          select: { id: true, key: true, contentHtml: true },
        })
      : Promise.resolve([]),
    db.clubTheme.findUnique({
      where: { id: "default" },
      select: Object.fromEntries(
        CLUB_THEME_FIELDS.map((f) => [f, true]),
      ) as Record<string, true>,
    }),
  ]);
  return {
    pages: new Map(pageRows.map((r) => [r.slug, r])),
    siteContent: new Map(siteRows.map((r) => [String(r.key), r])),
    theme,
  };
}

async function planSiteContent(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const fingerprintParts: string[] = [];

  const rawPages = readCsvRows(ctx.files, PAGE_FILE);
  const rawSite = readCsvRows(ctx.files, SITE_CONTENT_FILE);
  const batch = await loadSiteContentBatch(
    ctx.db,
    rawPages.map((r) => r.slug?.trim() ?? "").filter(Boolean),
    // Only recognised keys reach the batch findMany: the DB key column is a
    // Prisma enum, so an unknown key would throw there instead of surfacing as
    // a clean row error (validated below via strictSiteContentKey).
    rawSite
      .map((r) => r.key?.trim() ?? "")
      .filter((k) => SITE_CONTENT_KEY_SET.has(k)),
  );

  // Pages (by slug).
  let anyEmbeddedImages = false;
  rawPages.forEach((raw, i) => {
    const current = batch.pages.get(raw.slug?.trim() ?? "") ?? null;
    const parsed = parsePageRow(
      i,
      raw,
      ctx.mode === "merge" && !!current,
      errors,
      current,
    );
    if (!parsed) return;
    if (/\/api\/images\//.test(parsed.data.contentHtml)) anyEmbeddedImages = true;
    fingerprintParts.push(
      `page-content:${parsed.slug}:${current ? hashRow([...PAGE_CONTENT_FIELDS], current) : "absent"}`,
    );
    // contentHtml diffs against the sanitised form (imageRemap is apply-time;
    // for image-embedding pages this is conservative — may say "changed").
    const write = updateDataForMode(ctx.mode, raw, {
      ...parsed.data,
      contentHtml: sanitizePageContentHtml(parsed.data.contentHtml),
    });
    const changed = changedFields(write, current);
    items.push({
      entity: "page-content",
      key: parsed.slug,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  });

  // Site content (by key).
  rawSite.forEach((raw, i) => {
    const v = new RowValidator(SITE_CONTENT_FILE, i, errors);
    // Key parity with the admin route's z.enum(SITE_CONTENT_KEYS): an
    // unrecognised key is a clean row error, never a create against the enum.
    const key = v.custom("key", strictSiteContentKey(raw.key), "");
    // Field-cap parity with the keyed site-content route's zod schema
    // (src/app/api/admin/site-content/route.ts): the shared SITE_CONTENT_LIMITS,
    // measured untrimmed and BEFORE sanitisation, exactly like the route.
    v.custom(
      "contentHtml",
      withinCap(raw.contentHtml, SITE_CONTENT_LIMITS.contentHtmlMax, false),
      "",
    );
    if (!v.ok) return;
    const current = batch.siteContent.get(key) ?? null;
    fingerprintParts.push(
      `site-content:${key}:${current ? hashRow([...SITE_CONTENT_FIELDS], current) : "absent"}`,
    );
    const write = updateDataForMode(ctx.mode, raw, {
      contentHtml: sanitizePageContentHtml(raw.contentHtml ?? ""),
    });
    const changed = changedFields(write, current);
    items.push({
      entity: "site-content",
      key,
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  });

  // Theme (singleton).
  const theme = readThemeFile(ctx.files, errors);
  if (theme) {
    const current = batch.theme;
    fingerprintParts.push(
      `club-theme:default:${current ? hashRow([...CLUB_THEME_FIELDS], current) : "absent"}`,
    );
    const data: Record<string, unknown> = {};
    for (const f of CLUB_THEME_FIELDS) if (f in theme) data[f] = theme[f];
    const write = updateDataForMode(ctx.mode, theme, data);
    const changed = changedFields(write, current);
    items.push({
      entity: "club-theme",
      key: "default",
      action: planActionFor(current, changed),
      changedFields: changed.length ? changed : undefined,
    });
  }

  if (anyEmbeddedImages) {
    warnings.push(
      "Some pages embed images; their bytes are re-imported and references remapped.",
    );
  }

  return { items, warnings, errors, fingerprintParts };
}

async function applySiteContent(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  const errors: string[] = []; // plan blocked all errors; defensive only
  const oldToNew = ctx.imageRemap;

  const rawPages = readCsvRows(ctx.files, PAGE_FILE);
  const rawSite = readCsvRows(ctx.files, SITE_CONTENT_FILE);
  const batch = await loadSiteContentBatch(
    ctx.tx,
    rawPages.map((r) => r.slug?.trim() ?? "").filter(Boolean),
    // Same enum-safe key filter as plan: an unknown key must never reach the
    // batch findMany (plan already blocked it; defensive for direct callers).
    rawSite
      .map((r) => r.key?.trim() ?? "")
      .filter((k) => SITE_CONTENT_KEY_SET.has(k)),
  );

  // Pages.
  for (const [i, raw] of rawPages.entries()) {
    const current = batch.pages.get(raw.slug?.trim() ?? "") ?? null;
    const parsed = parsePageRow(
      i,
      raw,
      ctx.mode === "merge" && !!current,
      errors,
      current,
    );
    if (!parsed) { result.skipped += 1; continue; }
    const html = sanitizePageContentHtml(
      remapImageRefs(parsed.data.contentHtml, oldToNew),
    );
    await applyRow({
      mode: ctx.mode,
      raw,
      data: { ...parsed.data, contentHtml: html },
      current,
      create: (data) =>
        ctx.tx.pageContent.create({ data: { slug: parsed.slug, ...data } }),
      update: (write) =>
        ctx.tx.pageContent.update({
          where: { slug: parsed.slug },
          data: write,
        }),
      result,
    });
  }

  // Site content.
  for (const [i, raw] of rawSite.entries()) {
    const v = new RowValidator(SITE_CONTENT_FILE, i, errors);
    // Key parity with the admin route (plan already blocked an unknown key;
    // defensive, mirroring the page path).
    const key = v.custom("key", strictSiteContentKey(raw.key), "");
    // Cap parity with the keyed site-content route (plan already blocked this;
    // defensive, mirroring the page path).
    v.custom(
      "contentHtml",
      withinCap(raw.contentHtml, SITE_CONTENT_LIMITS.contentHtmlMax, false),
      "",
    );
    if (!v.ok) { result.skipped += 1; continue; }
    const current = batch.siteContent.get(key) ?? null;
    const html = sanitizePageContentHtml(
      remapImageRefs(raw.contentHtml ?? "", oldToNew),
    );
    await applyRow({
      mode: ctx.mode,
      raw,
      data: { contentHtml: html },
      current,
      create: (data) =>
        ctx.tx.siteContent.create({ data: { key: key as never, ...data } }),
      update: (write) =>
        ctx.tx.siteContent.update({ where: { key: key as never }, data: write }),
      result,
    });
  }

  // Theme (singleton, replace-present of allowlisted fields).
  const theme = readThemeFile(ctx.files, errors);
  if (theme) {
    const data: Record<string, unknown> = {};
    for (const field of CLUB_THEME_FIELDS) {
      if (field in theme) data[field] = theme[field];
    }
    const current = batch.theme;
    if (!current) {
      // The theme row has required columns with no DB defaults; a create relies
      // on the bundle carrying them (validated by Prisma at runtime).
      await ctx.tx.clubTheme.create({
        data: { id: "default", ...data } as Prisma.ClubThemeUncheckedCreateInput,
      });
      result.created += 1;
    } else {
      const write = updateDataForMode(ctx.mode, theme, data);
      const changed = changedFields(write, current);
      if (changed.length === 0) {
        result.unchanged += 1;
      } else {
        await ctx.tx.clubTheme.update({ where: { id: "default" }, data: write });
        result.updated += 1;
      }
    }
  }

  return result;
}

export const siteContentImporter: CategoryImporter = {
  category: "site-content",
  plan: planSiteContent,
  apply: applySiteContent,
};
