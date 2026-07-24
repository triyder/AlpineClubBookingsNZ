import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

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

// The route (and image-storage) do `import fs from "fs/promises"` — mock the
// default so the filesystem is never touched. resolveInImagesRoot stays REAL
// (a pure path computation under process.cwd()), exercising the containment
// path exactly as production would.
vi.mock("fs/promises", () => ({
  default: { mkdir: mocks.mkdir, writeFile: mocks.writeFile },
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

import { POST } from "@/app/api/admin/image-manager/upload/route";

const adminSession = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
const memberSession = {
  user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};

const MAX_FILE_SIZE = 10 * 1024 * 1024; // mirrors the route constant
const MAX_UPLOAD_FILES = 25;
const MAX_UPLOAD_REQUEST_BYTES = 80 * 1024 * 1024;
const BOUNDARY = "----imageManagerTestBoundary";

function pngFile(name: string, size = 8): File {
  // The route trusts the declared type + extension (it does not sniff magic
  // bytes), so a small buffer with an image/png type and .png name is a valid
  // upload for its purposes.
  return new File([Buffer.alloc(size, 0x61)], name, { type: "image/png" });
}

function uploadRequest(files: File[], dir?: string): NextRequest {
  const formData = new FormData();
  if (dir !== undefined) formData.append("dir", dir);
  for (const f of files) formData.append("files", f);
  return new NextRequest(
    "http://localhost/api/admin/image-manager/upload",
    { method: "POST", body: formData },
  );
}

/**
 * A chunked (no Content-Length) body that streams past the 80 MB request cap
 * WITHOUT ever allocating 80 MB in the test: a single 64 KB buffer is re-sent
 * until the counter trips. The streamed reader cancels the source mid-flight.
 */
function oversizeAggregateRequest(): NextRequest {
  const header = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf8",
  );
  const CHUNK = new Uint8Array(64 * 1024).fill(0x61);
  const LIMIT = MAX_UPLOAD_REQUEST_BYTES + 2 * 1024 * 1024; // a touch over the cap
  let sent = 0;
  let headerSent = false;
  let cancelled = false;
  // Cancel-safe source: once the reader stops/cancels, never enqueue again, so
  // the fixture can't race a closed controller if the runtime tears the
  // abandoned body down mid-stream.
  const stream = new ReadableStream({
    pull(controller) {
      if (cancelled) return;
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(new Uint8Array(header));
        sent += header.length;
        return;
      }
      if (sent >= LIMIT) {
        controller.close();
        return;
      }
      controller.enqueue(CHUNK);
      sent += CHUNK.length;
    },
    cancel() {
      cancelled = true;
    },
  });
  return new NextRequest("http://localhost/api/admin/image-manager/upload", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1] & { duplex: "half" });
}

describe("POST /api/admin/image-manager/upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession);
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it("requires an admin (content:edit) session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(uploadRequest([pngFile("a.png")]));
    expect(response.status).toBe(401);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a non-admin member", async () => {
    mocks.auth.mockResolvedValue(memberSession);
    const response = await POST(uploadRequest([pngFile("a.png")]));
    expect(response.status).toBe(403);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("uploads a valid multi-file batch, reporting per-file success", async () => {
    const response = await POST(
      uploadRequest([pngFile("a.png"), pngFile("b.png")]),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(mocks.writeFile).toHaveBeenCalledTimes(2);
  });

  it("preserves partial success: one >10MB file fails per-file while the rest succeed", async () => {
    const tooBig = pngFile("big.png", MAX_FILE_SIZE + 1);
    const ok = pngFile("ok.png");
    const response = await POST(uploadRequest([tooBig, ok]));
    const body = await response.json();

    // The whole batch is NOT rejected — the oversize file is a per-file failure
    // (the streamed reader's per-file cap is the 80MB request ceiling, not the
    // friendly 10MB, so a single big file surfaces here rather than 413ing).
    expect(response.status).toBe(200);
    const big = body.results.find((r: { filename: string }) =>
      r.filename.includes("big"),
    );
    const good = body.results.find(
      (r: { filename: string }) => r.filename === "ok.png",
    );
    expect(big.ok).toBe(false);
    expect(big.error).toMatch(/10 MB/);
    expect(good.ok).toBe(true);
    // Only the valid file was written.
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
  });

  it("rejects a batch of more than 25 files with an actionable 413 (names the file limit)", async () => {
    const files = Array.from({ length: MAX_UPLOAD_FILES + 1 }, (_, i) =>
      pngFile(`f${i}.png`),
    );
    const response = await POST(uploadRequest(files));
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toMatch(new RegExp(`${MAX_UPLOAD_FILES} files`));
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("rejects an aggregate body over the request cap with an actionable 413 (says to split the batch)", async () => {
    const response = await POST(oversizeAggregateRequest());
    const body = await response.json();

    expect(response.status).toBe(413);
    expect(body.error).toMatch(/split the upload/i);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
