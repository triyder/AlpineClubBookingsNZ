/**
 * Xero connection-health probe (#2105).
 *
 * The admin Xero page shows a green "Connected" chip on token-row presence
 * alone, so a revoked refresh token still reads as healthy. This module makes an
 * explicit, admin-triggered live probe that actually exercises the token
 * refresh + a cheap cached organisation read and classifies the outcome.
 *
 * Hard requirements:
 * - The probe is CLICK-ONLY (never on page mount or a poll); the caller (the
 *   status route) only runs it for `?probe=1`.
 * - The result is cached in-process for 30–60s so repeated clicks (or several
 *   admins) cannot hammer Xero. A cached hit makes no network call.
 * - A daily-limit cooldown maps to "rate_limited" WITHOUT any API call:
 *   getAuthenticatedXeroClient's in-process gate throws XeroDailyLimitError
 *   before any network request, so an uncapped probe can never burn the shared
 *   daily budget.
 */

import logger from "@/lib/logger";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { getLatestXeroUsageErrorMessage } from "@/lib/xero-api-usage";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";
import { getXeroLockDates } from "@/lib/xero-organisation";

export type XeroTokenHealth =
  | "ok"
  | "reconnect_required"
  | "rate_limited"
  | "error";

export interface XeroConnectionProbeResult {
  tokenHealth: XeroTokenHealth;
  /** ISO timestamp of when this result was computed. */
  checkedAt: string;
  /**
   * The most recent recorded usage error, redacted, surfaced near the chip so
   * admins can diagnose a degraded connection. Null when healthy or none
   * recorded.
   */
  lastErrorMessage: string | null;
  /** True when this result was served from the in-process cache. */
  cached: boolean;
}

// 45s sits in the required 30–60s window.
const PROBE_CACHE_TTL_MS = 45 * 1000;

interface ProbeCacheEntry {
  result: Omit<XeroConnectionProbeResult, "cached">;
  cachedAtMs: number;
}

let probeCache: ProbeCacheEntry | null = null;

function classifyProbeError(error: unknown): XeroTokenHealth {
  if (error instanceof Error) {
    // XeroDailyLimitError is thrown by getAuthenticatedXeroClient's gate before
    // any network call, so a rate-limited probe never spends budget.
    if (error.name === "XeroDailyLimitError") {
      return "rate_limited";
    }
    if (error.name === "XeroReconnectRequiredError") {
      return "reconnect_required";
    }
  }
  // Raw 401/403 from the live read (token revoked before the pre-expiry
  // refresh window trips) — same status fallback as getXeroApiErrorInfo, so
  // the panel shows the Reconnect CTA instead of a generic failure.
  const statusCode = getXeroErrorStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return "reconnect_required";
  }
  return "error";
}

async function readLatestRedactedUsageError(): Promise<string | null> {
  try {
    const message = await getLatestXeroUsageErrorMessage();
    return message ? redactSensitiveText(message) : null;
  } catch (error) {
    logger.warn({ err: error }, "Failed to read latest Xero usage error message");
    return null;
  }
}

/**
 * Probe the live Xero connection health, using the in-process cache when a fresh
 * result exists. `now` is injectable for tests.
 */
export async function probeXeroConnectionHealth(
  now: number = Date.now(),
): Promise<XeroConnectionProbeResult> {
  if (probeCache && now - probeCache.cachedAtMs < PROBE_CACHE_TTL_MS) {
    return { ...probeCache.result, cached: true };
  }

  let tokenHealth: XeroTokenHealth;
  try {
    // Refreshes the token if needed (revoked/expired => XeroReconnectRequiredError)
    // and trips the daily-limit gate before any network call.
    await getAuthenticatedXeroClient();
    // Cheap, cached (~5 min) organisation read; false reuses the existing cache
    // so a healthy probe usually makes no extra Xero call.
    await getXeroLockDates(false);
    tokenHealth = "ok";
  } catch (error) {
    tokenHealth = classifyProbeError(error);
    logger.warn({ err: error, tokenHealth }, "Xero connection probe failed");
  }

  const lastErrorMessage =
    tokenHealth === "ok" ? null : await readLatestRedactedUsageError();

  const result = {
    tokenHealth,
    checkedAt: new Date(now).toISOString(),
    lastErrorMessage,
  };
  probeCache = { result, cachedAtMs: now };
  return { ...result, cached: false };
}

// test seam
export function resetXeroConnectionProbeCacheForTests(): void {
  probeCache = null;
}
