import * as Sentry from "@sentry/nextjs";
import baseLogger from "@/lib/logger";

/**
 * Scoped pino -> Sentry bridge for cron and webhook FAILURE paths only
 * (#1214, audit gap G5 — PARTIALLY closed by design).
 *
 * `src/lib/logger.ts` is a single default pino singleton with no global Sentry
 * transport, on purpose: a global bridge would fire on every request logger and
 * reproduce the alert-fatigue trap #1150 rejected. Instead cron and webhook
 * modules import these helpers at their genuine-failure catch handlers, which
 * log via the pino singleton AND forward to Sentry. Ordinary route/request
 * loggers never import this module, so the bridge is provably scoped: the only
 * way a logger-driven event reaches Sentry is through a caller of this module.
 *
 * Dedup: an in-process cooldown map keyed by the stable fingerprint suppresses
 * repeat sends within `OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS` (default 5 min),
 * so a stuck cron/webhook does not emit one Sentry event per tick. A stable
 * Sentry `fingerprint` (scope + caller-supplied tag, never the raw message)
 * dedups grouping across processes. Cross-instance exact-once alerting is out of
 * scope here — that is #1211's shared-state work.
 */

type ObservabilityScope = "cron" | "webhook";
type ObservabilityLevel = "error" | "fatal";

interface ReportScopedErrorInput {
  /** Genuine-failure scope. Only cron + webhook modules call this. */
  scope: ObservabilityScope;
  /**
   * Stable operation key (job/module/event-type name) used for the Sentry
   * fingerprint and the in-process cooldown key. MUST NOT embed varying ids
   * (booking ids, event ids) or the raw error message.
   */
  tag: string;
  /** Human-readable log line + captureMessage fallback text. */
  message: string;
  /** Caught error, when present; drives captureException vs captureMessage. */
  err?: unknown;
  /** Log/Sentry severity. Defaults to "error". */
  level?: ObservabilityLevel;
  /** Extra structured fields for the log line and Sentry `extra`. */
  context?: Record<string, unknown>;
}

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function resolveCooldownMs(): number {
  const raw = process.env.OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS;
  if (!raw) {
    return DEFAULT_COOLDOWN_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

// In-process cooldown: last epoch-ms a given fingerprint was forwarded to
// Sentry. Single-process only (see #1211 for cross-instance dedup).
const lastSentByFingerprint = new Map<string, number>();

function shouldSendToSentry(fingerprintKey: string, nowMs: number): boolean {
  const cooldownMs = resolveCooldownMs();
  const lastSent = lastSentByFingerprint.get(fingerprintKey);
  if (lastSent !== undefined && nowMs - lastSent < cooldownMs) {
    return false;
  }
  lastSentByFingerprint.set(fingerprintKey, nowMs);
  return true;
}

/** Reset the in-process cooldown map. Test-only. */
export function resetObservabilityBridgeForTests(): void {
  lastSentByFingerprint.clear();
}

function reportScopedError({
  scope,
  tag,
  message,
  err,
  level = "error",
  context,
}: ReportScopedErrorInput): void {
  // 1) Always log through the pino singleton at error/fatal with a { scope } binding.
  const logPayload: Record<string, unknown> = { scope, ...(context ?? {}) };
  if (err !== undefined) {
    logPayload.err = err;
  }
  baseLogger[level](logPayload, message);

  // 2) Forward to Sentry, deduped by the in-process cooldown + stable fingerprint.
  const fingerprintKey = `${scope}:${tag}`;
  if (!shouldSendToSentry(fingerprintKey, Date.now())) {
    return;
  }

  const fingerprint = [scope, tag];
  const tags = { scope, operation: tag };
  if (err instanceof Error) {
    Sentry.captureException(err, { level, fingerprint, tags, extra: context });
  } else {
    Sentry.captureMessage(message, {
      level,
      fingerprint,
      tags,
      extra: { ...(context ?? {}), ...(err !== undefined ? { err } : {}) },
    });
  }
}

/** Bridge a genuine cron FAILURE log to Sentry (scoped, deduped). */
export function reportCronError(
  input: Omit<ReportScopedErrorInput, "scope">
): void {
  reportScopedError({ ...input, scope: "cron" });
}

/** Bridge a genuine webhook FAILURE log to Sentry (scoped, deduped). */
export function reportWebhookError(
  input: Omit<ReportScopedErrorInput, "scope">
): void {
  reportScopedError({ ...input, scope: "webhook" });
}
