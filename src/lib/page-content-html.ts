import "server-only";

import sanitizeHtml from "sanitize-html";
import { prisma } from "@/lib/prisma";
import type { EditablePageRecord } from "@/lib/page-content";

// Hardcoded literal regexes (not a dynamic `new RegExp`) so the pattern can
// never be shaped by input and there is no non-literal-RegExp/ReDoS surface.
const PIXEL_DIMENSION_PATTERNS = {
  width: /width\s*:\s*(\d+)(?:px)?\b/i,
  height: /height\s*:\s*(\d+)(?:px)?\b/i,
} as const;

function extractPixelDimension(
  style: string,
  property: "width" | "height",
): string | null {
  const match = style.match(PIXEL_DIMENSION_PATTERNS[property]);
  return match?.[1] ?? null;
}

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a",
    "article",
    "b",
    "blockquote",
    "br",
    "caption",
    "circle",
    "code",
    "data",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "line",
    "main",
    "ol",
    "p",
    "path",
    "polygon",
    "pre",
    "rect",
    "s",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "svg",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    // "open" is a boolean state attribute (no scriptable surface); it lets
    // CMS authors pre-expand an accordion item.
    details: ["open"],
    img: ["src", "alt", "width", "height"],
    th: ["colspan", "rowspan"],
    td: ["colspan", "rowspan"],
    svg: [
      "xmlns",
      "viewbox",
      "width",
      "height",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    polygon: [
      "points",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    path: [
      "d",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    rect: [
      "x",
      "y",
      "width",
      "height",
      "rx",
      "ry",
      "fill",
      "stroke",
      "stroke-width",
      "stroke-linecap",
      "stroke-linejoin",
    ],
    circle: ["cx", "cy", "r"],
    line: ["x1", "y1", "x2", "y2"],
    "*": ["class", "aria-hidden"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https"],
  },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        rel: "noopener noreferrer",
      },
    }),
    img: (tagName, attribs) => {
      const style = attribs.style ?? "";
      const width = extractPixelDimension(style, "width");
      const height = extractPixelDimension(style, "height");
      const nextAttribs: Record<string, string> = {
        ...attribs,
      };

      if (width && !nextAttribs.width) {
        nextAttribs.width = width;
      }
      if (height && !nextAttribs.height) {
        nextAttribs.height = height;
      }

      delete nextAttribs.style;

      return {
        tagName,
        attribs: nextAttribs,
      };
    },
  },
};

export interface SanitizePageContentHtmlOptions {
  /**
   * Lobby-display authoring/render path ONLY (issue #161, ADR-003 residual):
   * constrain `<img>` src to relative/root-absolute paths or `data:` URIs,
   * matching the display CSP's `img-src 'self' data:` (src/lib/csp.ts) so an
   * authoring admin gets a save-time sanitiser signal instead of an image the
   * browser silently refuses to fetch on the unattended wall. The CMS default
   * (this flag omitted/false) is UNCHANGED — public-site page content keeps
   * allowing `http`/`https` image sources, which `data:` URIs deliberately do
   * not (see the "keeps uploaded image library URLs but strips data: URIs"
   * test) — do not flip this default.
   */
  restrictImgSrc?: boolean;
}

export function sanitizePageContentHtml(
  contentHtml: string,
  options: SanitizePageContentHtmlOptions = {},
): string {
  const sanitizeOptions: sanitizeHtml.IOptions = options.restrictImgSrc
    ? {
        ...SANITIZE_OPTIONS,
        // Replaces (not extends) SANITIZE_OPTIONS.allowedSchemesByTag — img is
        // its only key today. Dropping http/https here silently strips the
        // whole `src` attribute (same mechanism the CMS default already uses
        // to strip data: — see the "strips data: URIs" test) and allowing
        // data: instead means a display author's now-blocked external image
        // renders with no src rather than throwing.
        allowedSchemesByTag: { img: ["data"] },
      }
    : SANITIZE_OPTIONS;
  return sanitizeHtml(contentHtml, sanitizeOptions).trim();
}

/**
 * Strips all markup, for contexts that need plain text (meta descriptions).
 */
export function pageContentHtmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

function toEditablePageRecord(record: {
  id: string;
  slug: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  path: string;
  sortOrder: number;
  contentHtml: string;
  published: boolean;
  updatedAt: Date;
  updatedByMemberId: string | null;
}): EditablePageRecord {
  return {
    id: record.id,
    slug: record.slug,
    caption: record.caption,
    menuTitle: record.menuTitle,
    title: record.title,
    headerText: record.headerText,
    path: record.path,
    sortOrder: record.sortOrder,
    contentHtml: record.contentHtml,
    published: record.published,
    updatedAt: record.updatedAt.toISOString(),
    updatedByMemberId: record.updatedByMemberId,
  };
}

export async function getSanitizedPageContentByPath(path: string): Promise<{
  id: string;
  slug: string;
  caption: string;
  menuTitle: string;
  title: string;
  headerText: string;
  path: string;
  sortOrder: number;
  contentHtml: string;
  published: boolean;
} | null> {
  const record = await prisma.pageContent.findUnique({
    where: { path },
    select: {
      id: true,
      slug: true,
      caption: true,
      menuTitle: true,
      title: true,
      headerText: true,
      path: true,
      sortOrder: true,
      contentHtml: true,
      published: true,
    },
  });

  if (!record) {
    return null;
  }

  // Defence in depth: stored values are sanitised on write, but render
  // paths inject both fields with dangerouslySetInnerHTML, so sanitise
  // again on read in case a record was written through another path.
  const safeContentHtml = sanitizePageContentHtml(record.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(record.headerText);

  return {
    id: record.id,
    slug: record.slug,
    caption: record.caption,
    menuTitle: record.menuTitle,
    title: record.title,
    headerText: safeHeaderText,
    path: record.path,
    sortOrder: record.sortOrder,
    contentHtml: safeContentHtml,
    // Defaults to true for legacy rows written before this column existed.
    published: record.published ?? true,
  };
}

export async function listEditablePageContent() {
  const records = await prisma.pageContent.findMany({
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });

  return records.map(toEditablePageRecord);
}

export async function listWebsiteMenuPages() {
  const records = await prisma.pageContent.findMany({
    // Hidden (unpublished) pages drop out of the public navigation.
    where: { published: true },
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
    select: {
      slug: true,
      caption: true,
      menuTitle: true,
      title: true,
      path: true,
      sortOrder: true,
    },
  });

  return records.filter((record) => record.menuTitle.trim().length > 0);
}
