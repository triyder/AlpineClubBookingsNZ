import "server-only";

/**
 * Shared constants and helpers for the database-backed image library
 * (#731). Images are stored as Bytes in the MediaImage table and served
 * publicly from /api/images/[id].
 */

// 2MB cap, matching the spirit of MAX_LOGO_DATA_URL_BYTES for site-style
// logo uploads.
export const MAX_MEDIA_IMAGE_BYTES = 2 * 1024 * 1024;

// Upper bound on the multipart request body itself (file bytes plus form
// field/boundary overhead), used to reject oversized uploads before the
// body is fully buffered.
export const MAX_MEDIA_IMAGE_REQUEST_BYTES = MAX_MEDIA_IMAGE_BYTES + 64 * 1024;

// test seam
export const ALLOWED_MEDIA_IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
] as const;

export type AllowedMediaImageContentType =
  (typeof ALLOWED_MEDIA_IMAGE_CONTENT_TYPES)[number];

const MAX_MEDIA_IMAGE_FILENAME_LENGTH = 200;
export const MAX_MEDIA_IMAGE_ALT_TEXT_LENGTH = 280;

const BOM = "﻿";

function startsWithCaseInsensitive(
  text: string,
  search: string,
  index: number,
): boolean {
  return (
    text.slice(index, index + search.length).toLowerCase() ===
    search.toLowerCase()
  );
}

function skipWhitespace(text: string, index: number): number {
  let next = index;
  while (next < text.length && /\s/.test(text[next])) {
    next += 1;
  }
  return next;
}

/**
 * Check whether `head` is the start of an SVG document: optionally
 * preceded by a BOM, an XML prolog, and/or comments, followed by a
 * `<svg` root element. Written as a manual scanner (rather than a single
 * regex) to avoid catastrophic backtracking on adversarial input such as
 * many repeated, unterminated `<!--` sequences.
 */
function isSvgPrefix(head: string): boolean {
  let index = 0;
  if (head.startsWith(BOM, index)) {
    index += 1;
  }
  index = skipWhitespace(head, index);

  if (startsWithCaseInsensitive(head, "<?xml", index)) {
    const end = head.indexOf("?>", index + 5);
    if (end === -1) {
      return false;
    }
    index = skipWhitespace(head, end + 2);
  }

  for (;;) {
    if (!head.startsWith("<!--", index)) {
      break;
    }
    const end = head.indexOf("-->", index + 4);
    if (end === -1) {
      return false;
    }
    index = skipWhitespace(head, end + 3);
  }

  if (!startsWithCaseInsensitive(head, "<svg", index)) {
    return false;
  }
  const afterTag = head[index + 4];
  return afterTag === undefined ? false : /[\s>]/.test(afterTag);
}

/**
 * Sniff the real image type from file bytes, ignoring the declared
 * Content-Type / filename extension. Returns null if the bytes do not
 * match a recognised, allowed image format.
 */
export function detectImageContentType(
  bytes: Buffer,
): AllowedMediaImageContentType | null {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    ["avif", "avis"].includes(bytes.toString("ascii", 8, 12))
  ) {
    return "image/avif";
  }

  // SVG is text, not a binary signature: look for an <svg> root element
  // (optionally preceded by a BOM, XML prolog, and/or comments) within the
  // first slice of the file.
  const head = bytes.subarray(0, 2048).toString("utf8");
  if (isSvgPrefix(head)) {
    return "image/svg+xml";
  }

  return null;
}

export type ImageDimensions = { width: number; height: number };

function readUInt32BE(bytes: Buffer, offset: number): number {
  return bytes.readUInt32BE(offset);
}

function extractPngDimensions(bytes: Buffer): ImageDimensions | null {
  // PNG signature (8 bytes) + IHDR chunk length (4) + "IHDR" (4) + width (4) + height (4).
  if (bytes.length < 24) return null;
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20),
  };
}

function extractGifDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 10) return null;
  return {
    width: bytes.readUInt16LE(6),
    height: bytes.readUInt16LE(8),
  };
}

function extractJpegDimensions(bytes: Buffer): ImageDimensions | null {
  let offset = 2; // skip the SOI marker (0xFFD8)
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // Start-of-frame markers (baseline/progressive/etc), excluding DHT/JPG/DAC.
    const isSofMarker =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;

    if (isSofMarker) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return { width, height };
    }

    if (marker === 0xd8 || marker === 0xd9) {
      break; // SOI/EOI: no frame found
    }

    const segmentLength = bytes.readUInt16BE(offset + 2);
    offset += 2 + segmentLength;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

/**
 * Parse the canvas dimensions from a WebP file's first chunk without an image
 * library. Covers the three container forms: VP8X (extended/animated — the one
 * that can declare a huge canvas), VP8 (lossy) and VP8L (lossless). Returns
 * null for an unrecognised/truncated form so callers apply their own policy.
 */
function extractWebpDimensions(bytes: Buffer): ImageDimensions | null {
  // "RIFF"(4) + size(4) + "WEBP"(4) already validated by the sniffer; the first
  // chunk header (FourCC(4) + size(4)) begins at 12, its payload at 20.
  if (bytes.length < 20) return null;
  const fourCC = bytes.toString("ascii", 12, 16);
  const payload = 20;

  if (fourCC === "VP8X") {
    // 4 bytes flags/reserved, then 24-bit (width-1) and 24-bit (height-1), LE.
    if (bytes.length < payload + 10) return null;
    return {
      width: readUInt24LE(bytes, payload + 4) + 1,
      height: readUInt24LE(bytes, payload + 7) + 1,
    };
  }

  if (fourCC === "VP8 ") {
    // Lossy: 3-byte frame tag, then the start code 0x9d 0x01 0x2a, then the
    // 14-bit width and height (LE).
    if (bytes.length < payload + 10) return null;
    if (
      bytes[payload + 3] !== 0x9d ||
      bytes[payload + 4] !== 0x01 ||
      bytes[payload + 5] !== 0x2a
    ) {
      return null;
    }
    return {
      width: bytes.readUInt16LE(payload + 6) & 0x3fff,
      height: bytes.readUInt16LE(payload + 8) & 0x3fff,
    };
  }

  if (fourCC === "VP8L") {
    // Lossless: 0x2f signature byte, then 14-bit (width-1) and 14-bit (height-1)
    // packed little-endian across the next 4 bytes.
    if (bytes.length < payload + 5) return null;
    if (bytes[payload] !== 0x2f) return null;
    const bits =
      ((bytes[payload + 4] << 24) |
        (bytes[payload + 3] << 16) |
        (bytes[payload + 2] << 8) |
        bytes[payload + 1]) >>>
      0;
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }

  return null;
}

function extractSvgDimensions(bytes: Buffer): ImageDimensions | null {
  const head = bytes.subarray(0, 4096).toString("utf8");
  const svgTagMatch = head.match(/<svg[^>]*>/i);
  if (!svgTagMatch) return null;
  const svgTag = svgTagMatch[0];

  const widthMatch = svgTag.match(/\bwidth="([0-9.]+)(?:px)?"/i);
  const heightMatch = svgTag.match(/\bheight="([0-9.]+)(?:px)?"/i);
  if (widthMatch && heightMatch) {
    const width = Math.round(Number.parseFloat(widthMatch[1]));
    const height = Math.round(Number.parseFloat(heightMatch[1]));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const viewBoxMatch = svgTag.match(
    /\bviewBox="\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*"/i,
  );
  if (viewBoxMatch) {
    const width = Math.round(Number.parseFloat(viewBoxMatch[1]));
    const height = Math.round(Number.parseFloat(viewBoxMatch[2]));
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  return null;
}

/**
 * Best-effort dimension extraction for formats where it is cheap to do
 * without an image-processing dependency. Returns null when the format
 * isn't supported (AVIF) or the bytes can't be parsed.
 */
export function extractImageDimensions(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType,
): ImageDimensions | null {
  try {
    switch (contentType) {
      case "image/png":
        return extractPngDimensions(bytes);
      case "image/gif":
        return extractGifDimensions(bytes);
      case "image/jpeg":
        return extractJpegDimensions(bytes);
      case "image/webp":
        return extractWebpDimensions(bytes);
      case "image/svg+xml":
        return extractSvgDimensions(bytes);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Remove metadata from a JPEG by copying only the colour/rendering marker
 * segments — JFIF (APP0), ICC (APP2), Adobe (APP14) — and the structural
 * markers, dropping every other APPn (EXIF/XMP APP1, IPTC/Photoshop APP13,
 * Ducky APP12, vendor blocks) and every COM comment, any of which can carry
 * creator contact info, location or GPS. Then the entropy-coded scan is copied
 * verbatim. Returns the original bytes unchanged if the structure is malformed,
 * so stripping can never corrupt.
 */
function stripJpegMetadata(bytes: Buffer): Buffer {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const kept: Buffer[] = [bytes.subarray(0, 2)]; // SOI
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes; // not at a marker → don't risk it
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      // Start-of-scan / end-of-image: copy the remainder verbatim.
      kept.push(bytes.subarray(offset));
      return Buffer.concat(kept);
    }
    const segLen = bytes.readUInt16BE(offset + 2);
    const segEnd = offset + 2 + segLen;
    if (segLen < 2 || segEnd > bytes.length) return bytes; // truncated/invalid
    // Allow-list, not deny-list: metadata lives across many APPn markers
    // (APP1 EXIF/XMP, APP13 IPTC/Photoshop, APP12 Ducky, vendor APP3-APP11),
    // any of which can carry creator contact info, location or GPS. Preserve
    // ONLY the colour/rendering segments — APP0 (JFIF), APP2 (ICC), APP14
    // (Adobe) — and drop every other APPn and every COM comment, so no
    // metadata segment survives by omission. Structural markers (DQT, DHT,
    // SOFn, DRI, …) are not APPn/COM and are always kept.
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const isColourApp =
      marker === 0xe0 || marker === 0xe2 || marker === 0xee;
    const drop = (isAppSegment && !isColourApp) || marker === 0xfe; // COM
    if (!drop) {
      kept.push(bytes.subarray(offset, segEnd));
    }
    offset = segEnd;
  }
  return bytes; // ran off the end without a scan → leave untouched
}

const PNG_METADATA_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

/**
 * Remove text/EXIF/timestamp ancillary chunks from a PNG (eXIf can carry GPS),
 * keeping all critical and colour chunks. Returns the original bytes if the
 * structure is malformed.
 */
function stripPngMetadata(bytes: Buffer): Buffer {
  const SIG = 8;
  if (bytes.length < SIG + 12) return bytes;
  const kept: Buffer[] = [bytes.subarray(0, SIG)];
  let offset = SIG;
  while (offset + 12 <= bytes.length) {
    const len = readUInt32BE(bytes, offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const chunkEnd = offset + 12 + len; // len(4) + type(4) + data(len) + crc(4)
    if (chunkEnd > bytes.length) return bytes; // truncated
    if (!PNG_METADATA_CHUNKS.has(type)) {
      kept.push(bytes.subarray(offset, chunkEnd));
    }
    if (type === "IEND") break;
    offset = chunkEnd;
  }
  return Buffer.concat(kept);
}

/**
 * Remove EXIF and XMP chunks from a WebP RIFF container and clear the matching
 * VP8X metadata flag bits, recomputing the RIFF size. Returns the original
 * bytes if the structure is malformed.
 */
function stripWebpMetadata(bytes: Buffer): Buffer {
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return bytes;
  }
  const kept: Buffer[] = [];
  let offset = 12;
  let changed = false;
  while (offset + 8 <= bytes.length) {
    const fourCC = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const padded = size + (size % 2);
    let chunkEnd = offset + 8 + padded;
    if (chunkEnd > bytes.length) {
      // A final odd-sized chunk may omit its RIFF pad byte. Accept that exact
      // case (the unpadded end lands on EOF) so a trailing EXIF/XMP chunk is
      // still stripped rather than the whole file being left untouched;
      // anything else is genuinely malformed.
      if (offset + 8 + size === bytes.length) {
        chunkEnd = bytes.length;
      } else {
        return bytes;
      }
    }
    if (fourCC === "EXIF" || fourCC === "XMP ") {
      changed = true;
      offset = chunkEnd;
      continue;
    }
    let chunk = bytes.subarray(offset, chunkEnd);
    if (fourCC === "VP8X" && chunk.length > 8) {
      // Clear the EXIF (0x08) and XMP (0x04) flag bits in the first payload byte.
      const flags = chunk[8];
      const cleared = flags & ~0b0000_1100;
      if (cleared !== flags) {
        chunk = Buffer.from(chunk);
        chunk[8] = cleared;
        changed = true;
      }
    }
    kept.push(chunk);
    offset = chunkEnd;
  }
  if (!changed) return bytes;
  const body = Buffer.concat(kept);
  const out = Buffer.alloc(12 + body.length);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(4 + body.length, 4); // "WEBP" tag + chunk bytes
  out.write("WEBP", 8, "ascii");
  body.copy(out, 12);
  return out;
}

/**
 * Strip privacy-sensitive metadata (EXIF/GPS, XMP, comments) from an uploaded
 * image before it is stored and potentially served publicly. Best-effort and
 * fail-safe: on any unexpected structure the original bytes are returned rather
 * than risk corrupting the image. Content that has been re-encoded client-side
 * (the crop canvas) is already metadata-free; this covers the direct-upload
 * path where a phone-camera JPEG could carry GPS coordinates.
 */
export function stripImageMetadata(
  bytes: Buffer,
  contentType: AllowedMediaImageContentType,
): Buffer {
  try {
    switch (contentType) {
      case "image/jpeg":
        return stripJpegMetadata(bytes);
      case "image/png":
        return stripPngMetadata(bytes);
      case "image/webp":
        return stripWebpMetadata(bytes);
      default:
        return bytes;
    }
  } catch {
    return bytes;
  }
}

/**
 * Strip directory components and unsafe characters from an uploaded
 * filename, keeping it short enough for storage and display.
 */
export function sanitiseMediaImageFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").trim();
  const safe = /[A-Za-z0-9]/.test(cleaned) ? cleaned : "upload";
  return safe.slice(0, MAX_MEDIA_IMAGE_FILENAME_LENGTH);
}

export function mediaImageServingUrl(id: string): string {
  return `/api/images/${id}`;
}
