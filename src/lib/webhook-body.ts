export class WebhookBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Webhook payload exceeds ${maxBytes} bytes`);
    this.name = "WebhookBodyTooLargeError";
  }
}

export function isWebhookBodyTooLargeError(
  error: unknown
): error is WebhookBodyTooLargeError {
  return error instanceof WebhookBodyTooLargeError;
}

export async function readBoundedWebhookText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new WebhookBodyTooLargeError(maxBytes);
    }
  }

  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      throw new WebhookBodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString("utf8");
}
