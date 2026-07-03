/**
 * Rate limiter for Next.js API routes (fixed window with automatic cleanup).
 *
 * Counters live in Postgres (`RateLimitCounter`, one atomic upsert per check)
 * so multiple replicas and blue/green slots share the same window (#1039
 * item 4). When the database is unreachable the limiter falls back to the
 * original per-process in-memory counters — degraded to per-instance limiting
 * rather than failing the request.
 */

import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) {
        store.delete(key);
      }
    }
    // Stop cleanup timer when store is empty
    if (store.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't prevent Node.js from exiting
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export interface RateLimitConfig {
  /** Unique identifier for this limiter (e.g. "login", "register") */
  id: string;
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

/**
 * Per-process fallback limiter (the pre-#1039 behaviour). Exported for tests;
 * production traffic goes through `checkRateLimit`, which only lands here
 * when the shared Postgres counter is unavailable.
 */
export function checkRateLimitInMemory(
  config: RateLimitConfig,
  key: string
): RateLimitResult {
  ensureCleanup();

  const storeKey = `${config.id}:${key}`;
  const now = Date.now();
  const entry = store.get(storeKey);

  // No existing entry or window expired - create new
  if (!entry || entry.resetAt <= now) {
    const resetAt = now + config.windowSeconds * 1000;
    store.set(storeKey, { count: 1, resetAt });
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit - 1,
      resetAt,
    };
  }

  // Within window - increment
  entry.count++;

  if (entry.count > config.limit) {
    return {
      success: false,
      limit: config.limit,
      remaining: 0,
      resetAt: entry.resetAt,
    };
  }

  return {
    success: true,
    limit: config.limit,
    remaining: config.limit - entry.count,
    resetAt: entry.resetAt,
  };
}

let lastRateLimitDbErrorLogAt = 0;
const RATE_LIMIT_DB_ERROR_LOG_INTERVAL_MS = 60 * 1000;

/**
 * Check the shared rate limit for a given key (typically IP address). One
 * atomic upsert: expired windows restart, live windows increment. Falls back
 * to the per-process in-memory limiter when the database is unavailable.
 */
export async function checkRateLimit(
  config: RateLimitConfig,
  key: string
): Promise<RateLimitResult> {
  const storeKey = `${config.id}:${key}`;
  const now = new Date();
  const newResetAt = new Date(now.getTime() + config.windowSeconds * 1000);

  try {
    const rows = await prisma.$queryRaw<
      Array<{ count: number; resetAt: Date }>
    >`
      INSERT INTO "RateLimitCounter" ("id", "count", "resetAt")
      VALUES (${storeKey}, 1, ${newResetAt})
      ON CONFLICT ("id") DO UPDATE SET
        "count" = CASE
          WHEN "RateLimitCounter"."resetAt" <= ${now} THEN 1
          ELSE "RateLimitCounter"."count" + 1
        END,
        "resetAt" = CASE
          WHEN "RateLimitCounter"."resetAt" <= ${now} THEN ${newResetAt}
          ELSE "RateLimitCounter"."resetAt"
        END
      RETURNING "count", "resetAt"
    `;

    const row = rows[0];
    if (!row) {
      throw new Error("Rate limit upsert returned no row");
    }
    const count = Number(row.count);
    const resetAt = row.resetAt.getTime();
    scheduleSharedCleanup();

    if (count > config.limit) {
      return { success: false, limit: config.limit, remaining: 0, resetAt };
    }
    return {
      success: true,
      limit: config.limit,
      remaining: config.limit - count,
      resetAt,
    };
  } catch (err) {
    if (
      Date.now() - lastRateLimitDbErrorLogAt >
      RATE_LIMIT_DB_ERROR_LOG_INTERVAL_MS
    ) {
      lastRateLimitDbErrorLogAt = Date.now();
      logger.error(
        { err, limiterId: config.id },
        "Shared rate-limit store unavailable; falling back to per-process limiting"
      );
    }
    return checkRateLimitInMemory(config, key);
  }
}

// Delete expired shared counters occasionally so the table stays small. The
// timer mirrors the in-memory cleanup and never blocks a request.
let sharedCleanupTimer: ReturnType<typeof setInterval> | null = null;

function scheduleSharedCleanup() {
  if (sharedCleanupTimer) return;
  sharedCleanupTimer = setInterval(() => {
    prisma
      .$executeRaw`DELETE FROM "RateLimitCounter" WHERE "resetAt" <= ${new Date()}`.catch(
      () => {
        // Cleanup is best-effort; expired rows are also overwritten in place.
      }
    );
  }, CLEANUP_INTERVAL_MS);
  if (
    sharedCleanupTimer &&
    typeof sharedCleanupTimer === "object" &&
    "unref" in sharedCleanupTimer
  ) {
    sharedCleanupTimer.unref();
  }
}

/**
 * Get the client IP from a request, considering common proxy headers.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Use the LAST IP in the chain — Caddy (our reverse proxy) appends the real client IP,
    // so the first value is attacker-controllable but the last one is trustworthy.
    const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
    return parts[parts.length - 1] || "unknown";
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp;
  }
  return "unknown";
}

/**
 * Apply rate limiting to a request. Returns a Response if rate limited, null if allowed.
 */
export async function applyRateLimit(
  config: RateLimitConfig,
  request: Request
): Promise<Response | null> {
  const ip = getClientIp(request);
  const result = await checkRateLimit(config, ip);

  if (!result.success) {
    const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
    return new Response(
      JSON.stringify({
        error: "Too many requests. Please try again later.",
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(result.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(result.resetAt),
        },
      }
    );
  }

  return null;
}

// Pre-configured rate limiters for common routes
export const rateLimiters = {
  /** Login: 10 attempts per 15 minutes */
  login: { id: "login", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Register: 5 attempts per hour */
  register: { id: "register", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Membership application: 3 submissions per hour */
  membershipApplication: { id: "membership-application", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Password reset request: 5 per hour */
  forgotPassword: { id: "forgot-password", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Password reset submission: 10 per hour */
  resetPassword: { id: "reset-password", limit: 10, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** General API: 100 per minute */
  api: { id: "api", limit: 100, windowSeconds: 60 } as RateLimitConfig,
  /** Booking creation: 20 per hour */
  bookingCreate: { id: "booking-create", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Booking quote / availability / promo validate: 60 per minute */
  bookingQuery: { id: "booking-query", limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Public address autocomplete proxy: 90 requests per minute */
  addressAutocomplete: { id: "address-autocomplete", limit: 90, windowSeconds: 60 } as RateLimitConfig,
  /** Contact form: 10 per hour */
  contact: { id: "contact", limit: 10, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Lodge hut leader PIN login: 5 attempts per minute */
  lodgePinLogin: { id: "lodge-pin-login", limit: 5, windowSeconds: 60 } as RateLimitConfig,
  /** Resend verification email: 3 per hour */
  resendVerification: { id: "resend-verification", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Request email change: 3 per hour */
  requestEmailChange: { id: "request-email-change", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Token-bearing verification links: 10 hits per 15 minutes */
  verificationToken: { id: "verification-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Two-factor code verification and email-code sends: 10 attempts per 10 minutes */
  twoFactorVerify: { id: "two-factor-verify", limit: 10, windowSeconds: 10 * 60 } as RateLimitConfig,
  /** Guest chore token routes: 20 hits per 15 minutes */
  guestChoreToken: { id: "guest-chore-token", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Family group join request: 3 per hour */
  familyGroupJoinRequest: { id: "family-group-join-request", limit: 3, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Personal data export: 5 per day */
  dataExport: { id: "data-export", limit: 5, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Account deletion request: 3 per day */
  deletionRequest: { id: "deletion-request", limit: 3, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Membership cancellation request: 3 per day */
  membershipCancellationRequest: { id: "membership-cancellation-request", limit: 3, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Membership cancellation confirmation links: 10 per 15 minutes */
  membershipCancellationConfirmation: { id: "membership-cancellation-confirmation", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Booking change review requests: 5 per day */
  bookingChangeRequest: { id: "booking-change-request", limit: 5, windowSeconds: 24 * 60 * 60 } as RateLimitConfig,
  /** Public non-member booking request submission: 5 per hour */
  bookingRequest: { id: "booking-request", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public booking request verification links: 10 hits per 15 minutes */
  bookingRequestToken: { id: "booking-request-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Tokenised public payment link pages and payment intents: 20 hits per 15 minutes */
  paymentLinkToken: { id: "payment-link-token", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Organiser opens a group on their booking: 20 per hour */
  groupBookingCreate: { id: "group-booking-create", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public group-booking code lookup: 20 hits per 15 minutes (anti-enumeration) */
  groupBookingLookup: { id: "group-booking-lookup", limit: 20, windowSeconds: 15 * 60 } as RateLimitConfig,
  /** Public ski-condition widgets: 60 hits per minute, backed by server-side caching */
  skifieldConditions: { id: "skifield-conditions", limit: 60, windowSeconds: 60 } as RateLimitConfig,
  /** Member self-add to a group (a booking creation): 20 per hour */
  groupBookingJoin: { id: "group-booking-join", limit: 20, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Public non-member group join request: 5 per hour */
  groupBookingJoinRequest: { id: "group-booking-join-request", limit: 5, windowSeconds: 60 * 60 } as RateLimitConfig,
  /** Group join verification links: 10 hits per 15 minutes */
  groupBookingToken: { id: "group-booking-token", limit: 10, windowSeconds: 15 * 60 } as RateLimitConfig,
} as const;

// Export for testing
export { store as _testStore };
