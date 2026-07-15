export const CSP_HEADER = "Content-Security-Policy";
// test seam
export const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_NONCE_HEADER = "x-nonce";

// test seam
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
} as const;

export function createCspNonce() {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

export interface CspOptions {
  /** The request pathname — a couple of routes carry a scoped relaxation. */
  pathname?: string;
  /**
   * The request's own origin (scheme://host[:port]). The sandboxed template
   * preview (LTV-036) frames /display with an OPAQUE origin, where `connect-src
   * 'self'` matches nothing; adding the concrete origin lets the framed document
   * still reach /api/display/state.
   */
  selfOrigin?: string;
}

export function setSecurityHeaders(headers: Headers, pathname?: string) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  // /display may be embedded in the same-origin sandboxed template preview
  // (LTV-036, ADR-003 §5). SAMEORIGIN keeps third-party clickjacking blocked
  // while letting our own admin preview host frame it; every other route keeps
  // the global DENY.
  if (pathname === "/display") {
    headers.set("X-Frame-Options", "SAMEORIGIN");
  }
}

export function buildContentSecurityPolicy(nonce: string, options: CspOptions = {}) {
  const isDev = process.env.NODE_ENV === "development";
  const { pathname, selfOrigin } = options;

  // Two scoped relaxations for the sandboxed template preview (LTV-036):
  //  • /display: frame-ancestors 'self' so our own admin preview page can frame
  //    it (every other route stays 'none'), and connect-src gains this site's
  //    explicit origin so the opaque-origin framed document can still fetch the
  //    state API.
  //  • /admin/display/preview: frame-src 'self' so it may embed the /display
  //    iframe.
  // A third, TIGHTER relaxation applies to both (issue #161, ADR-003 residual):
  // admin-authored display HTML/CSS can embed an <img>, and the global img-src
  // otherwise allows any https host — an authoring admin could exfiltrate the
  // display's own token values (config, occupancy, …) via an image-beacon `src`.
  // /display and /admin/display/preview drop the `https:` wildcard, leaving only
  // `'self' data:`; every other route's img-src is unchanged.
  const isDisplay = pathname === "/display";
  const isPreviewHost = pathname === "/admin/display/preview";
  const imgSrc =
    isDisplay || isPreviewHost
      ? "img-src 'self' data:"
      : "img-src 'self' data: https: https://www.google-analytics.com https://*.google-analytics.com";

  const directives = [
    "default-src 'self'",
    [
      "script-src",
      "'self'",
      `'nonce-${nonce}'`,
      ...(isDev ? ["'unsafe-eval'"] : []),
      "https://js.stripe.com",
      "https://www.googletagmanager.com",
    ].join(" "),
    // Keep inline styles during the script nonce rollout; Tailwind/Radix and
    // selected editor-rendered content can still emit runtime style attributes.
    "style-src 'self' 'unsafe-inline'",
    imgSrc,
    "font-src 'self' data:",
    [
      "connect-src",
      "'self'",
      ...(isDisplay && selfOrigin ? [selfOrigin] : []),
      "https://api.stripe.com",
      "https://js.stripe.com",
      "https://*.ingest.sentry.io",
      "https://www.google-analytics.com",
      "https://*.google-analytics.com",
    ].join(" "),
    [
      "frame-src",
      ...(isPreviewHost ? ["'self'"] : []),
      "https://js.stripe.com",
      "https://hooks.stripe.com",
    ].join(" "),
    "worker-src 'self' blob:",
    "object-src 'none'",
    isDisplay ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];

  return directives.join("; ");
}
