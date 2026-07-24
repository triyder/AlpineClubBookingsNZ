import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  mediaImageFindUnique: vi.fn(),
  mediaImageCreate: vi.fn(),
  mediaImageDeleteMany: vi.fn(),
  txQueryRaw: vi.fn(),
  transaction: vi.fn(),
  logAudit: vi.fn(),
}));

// The committee-public ETag is an opaque digest of the image id + last-updated
// timestamp — never the raw MediaImage id (which used to leak to anonymous
// callers). Mirror the route's derivation so tests assert the exact value.
const PHOTO_UPDATED_AT = new Date("2026-07-01T00:00:00.000Z");
function committeeEtag(photoImageId: string, updatedAt: Date | null): string {
  return `"${createHash("sha256")
    .update(`${photoImageId}:${updatedAt?.toISOString() ?? ""}`)
    .digest("hex")
    .slice(0, 32)}"`;
}

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async (options?: unknown) =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
      options as never,
    ),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
      update: mocks.memberUpdate,
    },
    mediaImage: {
      findUnique: mocks.mediaImageFindUnique,
      create: mocks.mediaImageCreate,
      deleteMany: mocks.mediaImageDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { GET, POST, DELETE } from "@/app/api/members/[id]/photo/route";

const TARGET_ID = "member-target";

const ownerSession = {
  user: { id: TARGET_ID, role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const otherMemberSession = {
  user: { id: "member-other", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const membershipAdminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const readonlyAdminSession = {
  user: {
    id: "admin-ro",
    role: "ADMIN",
    accessRoles: [{ role: "ADMIN_READONLY" }],
  },
};

// A structurally complete PNG (signature → IHDR → IDAT → IEND) so it passes the
// route's now fail-closed metadata strip (which requires a clean walk reaching
// IEND). 64×32 from IHDR; no ancillary metadata chunks, so stripping is a no-op.
const PNG_BYTES = (() => {
  const pngChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); // stripper does not validate the CRC
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(64, 0); // width
  ihdrData.writeUInt32BE(32, 4); // height
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdrData),
    pngChunk("IDAT", Buffer.from([0x00])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
})();

// A structurally valid PNG of EXACTLY `total` bytes: signature + IHDR + one
// large IDAT (a critical chunk the metadata stripper keeps) + IEND. Used to
// prove a photo of exactly MAX_MEMBER_PHOTO_BYTES passes the fail-closed strip
// and stores (201) rather than 413ing on the inclusive-cap boundary (#2235).
function pngOfExactSize(total: number): Buffer {
  const pngChunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4); // stripper does not validate the CRC
    return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
  };
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(64, 0); // width
  ihdrData.writeUInt32BE(32, 4); // height
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk("IHDR", ihdrData);
  const iend = pngChunk("IEND", Buffer.alloc(0));
  // sig + ihdr + (12 header/crc + idatLen) + iend === total.
  const idatLen = total - (sig.length + ihdr.length + 12 + iend.length);
  if (idatLen < 0) throw new Error("target size too small for a PNG");
  const idat = pngChunk("IDAT", Buffer.alloc(idatLen, 0x00));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

const GIF_BYTES = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");

const WEBP_BYTES = (() => {
  const buf = Buffer.alloc(16);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(8, 4);
  buf.write("WEBP", 8, "ascii");
  return buf;
})();

// A VP8X WebP declaring a 16384×16384 canvas (> MAX_MEMBER_PHOTO_DIMENSION):
// small on disk, a ~1GB decode bomb in the browser.
const OVERSIZED_WEBP_BYTES = (() => {
  const payload = Buffer.alloc(10); // 4 flags/reserved + 3 (w-1) + 3 (h-1)
  payload.writeUIntLE(16383, 4, 3);
  payload.writeUIntLE(16383, 7, 3);
  const buf = Buffer.alloc(20 + payload.length);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(4 + 8 + payload.length, 4);
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  buf.writeUInt32LE(payload.length, 16);
  payload.copy(buf, 20);
  return buf;
})();

// A renderable JPEG that STILL sniffs as image/jpeg (FF D8 FF…) and still parses
// a frame (SOF0 → 16×16), but has NO trailing EOI (FF D9) and carries EXIF/GPS.
// This is the exact fail-open leak: the old strip returned it unchanged and the
// route stored & served the raw GPS bytes. Fail-closed, the route must reject it.
const NO_EOI_JPEG_BYTES = (() => {
  const soi = Buffer.from([0xff, 0xd8]);
  const exif = (() => {
    const payload = Buffer.from("Exif\0\0GPS:-41.29,174.78", "latin1");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    return Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]); // FF E1 → byte[2]=0xff
  })();
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
  // SOS header + a byte of entropy-coded scan data, but NO closing FF D9.
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x77]);
  return Buffer.concat([soi, exif, sof0, sos]);
})();

// The GPS payload embedded in the EXIF fixtures, so a test can assert it is
// present in the raw upload but absent from the stored (stripped) bytes.
const EXIF_GPS_MARKER = Buffer.from("GPS:-41.29,174.78", "latin1");

// A WELL-FORMED JPEG: the same APP1 EXIF/GPS as above but WITH a proper primary
// EOI (FF D9), so the fail-closed stripper reaches its clean-exit and CAN confirm
// the strip. The route must accept it (201) and store the CLEANED bytes — the
// APP1 EXIF segment gone — proving the end-to-end "GPS never reaches storage"
// guarantee for the direct-upload path (not just the lib-level strip unit test).
const EXIF_JPEG_WITH_EOI_BYTES = (() => {
  const soi = Buffer.from([0xff, 0xd8]);
  const exif = (() => {
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), EXIF_GPS_MARKER]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2, 0);
    return Buffer.concat([Buffer.from([0xff, 0xe1]), len, payload]); // APP1
  })();
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
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x77]);
  const eoi = Buffer.from([0xff, 0xd9]); // primary EOI → clean strip exit
  return Buffer.concat([soi, exif, sof0, sos, eoi]);
})();

/**
 * Wire prisma.member.findUnique to answer each of the route's three distinct
 * selects: the GET committee/photo lookup, the GET private-branch viewer
 * lookup, and the POST/DELETE target lookup.
 */
function wireMemberLookups({
  photoImageId,
  committeePublished,
  memberActive = true,
  viewer,
}: {
  photoImageId: string | null;
  committeePublished?: boolean;
  memberActive?: boolean;
  viewer?: { active: boolean; accessRoles: Array<{ role: string }> } | null;
}) {
  mocks.memberFindUnique.mockImplementation(
    async ({ where, select }: { where: { id: string }; select: Record<string, unknown> }) => {
      if (select.committeeAssignments) {
        if (photoImageId === null) {
          return {
            active: memberActive,
            photoImageId: null,
            photoUpdatedAt: PHOTO_UPDATED_AT,
            committeeAssignments: [],
          };
        }
        return {
          active: memberActive,
          photoImageId,
          photoUpdatedAt: PHOTO_UPDATED_AT,
          committeeAssignments: committeePublished ? [{ id: "ca-1" }] : [],
        };
      }
      if (select.accessRoles) {
        return viewer ?? null;
      }
      // POST/DELETE target lookup.
      return where.id === TARGET_ID ? { id: TARGET_ID } : null;
    },
  );
  // The upload/remove transaction re-reads the current pointer under a row lock
  // (SELECT ... FOR UPDATE) instead of trusting the pre-transaction read, so a
  // concurrent replace can't orphan a blob. Mirror the current pointer here.
  mocks.txQueryRaw.mockResolvedValue([{ photoImageId }]);
}

function servingRequest(id: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/members/${id}/photo`, { headers });
}

function uploadRequest(id: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return new NextRequest(`http://localhost/api/members/${id}/photo`, {
    method: "POST",
    body: formData,
  });
}

// Build a raw multipart body of `sizeBytes` total so a streamed (chunked) or
// spoofed-Content-Length upload can drive the oversize-body path directly,
// bypassing the old Content-Length pre-check the way an attacker would.
function rawMultipartBody(sizeBytes: number): Buffer {
  const boundary = "----memberPhotoTestBoundary";
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf8",
  );
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const dataLen = Math.max(0, sizeBytes - header.length - trailer.length);
  return Buffer.concat([header, Buffer.alloc(dataLen, 0x61), trailer]);
}

const MEMBER_PHOTO_BOUNDARY_CT =
  "multipart/form-data; boundary=----memberPhotoTestBoundary";

/**
 * A streamed upload whose body exceeds the request cap but declares a tiny,
 * honest-looking Content-Length — the exact chunked/spoofed bypass #2235 closes.
 */
function chunkedOversizeUploadRequest(id: string): NextRequest {
  const body = rawMultipartBody(3 * 1024 * 1024); // > 2MB + 64KB request cap
  let offset = 0;
  let cancelled = false;
  // Cancel-safe source: once the reader stops/cancels, never enqueue again, so
  // the fixture can't race a closed controller if the runtime tears the
  // abandoned body down mid-stream.
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 64 * 1024, body.length);
      controller.enqueue(new Uint8Array(body.subarray(offset, end)));
      offset = end;
    },
    cancel() {
      cancelled = true;
    },
  });
  return new NextRequest(`http://localhost/api/members/${id}/photo`, {
    method: "POST",
    headers: {
      "content-type": MEMBER_PHOTO_BOUNDARY_CT,
      // Spoofed-small length that would sail past a naive pre-check.
      "content-length": "1024",
    },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(null);
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.mediaImageFindUnique.mockResolvedValue({
    data: PNG_BYTES,
    contentType: "image/png",
    kind: "MEMBER_PHOTO",
  });
  mocks.mediaImageCreate.mockImplementation(async ({ data }) => ({
    id: "img-new",
    contentType: data.contentType,
    byteSize: data.byteSize,
  }));
  mocks.mediaImageDeleteMany.mockResolvedValue({ count: 1 });
  mocks.memberUpdate.mockResolvedValue({});
  mocks.txQueryRaw.mockResolvedValue([{ photoImageId: null }]);
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({
      $queryRaw: mocks.txQueryRaw,
      mediaImage: {
        create: mocks.mediaImageCreate,
        deleteMany: mocks.mediaImageDeleteMany,
      },
      member: { update: mocks.memberUpdate },
    }),
  );
});

describe("GET /api/members/[id]/photo — serving authz matrix", () => {
  it("serves a committee-published member's photo to an anonymous fetch (public cache)", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: true });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    // Opaque digest, never the raw MediaImage id (defence against id leakage).
    expect(response.headers.get("ETag")).toBe(
      committeeEtag("img-1", PHOTO_UPDATED_AT),
    );
    expect(response.headers.get("ETag")).not.toBe('"img-1"');
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.equals(PNG_BYTES)).toBe(true);
  });

  it("returns 304 for a committee photo when If-None-Match matches", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: true });

    const response = await GET(
      servingRequest(TARGET_ID, {
        "if-none-match": committeeEtag("img-1", PHOTO_UPDATED_AT),
      }),
      params(TARGET_ID),
    );

    expect(response.status).toBe(304);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it("returns 404 to an anonymous fetch for a non-published member", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: false });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("returns 404 to an anonymous fetch for a deactivated member holding a stale published assignment", async () => {
    // Lockstep with /api/committee (member: { active: true }): a deactivated
    // member is absent from the committee page, so their photo must not be
    // publicly servable even if a published assignment lingers.
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: true,
      memberActive: false,
    });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("serves a private photo to the owning member (no-store)", async () => {
    wireMemberLookups({ photoImageId: "img-1", committeePublished: false });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Cookie");
  });

  it("returns 404 to a different, non-admin member for a private photo", async () => {
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: false,
      viewer: { active: true, accessRoles: [{ role: "USER" }] },
    });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
    expect(mocks.mediaImageFindUnique).not.toHaveBeenCalled();
  });

  it("serves a private photo to a membership admin (no-store)", async () => {
    wireMemberLookups({
      photoImageId: "img-1",
      committeePublished: false,
      viewer: { active: true, accessRoles: [{ role: "ADMIN_READONLY" }] },
    });
    mocks.auth.mockResolvedValue(readonlyAdminSession);

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns 404 when the member has no photo", async () => {
    wireMemberLookups({ photoImageId: null });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
  });

  it("returns 404 when photoImageId points at a non-MEMBER_PHOTO row (kind guard)", async () => {
    // Defence in depth: a future mispointed FK to a CONTENT image must fail
    // closed rather than serve arbitrary library content through the committee-
    // cacheable member-photo path.
    wireMemberLookups({ photoImageId: "img-1", committeePublished: true });
    mocks.mediaImageFindUnique.mockResolvedValue({
      data: PNG_BYTES,
      contentType: "image/png",
      kind: "CONTENT",
    });

    const response = await GET(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(404);
  });
});

describe("POST /api/members/[id]/photo — upload", () => {
  it("stamps kind=MEMBER_PHOTO, audit columns and photoImageId on a self-upload", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: "image/png",
          kind: "MEMBER_PHOTO",
          uploadedByMemberId: TARGET_ID,
          width: 64,
          height: 32,
        }),
      }),
    );
    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TARGET_ID },
        data: expect.objectContaining({
          photoImageId: "img-new",
          photoUpdatedByMemberId: TARGET_ID,
          photoUpdatedAt: expect.any(Date),
        }),
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.upload" }),
    );
  });

  it("strips EXIF/GPS from a well-formed JPEG and stores only the cleaned bytes (201)", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    // Sanity: the raw upload really does carry the GPS marker.
    expect(EXIF_JPEG_WITH_EOI_BYTES.includes(EXIF_GPS_MARKER)).toBe(true);

    const file = new File([EXIF_JPEG_WITH_EOI_BYTES], "me.jpg", { type: "image/jpeg" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledTimes(1);

    // The bytes handed to storage must be the CLEANED buffer, not the original:
    // no GPS payload, no "Exif" header, and no APP1 (FF E1) marker survives —
    // while it remains a structurally valid JPEG (SOI … primary EOI).
    const stored = Buffer.from(mocks.mediaImageCreate.mock.calls[0][0].data.data as Uint8Array);
    expect(stored.includes(EXIF_GPS_MARKER)).toBe(false);
    expect(stored.includes(Buffer.from("Exif", "latin1"))).toBe(false);
    let hasApp1 = false;
    for (let i = 0; i + 1 < stored.length; i += 1) {
      if (stored[i] === 0xff && stored[i + 1] === 0xe1) {
        hasApp1 = true;
        break;
      }
    }
    expect(hasApp1).toBe(false);
    expect(stored[0]).toBe(0xff);
    expect(stored[1]).toBe(0xd8);
    expect(stored[stored.length - 2]).toBe(0xff);
    expect(stored[stored.length - 1]).toBe(0xd9);
  });

  it("accepts a WebP whose dimensions cannot be parsed (truncated header)", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([WEBP_BYTES], "me.webp", { type: "image/webp" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          contentType: "image/webp",
          width: null,
          height: null,
        }),
      }),
    );
  });

  it("rejects an oversized-canvas VP8X WebP (decode-bomb backstop) with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([OVERSIZED_WEBP_BYTES], "bomb.webp", {
      type: "image/webp",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("cleans up the previous MEMBER_PHOTO blob when replacing", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "old-img", kind: "MEMBER_PHOTO" },
    });
  });

  it("rejects a disallowed image type (GIF) with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([GIF_BYTES], "me.gif", { type: "image/gif" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects bytes that are not a recognised image with 400", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([Buffer.from("not an image")], "me.png", {
      type: "image/png",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects a renderable-but-no-EOI JPEG (unconfirmed strip) with 400 and stores nothing", async () => {
    // Fail-closed regression guard: this JPEG sniffs as image/jpeg and parses a
    // frame, but the stripper cannot confirm a clean strip (no primary EOI), so
    // the route must reject it BEFORE the transaction — never storing bytes whose
    // EXIF/GPS we could not prove was scrubbed.
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const file = new File([NO_EOI_JPEG_BYTES], "leak.jpg", {
      type: "image/jpeg",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("rejects an oversize file with 413", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(2 * 1024 * 1024)]);
    const file = new File([big], "big.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("accepts a photo of EXACTLY the 2MB cap (inclusive boundary, #2235 off-by-one guard)", async () => {
    // busboy trips its file limit at `size === cap`; the streamed reader passes
    // `cap + 1` so a photo of exactly MAX_MEMBER_PHOTO_BYTES still stores, as it
    // did under the old post-parse `size > MAX` check — never a spurious 413 on
    // the boundary. A real 2MB PNG so it also clears the fail-closed EXIF strip.
    const MAX_MEMBER_PHOTO_BYTES = 2 * 1024 * 1024;
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const exact = pngOfExactSize(MAX_MEMBER_PHOTO_BYTES);
    expect(exact.length).toBe(MAX_MEMBER_PHOTO_BYTES);
    const file = new File([new Uint8Array(exact)], "exact.png", {
      type: "image/png",
    });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledTimes(1);
  });

  it("rejects a chunked, spoofed-Content-Length oversize body with 413 (streamed cap, #2235)", async () => {
    // Regression: the old Content-Length pre-check trusted the header, so a
    // chunked or spoofed-small Content-Length skipped it and request.formData()
    // buffered the whole multi-MB body. The streamed reader now cuts it off.
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await POST(
      chunkedOversizeUploadRequest(TARGET_ID),
      params(TARGET_ID),
    );

    expect(response.status).toBe(413);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("blocks a member uploading to another member's id (IDOR) with 403", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("allows a membership-edit admin to upload on behalf of a member", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(membershipAdminSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(201);
    expect(mocks.mediaImageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ uploadedByMemberId: "admin-1" }),
      }),
    );
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.upload", subjectMemberId: TARGET_ID }),
    );
  });

  it("rejects a view-only admin (membership:edit required) with 403", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(readonlyAdminSession);

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });

  it("requires a session (401) for an anonymous upload", async () => {
    wireMemberLookups({ photoImageId: null });

    const file = new File([PNG_BYTES], "me.png", { type: "image/png" });
    const response = await POST(uploadRequest(TARGET_ID, file), params(TARGET_ID));

    expect(response.status).toBe(401);
    expect(mocks.mediaImageCreate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/members/[id]/photo — remove", () => {
  it("clears the pointer and deletes the blob on a self-remove", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.memberUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          photoImageId: null,
          photoUpdatedByMemberId: TARGET_ID,
        }),
      }),
    );
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalledWith({
      where: { id: "old-img", kind: "MEMBER_PHOTO" },
    });
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "member_photo.remove" }),
    );
  });

  it("is idempotent when the member has no photo", async () => {
    wireMemberLookups({ photoImageId: null });
    mocks.auth.mockResolvedValue(ownerSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.mediaImageDeleteMany).not.toHaveBeenCalled();
  });

  it("blocks a member removing another member's photo (IDOR) with 403", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(otherMemberSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(403);
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("allows a membership-edit admin to remove on behalf of a member", async () => {
    wireMemberLookups({ photoImageId: "old-img" });
    mocks.auth.mockResolvedValue(membershipAdminSession);

    const response = await DELETE(servingRequest(TARGET_ID), params(TARGET_ID));

    expect(response.status).toBe(200);
    expect(mocks.mediaImageDeleteMany).toHaveBeenCalled();
  });
});
