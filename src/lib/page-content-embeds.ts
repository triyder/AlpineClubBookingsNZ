import "server-only";

import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  imagePublicUrl,
  resolveInImagesRoot,
} from "@/lib/image-storage";
import { CLUB_NAME } from "@/config/club-identity";
import { APP_CURRENCY } from "@/config/operational";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { extractImageDimensions } from "@/lib/media-image";

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
  | { type: "photo-slideshow"; images: PhotoGalleryImage[] };

type ParsedEmbedToken = {
  token: string;
  parameter: string | undefined;
};

const EMBED_TOKEN_REGEX =
  /\{\{\s*(committee-members-cards|member-application-form|contact-form|join-apply-form|skifield-conditions|skifield-whakapapa|photo-gallery|photo-slideshow)(?:\s*:\s*([^{}]+?))?\s*\}\}|\{\s*(committee-members-cards|member-application-form|contact-form|join-apply-form|skifield-conditions|skifield-whakapapa)(?:\s*:\s*([^{}]+?))?\s*\}/gi;
const TEXT_TOKEN_REGEX = /\{\{\s*(lodge-capacity|club-name|currency)\s*\}\}/gi;

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function resolveTextTokens(contentHtml: string): Promise<string> {
  TEXT_TOKEN_REGEX.lastIndex = 0;
  if (!TEXT_TOKEN_REGEX.test(contentHtml)) {
    return contentHtml;
  }

  TEXT_TOKEN_REGEX.lastIndex = 0;
  const lodgeCapacity = contentHtml.match(/\{\{\s*lodge-capacity\s*\}\}/i)
    ? await getLodgeCapacity()
    : null;

  return contentHtml.replace(TEXT_TOKEN_REGEX, (_match, token: string) => {
    switch (token.toLowerCase()) {
      case "lodge-capacity":
        return escapeHtmlText(String(lodgeCapacity));
      case "club-name":
        return escapeHtmlText(CLUB_NAME);
      case "currency":
        return escapeHtmlText(APP_CURRENCY);
      default:
        return "";
    }
  });
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
    } else {
      parts.push({ type: "contact-form" });
    }

    lastIndex = startIndex + match[0].length;
  }

  const trailing = cleanedHtml.slice(lastIndex);
  if (trailing.trim().length > 0) {
    parts.push({ type: "html", value: trailing });
  }

  return parts;
}
