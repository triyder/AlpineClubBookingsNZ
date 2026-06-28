import "server-only";

import sanitizeHtml from "sanitize-html";
import { prisma } from "@/lib/prisma";
import type { EditablePageRecord } from "@/lib/page-content";
import {
  toStructuredContentValues,
  type StructuredContentValues,
} from "@/lib/page-content-schema";

function extractPixelDimension(
  style: string,
  property: "width" | "height",
): string | null {
  const match = style.match(
    new RegExp(`${property}\\s*:\\s*(\\d+)(?:px)?\\b`, "i"),
  );
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
    "pre",
    "rect",
    "s",
    "section",
    "small",
    "span",
    "strong",
    "sub",
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

export function sanitizePageContentHtml(contentHtml: string): string {
  return sanitizeHtml(contentHtml, SANITIZE_OPTIONS).trim();
}

/**
 * Strips all markup, for contexts that need plain text (meta descriptions).
 */
export function pageContentHtmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strips markup from a structured-content string while PRESERVING newlines and
 * decoding entities back to plain characters. Unlike pageContentHtmlToPlainText
 * (used for meta descriptions) this keeps paragraph/line breaks intact for the
 * multi-line body sections, and decodes &amp;/&lt;/&gt;/&quot;/&#39; so an
 * ampersand stays an ampersand rather than rendering as "&amp;". Design pages
 * render the result as escaped React text, so this is plain-text hygiene, not
 * the security boundary.
 */
function toStructuredPlainText(value: string): string {
  const lineBreakNormalized = value.replace(/<br\s*\/?>/gi, "\n");
  const stripped = sanitizeHtml(lineBreakNormalized, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return (
    stripped
      // Decode the entities sanitize-html emits for text (decode &amp; last).
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&amp;/gi, "&")
      // Normalise line endings, trim trailing spaces, cap blank-line runs.
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Plain-text only: strips all markup from every string in a structured-content
 * object (scalar values and every cell of every row). Design pages render these
 * as escaped React text, never as HTML, so this is belt-and-braces against any
 * markup sneaking in through the API or a hand-edited record.
 */
export function sanitizeStructuredContent(
  value: unknown,
): StructuredContentValues {
  const coerced = toStructuredContentValues(value);
  const out: StructuredContentValues = {};
  for (const [key, raw] of Object.entries(coerced)) {
    if (typeof raw === "string") {
      out[key] = toStructuredPlainText(raw);
    } else {
      out[key] = raw.map((row) => {
        const cleaned: Record<string, string> = {};
        for (const [cellKey, cellValue] of Object.entries(row)) {
          cleaned[cellKey] = toStructuredPlainText(cellValue);
        }
        return cleaned;
      });
    }
  }
  return out;
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
  structuredContent: unknown;
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
    // Re-strip on read: editor and public render both treat these as plain text.
    structuredContent: sanitizeStructuredContent(record.structuredContent),
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
  structuredContent: StructuredContentValues;
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
      structuredContent: true,
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
    // Design pages render these as escaped React text; strip markup anyway.
    structuredContent: sanitizeStructuredContent(record.structuredContent),
  };
}

export async function getSanitizedPageContentHtmlByPath(
  path: string,
): Promise<string | null> {
  const record = await getSanitizedPageContentByPath(path);
  return record?.contentHtml ?? null;
}

export async function listEditablePageContent() {
  const records = await prisma.pageContent.findMany({
    orderBy: [{ sortOrder: "asc" }, { title: "asc" }],
  });

  return records.map(toEditablePageRecord);
}

export async function listWebsiteMenuPages() {
  const records = await prisma.pageContent.findMany({
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
