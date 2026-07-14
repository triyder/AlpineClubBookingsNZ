import "server-only";

import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  imagePublicUrl,
  resolveInImagesRoot,
} from "@/lib/image-storage";
import {
  CLUB_FACEBOOK_URL,
  CLUB_HUT_LEADER_LABEL,
  CLUB_NAME,
  CLUB_PUBLIC_URL,
} from "@/config/club-identity";
import { APP_CURRENCY } from "@/config/operational";
import {
  getDefaultLodgeCapacity,
  getLodgeCapacity,
} from "@/lib/lodge-capacity";
import logger from "@/lib/logger";
import { extractImageDimensions } from "@/lib/media-image";
import {
  embedTokenNames,
  legacySingleBraceTokenNames,
  parameterisedTextTokenNames,
  plainTextTokenNames,
} from "@/lib/token-catalogue";
import {
  loadPublicBookingPolicy,
  loadPublicCancellationPolicy,
  loadPublicEntranceFees,
  loadPublicHutFees,
  loadPublicMembershipTypes,
  type PublicBookingPolicy,
  type PublicCancellationPolicy,
  type PublicEntranceFee,
  type PublicHutFeeLodge,
  type PublicMembershipType,
} from "@/lib/public-page-content-tokens";

export type PhotoGalleryImage = {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
};

export type EmbeddedBodyPart =
  | { type: "html"; value: string }
  | { type: "committee" }
  | { type: "member-application-form" }
  | { type: "contact-form" }
  | { type: "skifield-conditions"; dataHash?: string }
  | { type: "skifield-whakapapa" }
  | { type: "photo-gallery"; images: PhotoGalleryImage[] }
  | { type: "photo-slideshow"; images: PhotoGalleryImage[] }
  | { type: "membership-types"; items: PublicMembershipType[] }
  | { type: "entrance-fees"; items: PublicEntranceFee[] }
  | { type: "hut-fees"; lodges: PublicHutFeeLodge[] }
  | { type: "booking-policy-summary"; policy: PublicBookingPolicy | null }
  | { type: "cancellation-policy"; policy: PublicCancellationPolicy | null };

type ParsedEmbedToken = {
  token: string;
  parameter: string | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Both matchers are derived from src/lib/token-catalogue.ts (single source of
// truth) and built once at module load. Matching behaviour is unchanged from
// the previous hardcoded regexes: case-insensitive, whitespace tolerant,
// double braces with an optional `:parameter`, and the legacy single-brace
// form only for legacy-enabled embed tokens (photo tokens excluded).
const EMBED_TOKEN_ALTERNATION = embedTokenNames().map(escapeRegExp).join("|");
const LEGACY_TOKEN_ALTERNATION = legacySingleBraceTokenNames()
  .map(escapeRegExp)
  .join("|");
const PARAM_TEXT_TOKEN_ALTERNATION = parameterisedTextTokenNames()
  .map(escapeRegExp)
  .join("|");
const PLAIN_TEXT_TOKEN_ALTERNATION = plainTextTokenNames()
  .map(escapeRegExp)
  .join("|");

// test seam
export const EMBED_TOKEN_REGEX = new RegExp(
  `\\{\\{\\s*(${EMBED_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?\\s*\\}\\}` +
    `|\\{\\s*(${LEGACY_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?\\s*\\}`,
  "gi",
);
// Text tokens match bare, except those whose catalogue entry declares
// parameter support (allowsParameter — the multi-lodge
// {{lodge-capacity:lodge-slug}} form). Group 1/2 = parameterised token and
// its optional parameter; group 3 = plain token.
// test seam
export const TEXT_TOKEN_REGEX = new RegExp(
  `\\{\\{\\s*(?:(${PARAM_TEXT_TOKEN_ALTERNATION})(?:\\s*:\\s*([^{}]+?))?|(${PLAIN_TEXT_TOKEN_ALTERNATION}))\\s*\\}\\}`,
  "gi",
);

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * {{lodge-capacity}} resolves the default lodge's capacity (the pre-
 * multi-lodge behaviour); {{lodge-capacity:lodge-slug}} resolves the named
 * lodge's capacity so multi-lodge pages can state each property's size.
 * An unknown slug falls back to the default lodge rather than rendering
 * a broken page.
 */
async function resolveLodgeCapacityToken(
  parameter: string | undefined,
): Promise<number> {
  if (parameter) {
    try {
      const { prisma } = await import("@/lib/prisma");
      const lodge = await prisma.lodge.findUnique({
        where: { slug: parameter },
        select: { id: true },
      });
      if (lodge) {
        return await getLodgeCapacity(lodge.id);
      }
    } catch {
      // fall through to the default lodge
    }
  }
  return getDefaultLodgeCapacity();
}

// URL schemes a token value may safely carry into an href attribute. Mirrors
// allowedSchemes in page-content-html.ts, whose sanitiser cannot vet token
// values because tokens resolve after sanitisation.
const SAFE_TOKEN_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isSafeTokenUrl(value: string): boolean {
  try {
    return SAFE_TOKEN_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Warn once per offending config value so a bad deploy shows up in the logs
// without repeating on every render.
const warnedUnsafeTokenUrls = new Set<string>();

// Authors place URL tokens inside href attributes (the starter footer uses
// <a href="{{facebook-url}}">), and because resolution runs after
// sanitisation the sanitiser's scheme allowlist never sees the resolved
// value. HTML-escaping does not neutralise a dangerous URL scheme, so
// enforce the same http/https/mailto allowlist here before injection.
function safeTokenUrl(token: string, value: string): string {
  if (isSafeTokenUrl(value)) {
    return value;
  }
  if (!warnedUnsafeTokenUrls.has(value)) {
    warnedUnsafeTokenUrls.add(value);
    logger.warn(
      { token },
      "Blocked text-token config value with a disallowed URL scheme; only http, https, and mailto URLs are rendered.",
    );
  }
  return isSafeTokenUrl(CLUB_PUBLIC_URL) ? CLUB_PUBLIC_URL : "#";
}

// Exported for reuse by other sanitised HTML surfaces (lodge instructions).
// Replacement values are HTML-escaped via escapeHtmlText and URL-bearing
// tokens are additionally scheme-validated via safeTokenUrl, so this stays
// safe to run after sanitisation.
export async function resolveTextTokens(contentHtml: string): Promise<string> {
  TEXT_TOKEN_REGEX.lastIndex = 0;
  const matches = Array.from(contentHtml.matchAll(TEXT_TOKEN_REGEX));
  if (matches.length === 0) {
    return contentHtml;
  }

  // Pre-resolve each distinct lodge-capacity parameter (the replace
  // callback below is synchronous).
  const capacityParams = new Set(
    matches
      .filter((match) => (match[1] ?? "").toLowerCase() === "lodge-capacity")
      .map((match) => (match[2] ?? "").trim().toLowerCase()),
  );
  const capacityByParam = new Map<string, number>();
  for (const param of capacityParams) {
    capacityByParam.set(
      param,
      await resolveLodgeCapacityToken(param || undefined),
    );
  }

  return contentHtml.replace(
    TEXT_TOKEN_REGEX,
    (_match, paramToken: string | undefined, parameter: string | undefined, plainToken: string | undefined) => {
      const token = paramToken ?? plainToken ?? "";
      switch (token.toLowerCase()) {
        case "lodge-capacity": {
          const value = capacityByParam.get(
            (parameter ?? "").trim().toLowerCase(),
          );
          return escapeHtmlText(String(value ?? ""));
        }
        case "club-name":
          return escapeHtmlText(CLUB_NAME);
        case "hut-leader":
          return escapeHtmlText(CLUB_HUT_LEADER_LABEL);
        case "hut-leader-lower":
          return escapeHtmlText(CLUB_HUT_LEADER_LABEL.toLowerCase());
        case "currency":
          return escapeHtmlText(APP_CURRENCY);
        case "facebook-url":
          // Escaping keeps the value safe as visible text and attribute
          // content, but not as an href target: a javascript: scheme survives
          // HTML-escaping, so safeTokenUrl vets the scheme first.
          return escapeHtmlText(
            safeTokenUrl("facebook-url", CLUB_FACEBOOK_URL ?? CLUB_PUBLIC_URL),
          );
        default:
          return "";
      }
    },
  );
}

function parseTokenMatch(match: RegExpMatchArray): ParsedEmbedToken {
  return {
    token: (match[1] ?? match[3] ?? "").toLowerCase(),
    parameter: (match[2] ?? match[4] ?? "").trim() || undefined,
  };
}

function extractInlinePhotoGalleryImages(contentHtml: string): {
  cleanedHtml: string;
  images: PhotoGalleryImage[];
} {
  const images: PhotoGalleryImage[] = [];
  const cleanedHtml = contentHtml.replace(
    /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi,
    (match, src: string) => {
      const altMatch = match.match(/alt=["']([^"']*)["']/i);
      const widthMatch = match.match(/width=["']?(\d+)["']?/i);
      const heightMatch = match.match(/height=["']?(\d+)["']?/i);
      images.push({
        src,
        alt: altMatch?.[1] ?? "",
        width: widthMatch ? Number.parseInt(widthMatch[1], 10) : null,
        height: heightMatch ? Number.parseInt(heightMatch[1], 10) : null,
      });
      return "";
    },
  );

  return { cleanedHtml, images };
}

function normaliseGalleryDirectoryInput(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/^public\/images\/?/i, "")
    .replace(/^images\/?/i, "")
    .replace(/\/+$/g, "");
}

async function listPhotoGalleryImagesFromDirectory(
  directoryInput: string,
): Promise<PhotoGalleryImage[]> {
  const relDir = normaliseGalleryDirectoryInput(directoryInput);
  const absDir = resolveInImagesRoot(relDir);
  if (!absDir) {
    return [];
  }

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      ALLOWED_IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()),
  );

  const images = await Promise.all(
    files.map(async (entry) => {
      const filePath = path.join(absDir, entry.name);
      const bytes = await fs.readFile(filePath);
      const ext = path.extname(entry.name).toLowerCase();
      const contentType =
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".png"
            ? "image/png"
            : ext === ".gif"
              ? "image/gif"
              : ext === ".webp"
                ? "image/webp"
                : ext === ".avif"
                  ? "image/avif"
                  : null;
      const dimensions = contentType
        ? extractImageDimensions(bytes, contentType)
        : null;

      return {
        src: imagePublicUrl(filePath),
        alt: entry.name,
        width: dimensions?.width ?? 1200,
        height: dimensions?.height ?? 900,
      } satisfies PhotoGalleryImage;
    }),
  );

  images.sort((a, b) => a.alt.localeCompare(b.alt, "en-NZ"));
  return images;
}

async function resolveGalleryImages(
  parameter: string | undefined,
  inlineImages: PhotoGalleryImage[],
  useInlineFallback: boolean,
): Promise<PhotoGalleryImage[]> {
  if (parameter) {
    return listPhotoGalleryImagesFromDirectory(parameter);
  }

  return useInlineFallback ? inlineImages : [];
}

export async function buildEmbeddedBody(contentHtml: string) {
  const htmlWithTextTokens = await resolveTextTokens(contentHtml);
  const matches = Array.from(htmlWithTextTokens.matchAll(EMBED_TOKEN_REGEX));
  const hasInlineGalleryToken = matches.some((match) => {
    const parsed = parseTokenMatch(match);
    return (
      (parsed.token === "photo-gallery" ||
        parsed.token === "photo-slideshow") &&
      !parsed.parameter
    );
  });

  const { cleanedHtml, images: inlineImages } = hasInlineGalleryToken
    ? extractInlinePhotoGalleryImages(htmlWithTextTokens)
    : { cleanedHtml: htmlWithTextTokens, images: [] as PhotoGalleryImage[] };

  const parts: EmbeddedBodyPart[] = [];
  let lastIndex = 0;

  for (const match of cleanedHtml.matchAll(EMBED_TOKEN_REGEX)) {
    const startIndex = match.index ?? 0;
    const before = cleanedHtml.slice(lastIndex, startIndex);
    if (before.trim().length > 0) {
      parts.push({ type: "html", value: before });
    }

    const parsed = parseTokenMatch(match);
    if (parsed.token === "committee-members-cards") {
      parts.push({ type: "committee" });
    } else if (
      parsed.token === "member-application-form" ||
      parsed.token === "join-apply-form"
    ) {
      parts.push({ type: "member-application-form" });
    } else if (parsed.token === "skifield-conditions") {
      parts.push({ type: "skifield-conditions", dataHash: parsed.parameter });
    } else if (parsed.token === "skifield-whakapapa") {
      parts.push({ type: "skifield-whakapapa" });
    } else if (parsed.token === "photo-gallery") {
      parts.push({
        type: "photo-gallery",
        images: await resolveGalleryImages(
          parsed.parameter,
          inlineImages,
          hasInlineGalleryToken,
        ),
      });
    } else if (parsed.token === "photo-slideshow") {
      parts.push({
        type: "photo-slideshow",
        images: await resolveGalleryImages(
          parsed.parameter,
          inlineImages,
          hasInlineGalleryToken,
        ),
      });
    } else if (parsed.token === "membership-types") {
      parts.push({ type: "membership-types", items: await loadPublicMembershipTypes() });
    } else if (parsed.token === "entrance-fees") {
      parts.push({ type: "entrance-fees", items: await loadPublicEntranceFees() });
    } else if (parsed.token === "hut-fees") {
      parts.push({ type: "hut-fees", lodges: await loadPublicHutFees(parsed.parameter) });
    } else if (parsed.token === "booking-policy-summary") {
      parts.push({ type: "booking-policy-summary", policy: await loadPublicBookingPolicy(parsed.parameter) });
    } else if (parsed.token === "cancellation-policy") {
      parts.push({ type: "cancellation-policy", policy: await loadPublicCancellationPolicy(parsed.parameter) });
    } else if (parsed.token === "contact-form") {
      parts.push({ type: "contact-form" });
    } else {
      // Catalogue and renderer should evolve together. If they drift, retain
      // the already-sanitised literal instead of accidentally rendering a
      // privileged or interactive component.
      parts.push({ type: "html", value: match[0] });
    }

    lastIndex = startIndex + match[0].length;
  }

  const trailing = cleanedHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  return parts;
}
