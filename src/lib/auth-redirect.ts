import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

export const DEFAULT_POST_LOGIN_PATH = "/dashboard";
const DEFAULT_BOOKING_PATH = "/book";

// An auth-bounce reference is exactly 8 uppercase hex characters. This shape is
// a shared contract with the server-side diagnostics module that mints the code
// and records the bounce keyed by it — keep the pattern and the `ref` query-param
// name in sync with that module.
export const AUTH_BOUNCE_REF_PATTERN = /^[0-9A-F]{8}$/;

export function isValidAuthBounceRef(value?: string | null): value is string {
  return typeof value === "string" && AUTH_BOUNCE_REF_PATTERN.test(value);
}

/**
 * The genuinely explicit post-login destination a caller supplied, or null.
 *
 * "Explicit" means a user- or deep-link-supplied `callbackUrl` that survives
 * the same open-redirect sanitisation as {@link resolvePostLoginPath} and is
 * not the login page itself. Returns null (rather than the default) when the
 * candidate is absent, unsafe, external, or points back at /login, so callers
 * can distinguish "the user asked for a specific page" from "fall back to the
 * default / preference". This distinction is load-bearing for the post-login
 * landing preference (#2090): a flow-materialised default (e.g. the 2FA detour
 * writing the resolved landing into callbackUrl) must never be re-read here as
 * an explicit choice, or it would permanently defeat the admin default.
 */
export function getExplicitCallbackUrl(candidate?: string | null): string | null {
  const safeCandidate = getSafeInternalReturnPath(candidate);
  if (!safeCandidate) {
    return null;
  }
  if (safeCandidate === "/login" || safeCandidate.startsWith("/login?")) {
    return null;
  }
  return safeCandidate;
}

export function resolvePostLoginPath(
  candidate?: string | null,
  fallback: string = DEFAULT_POST_LOGIN_PATH
) {
  const safeFallback = getSafeInternalReturnPath(fallback) ?? DEFAULT_POST_LOGIN_PATH;
  return getExplicitCallbackUrl(candidate) ?? safeFallback;
}

export function buildLoginPath(
  callbackPath?: string | null,
  authBounceRef?: string | null
) {
  const params = new URLSearchParams({
    callbackUrl: resolvePostLoginPath(callbackPath),
  });

  // Appended after callbackUrl so the query string stays byte-identical to the
  // no-ref case whenever the ref is absent or malformed.
  if (isValidAuthBounceRef(authBounceRef)) {
    params.set("ref", authBounceRef);
  }

  return `/login?${params.toString()}`;
}

export function buildBookingLoginPath() {
  return buildLoginPath(DEFAULT_BOOKING_PATH);
}
