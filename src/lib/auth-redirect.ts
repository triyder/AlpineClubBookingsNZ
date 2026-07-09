import { getSafeInternalReturnPath } from "@/lib/internal-return-path";

const DEFAULT_POST_LOGIN_PATH = "/dashboard";
const DEFAULT_BOOKING_PATH = "/book";

// An auth-bounce reference is exactly 8 uppercase hex characters. This shape is
// a shared contract with the server-side diagnostics module that mints the code
// and records the bounce keyed by it — keep the pattern and the `ref` query-param
// name in sync with that module.
export const AUTH_BOUNCE_REF_PATTERN = /^[0-9A-F]{8}$/;

export function isValidAuthBounceRef(value?: string | null): value is string {
  return typeof value === "string" && AUTH_BOUNCE_REF_PATTERN.test(value);
}

export function resolvePostLoginPath(
  candidate?: string | null,
  fallback: string = DEFAULT_POST_LOGIN_PATH
) {
  const safeFallback = getSafeInternalReturnPath(fallback) ?? DEFAULT_POST_LOGIN_PATH;
  const safeCandidate = getSafeInternalReturnPath(candidate);

  if (!safeCandidate) {
    return safeFallback;
  }

  if (safeCandidate === "/login" || safeCandidate.startsWith("/login?")) {
    return safeFallback;
  }

  return safeCandidate;
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
