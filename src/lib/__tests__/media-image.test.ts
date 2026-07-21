import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ALLOWED_MEDIA_IMAGE_CONTENT_TYPES,
  MAX_MEDIA_IMAGE_BYTES,
  detectImageContentType,
  extractImageDimensions,
  mediaImageServingUrl,
  sanitiseMediaImageFilename,
  stripImageMetadata,
} from "@/lib/media-image";

function buildPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function buildGif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function buildJpeg(width: number, height: number): Buffer {
  // SOI, then an SOF0 marker with a minimal frame header.
  const sof0 = Buffer.alloc(10);
  sof0.writeUInt8(0xff, 0);
  sof0.writeUInt8(0xc0, 1);
  sof0.writeUInt16BE(8, 2); // segment length (excluding marker bytes)
  sof0.writeUInt8(0x08, 4); // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(0, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof0]);
}

function buildWebp(): Buffer {
  const buf = Buffer.alloc(12);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
}

function buildAvif(): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(0, 0);
  buf.write("ftyp", 4, "ascii");
  buf.write("avif", 8, "ascii");
  return buf;
}

const SVG_WITH_DIMENSIONS = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 240 160"><rect /></svg>',
  "utf8",
);

const SVG_WITH_VIEWBOX_ONLY = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"><rect /></svg>',
  "utf8",
);

const SVG_WITH_SCRIPT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  "utf8",
);

describe("detectImageContentType", () => {
  it("recognises a PNG signature", () => {
    expect(detectImageContentType(buildPng(10, 20))).toBe("image/png");
  });

  it("recognises a JPEG signature", () => {
    expect(detectImageContentType(buildJpeg(10, 20))).toBe("image/jpeg");
  });

  it("recognises GIF87a and GIF89a signatures", () => {
    expect(detectImageContentType(buildGif(10, 20))).toBe("image/gif");
    const gif87 = buildGif(10, 20);
    gif87.write("GIF87a", 0, "ascii");
    expect(detectImageContentType(gif87)).toBe("image/gif");
  });

  it("recognises a WebP RIFF/WEBP container", () => {
    expect(detectImageContentType(buildWebp())).toBe("image/webp");
  });

  it("recognises an AVIF ftyp box", () => {
    expect(detectImageContentType(buildAvif())).toBe("image/avif");
  });

  it("recognises an SVG root element, with or without an XML prolog", () => {
    expect(detectImageContentType(SVG_WITH_DIMENSIONS)).toBe("image/svg+xml");
    expect(detectImageContentType(SVG_WITH_VIEWBOX_ONLY)).toBe("image/svg+xml");
  });

  it("rejects an SVG-disguised script payload that is not actually an SVG", () => {
    expect(
      detectImageContentType(Buffer.from("<script>alert(1)</script>", "utf8")),
    ).toBeNull();
  });

  it("recognises an SVG preceded by a BOM and comments", () => {
    const withComments = Buffer.from(
      "﻿<!-- comment one -->\n<!-- comment two -->\n<svg xmlns=\"http://www.w3.org/2000/svg\"><rect /></svg>",
      "utf8",
    );
    expect(detectImageContentType(withComments)).toBe("image/svg+xml");
  });

  it("does not hang on many unterminated comment markers (ReDoS guard)", () => {
    const adversarial = Buffer.from("<!--".repeat(2000), "utf8");
    const start = Date.now();
    expect(detectImageContentType(adversarial)).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("rejects unrecognised content even if the declared type claims to be an image", () => {
    expect(detectImageContentType(Buffer.from("not an image", "utf8"))).toBeNull();
  });

  it("rejects an empty buffer", () => {
    expect(detectImageContentType(Buffer.alloc(0))).toBeNull();
  });

  it("every detectable type is in the allowlist", () => {
    for (const type of [
      detectImageContentType(buildPng(1, 1)),
      detectImageContentType(buildJpeg(1, 1)),
      detectImageContentType(buildGif(1, 1)),
      detectImageContentType(buildWebp()),
      detectImageContentType(buildAvif()),
      detectImageContentType(SVG_WITH_DIMENSIONS),
    ]) {
      expect(type).not.toBeNull();
      expect(ALLOWED_MEDIA_IMAGE_CONTENT_TYPES).toContain(type);
    }
  });
});

describe("extractImageDimensions", () => {
  it("reads width/height from a PNG IHDR chunk", () => {
    expect(extractImageDimensions(buildPng(640, 480), "image/png")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads width/height from a GIF header", () => {
    expect(extractImageDimensions(buildGif(320, 240), "image/gif")).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("reads width/height from a JPEG SOF0 marker", () => {
    expect(extractImageDimensions(buildJpeg(800, 600), "image/jpeg")).toEqual({
      width: 800,
      height: 600,
    });
  });

  it("reads width/height attributes from an SVG root element", () => {
    expect(
      extractImageDimensions(SVG_WITH_DIMENSIONS, "image/svg+xml"),
    ).toEqual({ width: 120, height: 80 });
  });

  it("falls back to viewBox dimensions when width/height attributes are absent", () => {
    expect(
      extractImageDimensions(SVG_WITH_VIEWBOX_ONLY, "image/svg+xml"),
    ).toEqual({ width: 300, height: 150 });
  });

  it("returns null for formats without a cheap dimension reader", () => {
    expect(extractImageDimensions(buildWebp(), "image/webp")).toBeNull();
    expect(extractImageDimensions(buildAvif(), "image/avif")).toBeNull();
  });

  it("returns null when an SVG has no width/height or viewBox", () => {
    expect(extractImageDimensions(SVG_WITH_SCRIPT, "image/svg+xml")).toBeNull();
  });
});

describe("sanitiseMediaImageFilename", () => {
  it("strips directory components", () => {
    expect(sanitiseMediaImageFilename("../../etc/passwd.png")).toBe(
      "passwd.png",
    );
    expect(sanitiseMediaImageFilename("C:\\Users\\me\\photo.jpg")).toBe(
      "photo.jpg",
    );
  });

  it("replaces unsafe characters", () => {
    expect(sanitiseMediaImageFilename("my photo (1)!.png")).toBe(
      "my_photo_1_.png",
    );
  });

  it("falls back to a default name when nothing safe remains", () => {
    expect(sanitiseMediaImageFilename("???")).toBe("upload");
  });

  it("truncates very long filenames", () => {
    const longName = `${"a".repeat(300)}.png`;
    expect(sanitiseMediaImageFilename(longName).length).toBeLessThanOrEqual(200);
  });
});

describe("mediaImageServingUrl", () => {
  it("builds the public serving path", () => {
    expect(mediaImageServingUrl("abc123")).toBe("/api/images/abc123");
  });
});

describe("MAX_MEDIA_IMAGE_BYTES", () => {
  it("is 2MB", () => {
    expect(MAX_MEDIA_IMAGE_BYTES).toBe(2 * 1024 * 1024);
  });
});

// ─── WebP dimension parsing (decode-bomb backstop, review #7) ────────────────

function buildWebpVp8x(width: number, height: number): Buffer {
  const payload = Buffer.alloc(10); // 4 flags/reserved + 3 (w-1) + 3 (h-1), LE
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  const buf = Buffer.alloc(20 + payload.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4 + 8 + payload.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
}

describe("extractImageDimensions — WebP (VP8X)", () => {
  it("parses the canvas dimensions from a VP8X chunk", () => {
    expect(extractImageDimensions(buildWebpVp8x(1024, 768), "image/webp")).toEqual(
      { width: 1024, height: 768 },
    );
  });

  it("reads an oversized canvas so the caller's backstop can reject it", () => {
    expect(
      extractImageDimensions(buildWebpVp8x(16384, 16384), "image/webp"),
    ).toEqual({ width: 16384, height: 16384 });
  });
});

// ─── Metadata stripping (privacy, review #6) ─────────────────────────────────

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); // stripper does not validate the CRC
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
}

function webpChunk(fourCC: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(fourCC, 0, "ascii");
  header.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

function jpegAppSegment(marker: number, payload: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2, 0);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}

const JPEG_SOF0 = (() => {
  const s = Buffer.alloc(11);
  s.writeUInt8(0xff, 0);
  s.writeUInt8(0xc0, 1);
  s.writeUInt16BE(9, 2);
  s.writeUInt8(8, 4);
  s.writeUInt16BE(16, 5); // height
  s.writeUInt16BE(16, 7); // width
  s.writeUInt8(1, 9);
  return s;
})();
const JPEG_SOS_EOI = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]);

const SECRET = "GPS:-41.29,174.78";

describe("stripImageMetadata", () => {
  it("removes the EXIF APP1 segment from a JPEG but keeps the frame", () => {
    const soi = Buffer.from([0xff, 0xd8]);
    const exifPayload = Buffer.from(`Exif\0\0${SECRET}`, "latin1");
    const app1Len = Buffer.alloc(2);
    app1Len.writeUInt16BE(exifPayload.length + 2, 0);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), app1Len, exifPayload]);
    const sof0 = (() => {
      const s = Buffer.alloc(11);
      s.writeUInt8(0xff, 0);
      s.writeUInt8(0xc0, 1);
      s.writeUInt16BE(9, 2);
      s.writeUInt8(8, 4);
      s.writeUInt16BE(16, 5); // height
      s.writeUInt16BE(16, 7); // width
      s.writeUInt8(1, 9);
      return s;
    })();
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0xff, 0xd9]);
    const jpeg = Buffer.concat([soi, app1, sof0, sos]);

    const stripped = stripImageMetadata(jpeg, "image/jpeg");

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.length).toBeLessThan(jpeg.length);
    // Still a JPEG whose dimensions survive.
    expect(stripped[0]).toBe(0xff);
    expect(stripped[1]).toBe(0xd8);
    expect(extractImageDimensions(stripped, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("removes eXIf and tEXt chunks from a PNG, keeping critical chunks", () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(16, 0);
    ihdrData.writeUInt32BE(16, 4);
    const png = Buffer.concat([
      sig,
      pngChunk("IHDR", ihdrData),
      pngChunk("eXIf", Buffer.from(SECRET, "latin1")),
      pngChunk("tEXt", Buffer.from(`Comment\0${SECRET}`, "latin1")),
      pngChunk("IDAT", Buffer.from([0x00])),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);

    const stripped = stripImageMetadata(png, "image/png");

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from("IHDR", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("IDAT", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("IEND", "ascii"))).toBe(true);
    expect(stripped.includes(Buffer.from("eXIf", "ascii"))).toBe(false);
  });

  it("removes the EXIF chunk from a WebP RIFF container", () => {
    const body = Buffer.concat([
      webpChunk("VP8L", Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00])),
      webpChunk("EXIF", Buffer.from(SECRET, "latin1")),
    ]);
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const stripped = stripImageMetadata(webp, "image/webp");

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.toString("ascii", 0, 4)).toBe("RIFF");
    expect(stripped.toString("ascii", 8, 12)).toBe("WEBP");
    expect(stripped.includes(Buffer.from("VP8L", "ascii"))).toBe(true);
    // RIFF size header is recomputed to match the shortened body.
    expect(stripped.readUInt32LE(4)).toBe(stripped.length - 8);
  });

  it("drops APP13 IPTC (and any non-colour APPn) while preserving JFIF/ICC (allow-list)", () => {
    const iptcSecret = "IPTC-HOME-42-BAKER-ST";
    const soi = Buffer.from([0xff, 0xd8]);
    const app0Jfif = jpegAppSegment(
      0xe0,
      Buffer.from("JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00", "latin1"),
    ); // colour/structural — must be kept
    const app13Iptc = jpegAppSegment(
      0xed,
      Buffer.from(`Photoshop 3.0\0${iptcSecret}`, "latin1"),
    ); // IPTC — must be dropped
    const app2Icc = jpegAppSegment(0xe2, Buffer.from("ICC_PROFILE\0keep-colour")); // kept
    const jpeg = Buffer.concat([
      soi,
      app0Jfif,
      app13Iptc,
      app2Icc,
      JPEG_SOF0,
      JPEG_SOS_EOI,
    ]);

    const stripped = stripImageMetadata(jpeg, "image/jpeg");

    // IPTC PII gone; JFIF and ICC colour segments preserved; frame intact.
    expect(stripped.includes(Buffer.from(iptcSecret, "latin1"))).toBe(false);
    expect(stripped.includes(Buffer.from("JFIF", "latin1"))).toBe(true);
    expect(stripped.includes(Buffer.from("ICC_PROFILE", "latin1"))).toBe(true);
    expect(stripped.includes(Buffer.from("Photoshop", "latin1"))).toBe(false);
    expect(extractImageDimensions(stripped, "image/jpeg")).toEqual({
      width: 16,
      height: 16,
    });
  });

  it("strips a trailing WebP EXIF chunk even when it omits its RIFF pad byte", () => {
    // Final EXIF chunk with an odd payload length and NO pad byte (built by hand
    // — webpChunk would add the pad).
    const exifData = Buffer.from(SECRET, "latin1"); // odd length
    const exifHeader = Buffer.alloc(8);
    exifHeader.write("EXIF", 0, "ascii");
    exifHeader.writeUInt32LE(exifData.length, 4);
    const exifNoPad = Buffer.concat([exifHeader, exifData]);
    const body = Buffer.concat([
      webpChunk("VP8L", Buffer.from([0x2f, 0x00, 0x00, 0x00])),
      exifNoPad,
    ]);
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      (() => {
        const s = Buffer.alloc(4);
        s.writeUInt32LE(4 + body.length, 0);
        return s;
      })(),
      Buffer.from("WEBP", "ascii"),
      body,
    ]);

    const stripped = stripImageMetadata(webp, "image/webp");

    expect(stripped.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(stripped.toString("ascii", 8, 12)).toBe("WEBP");
    expect(stripped.includes(Buffer.from("VP8L", "ascii"))).toBe(true);
  });

  it("returns the original bytes unchanged when the structure is malformed", () => {
    const garbage = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56]);
    expect(stripImageMetadata(garbage, "image/jpeg").equals(garbage)).toBe(true);
  });
});
