import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAuthSecretWithSource, isAuthSecretStrongEnough } from "@/lib/integration-crypto";
import { asRecord } from "@/lib/xero-json";
import { stableDigest } from "@/lib/stable-digest";

export type InvoiceObservationCursorScope = { actorId: string; bookingId: string; tenantId: string; revision: string };
export const MAX_INVOICE_OBSERVATION_CURSOR_LENGTH = 2_000;
function signature(body: string): Buffer {
  const secret = getAuthSecretWithSource()?.secret;
  if (!isAuthSecretStrongEnough(secret)) throw new Error("Observation continuation is unavailable");
  return createHmac("sha256", secret!).update(`booking-invoice-observation:${body}`).digest();
}

export function createInvoiceObservationCursor(scope: InvoiceObservationCursorScope, offset: number): string {
  const body = Buffer.from(JSON.stringify({ scope: stableDigest(scope), offset })).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

export function readInvoiceObservationCursor(cursor: string, scope: InvoiceObservationCursorScope, count: number): number | null {
  if (cursor.length > MAX_INVOICE_OBSERVATION_CURSOR_LENGTH) return null;
  try {
    const parts = cursor.split(".");
    if (parts.length !== 2) return null;
    const [body, signed] = parts;
    if (!body || !signed) return null;
    const expected = signature(body);
    const actual = Buffer.from(signed, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const value = asRecord(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!value || value.scope !== stableDigest(scope)) return null;
    return typeof value.offset === "number" && Number.isSafeInteger(value.offset) && value.offset > 0 && value.offset < count
      ? value.offset : null;
  } catch {
    return null;
  }
}
