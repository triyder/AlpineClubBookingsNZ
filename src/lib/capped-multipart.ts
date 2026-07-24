import "server-only";

import busboy from "busboy";

/**
 * Streaming, capped multipart/form-data reader (#2235).
 *
 * The stock `request.formData()` buffers the ENTIRE request body into memory
 * before any byte cap runs, and a route's `Content-Length` pre-check is worth
 * nothing against a chunked request (no `Content-Length`) or a spoofed-small
 * one. An authenticated user could therefore POST a multi-GB body and exhaust
 * server memory before the real caps fire.
 *
 * This reader instead pipes `request.body` through busboy incrementally with a
 * total-byte counter sitting UPSTREAM of the parser: the moment the running
 * total exceeds `maxRequestBytes` the reader STOPS pulling from the source and
 * the parser is torn down, so the server stops consuming a hostile body
 * mid-flight. (We deliberately stop reading rather than cancel the body reader
 * — see the `settle` note below for why cancelling is unsafe here.) busboy's
 * own `fileSize`/`files`/`fields`/`parts` limits abort truncating parts the same
 * way. It returns a standard `FormData` built from in-memory `File` objects, so
 * a route only swaps `await request.formData()` for this helper and maps the two
 * failure reasons onto its existing status codes:
 *   - `too_large` → the route's existing 413
 *   - `invalid`   → the route's existing 400
 *
 * Mirrors the counter/strict-Content-Length spirit of
 * `readBoundedWebhookText` in `src/lib/webhook-body.ts`.
 *
 * NOTE: the guaranteed backstop is still the reverse-proxy / platform
 * request-body cap (Caddy/Nginx `client_max_body_size`, the host limit) — this
 * in-app reader is defence in depth for an attacker who reaches the Node
 * process directly or slips past a mis-set proxy. See
 * `docs/SECURITY-ATTACK-SURFACE.md`.
 */

export interface CappedMultipartLimits {
  /** Total request-body ceiling (bytes). Aborts mid-stream when exceeded. */
  maxRequestBytes: number;
  /** Per-file ceiling (bytes). Aborts mid-stream when a single file exceeds it. */
  maxFileBytes: number;
  /** Max number of file parts. Default 1. */
  maxFiles?: number;
  /** Max size of any single non-file field value (bytes). Default 1 MiB. */
  maxFieldBytes?: number;
  /** Max number of non-file fields. Default 64. */
  maxFields?: number;
}

export type CappedMultipartResult =
  | { ok: true; formData: FormData }
  | {
      ok: false;
      reason: "too_large" | "invalid";
      /**
       * Which cap tripped, so a route can message precisely (e.g. distinguish a
       * too-large FILE from too-large form FIELDS or too MANY parts). Optional —
       * existing routes may ignore it and key only on `reason`.
       *   - `request` — the whole-request byte ceiling (or oversize Content-Length)
       *   - `file`    — a single file part exceeded `maxFileBytes`
       *   - `field`   — a single non-file field exceeded `maxFieldBytes`
       *   - `count`   — too many file parts / fields / parts
       */
      cause?: "request" | "file" | "field" | "count";
    };

const DEFAULT_MAX_FILES = 1;
const DEFAULT_MAX_FIELD_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_MAX_FIELDS = 64;

/**
 * Strict Content-Length parse (mirrors webhook-body.ts): only a canonical
 * non-negative integer is honoured. A malformed header is treated as absent
 * rather than trusted — the streamed counter is the real enforcement, so a lax
 * header can never let an oversize body through, and a garbage header must not
 * spuriously 413 a legitimate upload either. Returns the parsed length, or
 * `null` when the header is absent or malformed.
 */
function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const normalized = header.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

export async function readCappedMultipartFormData(
  request: Request,
  limits: CappedMultipartLimits,
): Promise<CappedMultipartResult> {
  const {
    maxRequestBytes,
    maxFileBytes,
    maxFiles = DEFAULT_MAX_FILES,
    maxFieldBytes = DEFAULT_MAX_FIELD_BYTES,
    maxFields = DEFAULT_MAX_FIELDS,
  } = limits;

  // Cheap, honest fast-fail: an oversize declared Content-Length is rejected
  // before the body is touched at all (the stream is never read).
  const declaredLength = parseContentLength(
    request.headers.get("content-length"),
  );
  if (declaredLength !== null && declaredLength > maxRequestBytes) {
    return { ok: false, reason: "too_large", cause: "request" };
  }

  const body = request.body;
  if (!body) {
    return { ok: false, reason: "invalid" };
  }

  // busboy needs the content-type header for the multipart boundary; a missing
  // or non-multipart type throws synchronously → invalid.
  let bb: busboy.Busboy;
  try {
    bb = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      limits: {
        // busboy fires its truncation limit when the running size REACHES the
        // configured value (`fileSize === limit` / `fieldSize === limit`; see
        // node_modules/busboy/lib/types/multipart.js), so a part of EXACTLY
        // maxFileBytes/maxFieldBytes would trip and 413. Add 1 to keep both caps
        // INCLUSIVE maxima, matching the routes' post-parse `size > MAX`
        // semantics: a file/field of exactly the cap succeeds; the limit only
        // trips at cap+1. (Verified against the installed busboy: equality
        // trips truncation for both fileSize and fieldSize.)
        fileSize: maxFileBytes + 1,
        files: maxFiles,
        fieldSize: maxFieldBytes + 1,
        fields: maxFields,
      },
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const reader = body.getReader();
  const formData = new FormData();

  return await new Promise<CappedMultipartResult>((resolve) => {
    let settled = false;

    const settle = (result: CappedMultipartResult) => {
      if (settled) return;
      settled = true;
      // Tear the parser down and STOP pulling from the body — but do NOT call
      // `reader.cancel()`. Constraint: in production `request.body` is undici's
      // internal BYTE stream built by `ReadableStreamFrom()` over the Node
      // `IncomingMessage` — Next sets `NodeNextRequest.body = _req` (the raw
      // IncomingMessage) and hands it to `new NextRequest(url, { body,
      // duplex: "half" })` (next/dist/server/base-http/node.js +
      // .../web/spec-extension/adapters/next-request.js `fromNodeNextRequest`),
      // and undici wraps any async-iterable body via `ReadableStreamFrom`
      // (node_modules/undici/lib/core/util.js:623). That wrapper is a
      // pull-driven `type: "bytes"` stream whose async pull runs
      // `iterator.next().then((v) => controller.enqueue(v))` with
      // `cancel() { iterator.return(); }`. Cancelling mid-stream closes the byte
      // controller while a `next()` is in flight; the resolved chunk is then
      // enqueued into the already-closed controller → "Invalid state:
      // ReadableStream is already closed", surfacing as an UNHANDLED rejection
      // undici does not contain (observed on Node 24 CI; on Node's default
      // unhandled-rejection policy this can terminate the worker — a DoS, the
      // opposite of this reader's purpose). We cannot try/catch undici's
      // internal pull. Because the wrapper is pull-driven, ceasing to read halts
      // the source: `pull` (hence `iterator.next()` on the socket) is only
      // driven by consumer demand, so once `pump()` returns on the `settled`
      // guard the IncomingMessage is left paused and memory stays bounded to
      // ~one highWaterMark of prefetch (measured: a couple of 64 KiB chunks past
      // the cap). The guaranteed backstop remains the reverse-proxy body cap.
      try {
        bb.destroy();
      } catch {
        // already torn down
      }
      resolve(result);
    };

    bb.on("file", (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      // busboy TRUNCATES a file past `fileSize` and emits 'limit' rather than
      // erroring — never accept the silently-truncated remainder; fail the whole
      // request as oversize (matching the routes' 413 semantics).
      stream.on("limit", () =>
        settle({ ok: false, reason: "too_large", cause: "file" }),
      );
      stream.on("error", () => settle({ ok: false, reason: "invalid" }));
      stream.on("end", () => {
        if (settled) return;
        const file = new File([Buffer.concat(chunks)], info.filename ?? "upload", {
          type: info.mimeType || "application/octet-stream",
        });
        formData.append(name, file);
      });
    });

    bb.on("field", (name, value, info) => {
      // A truncated field name or value means the field cap was hit; reject
      // rather than store a silently-truncated value.
      if (info.nameTruncated || info.valueTruncated) {
        settle({ ok: false, reason: "too_large", cause: "field" });
        return;
      }
      formData.append(name, value);
    });

    // Any part/file/field count limit is a hard reject, never a silent drop.
    bb.on("partsLimit", () =>
      settle({ ok: false, reason: "too_large", cause: "count" }),
    );
    bb.on("filesLimit", () =>
      settle({ ok: false, reason: "too_large", cause: "count" }),
    );
    bb.on("fieldsLimit", () =>
      settle({ ok: false, reason: "too_large", cause: "count" }),
    );
    // Malformed multipart (bad boundary, truncated part headers, …).
    bb.on("error", () => settle({ ok: false, reason: "invalid" }));
    bb.on("close", () => settle({ ok: true, formData }));

    // Pump the web stream into busboy with the total-byte counter sitting
    // upstream of the parser, so an oversize body is cut off before busboy (and
    // memory) ever see the whole thing.
    let total = 0;
    const pump = async () => {
      try {
        for (;;) {
          if (settled) return;
          const { value, done } = await reader.read();
          if (done) break;
          if (settled) return;
          total += value.byteLength;
          if (total > maxRequestBytes) {
            settle({ ok: false, reason: "too_large", cause: "request" });
            return;
          }
          if (!bb.write(Buffer.from(value))) {
            // Respect backpressure so a fast producer can't outrun the parser
            // and balloon busboy's internal buffer.
            await new Promise<void>((resolveDrain) => {
              const onDrain = () => {
                bb.off("close", onDrain);
                resolveDrain();
              };
              bb.once("drain", onDrain);
              // If the parser closes/errors while we wait, stop waiting.
              bb.once("close", onDrain);
            });
          }
        }
        if (!settled) bb.end();
      } catch {
        settle({ ok: false, reason: "invalid" });
      }
    };

    void pump();
  });
}
