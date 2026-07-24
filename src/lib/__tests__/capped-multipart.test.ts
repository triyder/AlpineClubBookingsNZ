import { describe, expect, it } from "vitest";

import { readCappedMultipartFormData } from "@/lib/capped-multipart";

// `server-only` is stubbed globally in vitest.setup.ts.

const BOUNDARY = "----cappedMultipartTestBoundary";
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

/** Build a well-formed multipart/form-data body from fields + files. */
function buildMultipart(
  parts: Array<
    | { kind: "field"; name: string; value: string }
    | { kind: "file"; name: string; filename: string; contentType: string; bytes: Buffer }
  >,
): Buffer {
  const segments: Buffer[] = [];
  for (const part of parts) {
    const header =
      part.kind === "field"
        ? `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n`
        : `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType}\r\n\r\n`;
    segments.push(Buffer.from(header, "utf8"));
    segments.push(
      part.kind === "field" ? Buffer.from(part.value, "utf8") : part.bytes,
    );
    segments.push(Buffer.from("\r\n", "utf8"));
  }
  segments.push(Buffer.from(`--${BOUNDARY}--\r\n`, "utf8"));
  return Buffer.concat(segments);
}

/** A Request whose body is a fully-buffered multipart payload. */
function bufferedRequest(body: Buffer, headers: Record<string, string> = {}) {
  return new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": CT, ...headers },
    body: new Uint8Array(body),
  });
}

/**
 * A Request whose body is a chunked ReadableStream that reports how many chunks
 * were actually pulled and whether it was cancelled — so a test can prove the
 * reader stops consuming the source instead of draining the whole body.
 *
 * Non-buffering is proven by `chunksPulled`/`bytesEnqueued` staying near the cap
 * (the reader ceases to pull once the request cap trips). `cancelled` is
 * expected to stay FALSE: the helper deliberately does NOT cancel the body
 * reader (that would race undici's byte-stream wrapper — see the `settle` note
 * in capped-multipart.ts); it relies on the source being pull-driven so that
 * simply not reading halts it.
 */
function streamedRequest(
  body: Buffer,
  {
    chunkSize = 64 * 1024,
    headers = {},
  }: { chunkSize?: number; headers?: Record<string, string> } = {},
) {
  const meta = { chunksPulled: 0, cancelled: false, bytesEnqueued: 0 };
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      meta.chunksPulled += 1;
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, body.length);
      const chunk = body.subarray(offset, end);
      offset = end;
      meta.bytesEnqueued += chunk.length;
      controller.enqueue(new Uint8Array(chunk));
    },
    cancel() {
      meta.cancelled = true;
    },
  });
  const request = new Request("http://localhost/upload", {
    method: "POST",
    headers: { "content-type": CT, ...headers },
    body: stream,
    // Node/undici require an explicit half-duplex flag for a stream body.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, meta };
}

describe("readCappedMultipartFormData", () => {
  it("accepts a valid multipart body (file + text fields) with byte-identical contents", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const body = buildMultipart([
      { kind: "field", name: "mode", value: "overwrite" },
      { kind: "field", name: "note", value: "hello world" },
      {
        kind: "file",
        name: "file",
        filename: "photo.png",
        contentType: "image/png",
        bytes,
      },
    ]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxFiles: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formData.get("mode")).toBe("overwrite");
    expect(result.formData.get("note")).toBe("hello world");
    const file = result.formData.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) return;
    expect(file.name).toBe("photo.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(bytes.length);
    const stored = Buffer.from(await file.arrayBuffer());
    expect(stored.equals(bytes)).toBe(true);
  });

  it("rejects a chunked body (no Content-Length) exceeding maxRequestBytes and stops draining the source", async () => {
    // A single huge file part with no closing boundary within the cap: busboy
    // keeps consuming file data, so the REQUEST-byte counter is what must trip.
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    // 4 MB of body, fed 64 KB at a time; cap at 256 KB.
    const huge = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024, 0x61)]);
    const { request, meta } = streamedRequest(huge, { chunkSize: 64 * 1024 });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 256 * 1024,
      // per-file cap deliberately huge so the REQUEST cap is what trips.
      maxFileBytes: 100 * 1024 * 1024,
      maxFiles: 1,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "request" });
    // Non-buffering proof: the reader stopped pulling after ~cap bytes, nowhere
    // near the full 4 MB (256 KB / 64 KB ≈ 4 chunks, plus a small margin). The
    // helper stops by ceasing to read, NOT by cancelling the body reader, so the
    // source's cancel() must never fire.
    expect(meta.cancelled).toBe(false);
    expect(meta.chunksPulled).toBeLessThan(12);
    expect(meta.bytesEnqueued).toBeLessThan(1024 * 1024);
  });

  it("rejects a spoofed-small Content-Length whose actual body is larger (mid-stream)", async () => {
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const huge = Buffer.concat([header, Buffer.alloc(2 * 1024 * 1024, 0x61)]);
    // Declares a tiny, honest-looking length that would pass the fast-fail.
    const { request, meta } = streamedRequest(huge, {
      chunkSize: 64 * 1024,
      headers: { "content-length": "1024" },
    });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 256 * 1024,
      maxFileBytes: 100 * 1024 * 1024,
      maxFiles: 1,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "request" });
    // The reader stops by ceasing to pull, not by cancelling (see note above).
    expect(meta.cancelled).toBe(false);
    expect(meta.bytesEnqueued).toBeLessThan(1024 * 1024);
  });

  it("rejects an honest oversize Content-Length without reading the body at all", async () => {
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      "utf8",
    );
    const huge = Buffer.concat([header, Buffer.alloc(2 * 1024 * 1024, 0x61)]);
    const { request, meta } = streamedRequest(huge, {
      headers: { "content-length": String(huge.length) },
    });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 256 * 1024,
      maxFileBytes: 100 * 1024 * 1024,
      maxFiles: 1,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "request" });
    // The fast-fail fired on the header before the helper read the body: the
    // helper never called getReader(). undici itself may eagerly pull at most a
    // single chunk while constructing the Request, but the multi-MB body is
    // never drained.
    expect(meta.chunksPulled).toBeLessThanOrEqual(1);
    expect(meta.bytesEnqueued).toBeLessThan(128 * 1024);
  });

  it("rejects a single file exceeding maxFileBytes while the total stays under the request cap (truncation trap)", async () => {
    // 200 KB file, request cap 1 MB (so the request cap does NOT trip), per-file
    // cap 64 KB — busboy would silently truncate, so the helper must fail closed.
    const bytes = Buffer.alloc(200 * 1024, 0x62);
    const body = buildMultipart([
      {
        kind: "file",
        name: "file",
        filename: "big.png",
        contentType: "image/png",
        bytes,
      },
    ]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 64 * 1024,
      maxFiles: 1,
    });

    // Truncation trap reports cause "file" so a route can message the FILE cap.
    expect(result).toEqual({ ok: false, reason: "too_large", cause: "file" });
  });

  it("accepts a file of EXACTLY maxFileBytes (inclusive cap, off-by-one guard #2235)", async () => {
    // busboy trips its file limit at `fileSize === limit`; the helper passes
    // `maxFileBytes + 1` so a file of exactly the cap succeeds, matching the old
    // post-parse `size > MAX` semantics. Regression guard against the exact-cap
    // 413 the raw busboy limit would produce.
    const cap = 64 * 1024;
    const bytes = Buffer.alloc(cap, 0x62); // exactly at the cap
    const body = buildMultipart([
      {
        kind: "file",
        name: "file",
        filename: "exact.png",
        contentType: "image/png",
        bytes,
      },
    ]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: cap,
      maxFiles: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const file = result.formData.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) return;
    expect(file.size).toBe(cap);
  });

  it("accepts a field value of EXACTLY maxFieldBytes (inclusive cap #2235)", async () => {
    const cap = 4096;
    const value = "y".repeat(cap); // exactly at the field cap
    const body = buildMultipart([{ kind: "field", name: "big", value }]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxFieldBytes: cap,
      maxFields: 4,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.formData.get("big")).toBe(value);
  });

  it("rejects a field value exceeding maxFieldBytes with cause \"field\"", async () => {
    const cap = 4096;
    const value = "z".repeat(cap + 1); // one byte over the field cap
    const body = buildMultipart([{ kind: "field", name: "big", value }]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxFieldBytes: cap,
      maxFields: 4,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "field" });
  });

  it("rejects more fields than maxFields with cause \"count\"", async () => {
    const body = buildMultipart([
      { kind: "field", name: "a", value: "1" },
      { kind: "field", name: "b", value: "2" },
      { kind: "field", name: "c", value: "3" },
    ]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxFields: 2,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "count" });
  });

  it("rejects more file parts than maxFiles with cause \"count\"", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const body = buildMultipart([
      { kind: "file", name: "files", filename: "a.png", contentType: "image/png", bytes },
      { kind: "file", name: "files", filename: "b.png", contentType: "image/png", bytes },
    ]);

    const result = await readCappedMultipartFormData(bufferedRequest(body), {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxFiles: 1,
    });

    expect(result).toEqual({ ok: false, reason: "too_large", cause: "count" });
  });

  it("returns invalid for a non-multipart content type", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns invalid for a malformed multipart body (bad boundary)", async () => {
    const request = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": CT },
      body: new Uint8Array(
        Buffer.from("this is not a valid multipart payload at all", "utf8"),
      ),
    });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("returns invalid when the request has no body", async () => {
    const request = new Request("http://localhost/upload", {
      method: "GET",
      headers: { "content-type": CT },
    });

    const result = await readCappedMultipartFormData(request, {
      maxRequestBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
    });

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
