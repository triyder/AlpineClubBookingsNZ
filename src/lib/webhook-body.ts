export class WebhookBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Webhook payload exceeds ${maxBytes} bytes`);
    this.name = "WebhookBodyTooLargeError";
  }
}

export class WebhookBodyInvalidContentLengthError extends Error {
  constructor(readonly contentLength: string) {
    super("Webhook payload has an invalid content-length header");
    this.name = "WebhookBodyInvalidContentLengthError";
  }
}

export function isWebhookBodyTooLargeError(
  error: unknown
): error is WebhookBodyTooLargeError {
  return error instanceof WebhookBodyTooLargeError;
}

export function isWebhookBodyInvalidContentLengthError(
  error: unknown
): error is WebhookBodyInvalidContentLengthError {
  return error instanceof WebhookBodyInvalidContentLengthError;
}

export async function readBoundedWebhookText(
  request: Request,
  maxBytes: number
): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const normalizedLength = declaredLength.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(normalizedLength)) {
      throw new WebhookBodyInvalidContentLengthError(declaredLength);
    }

    const parsedLength = Number.parseInt(normalizedLength, 10);
    if (!Number.isSafeInteger(parsedLength)) {
      throw new WebhookBodyInvalidContentLengthError(declaredLength);
    }

    if (parsedLength > maxBytes) {
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
