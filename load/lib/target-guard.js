/**
 * Pre-flight target-safety guard for the k6 load harness (issue #1884).
 *
 * Load tests generate real bookings, real logins, and real database writes on
 * whatever they are pointed at. This guard makes it structurally hard to point
 * the harness at anything other than a throwaway local stack:
 *
 *   1. `BASE_URL` must be set explicitly — there is no default target.
 *   2. `LOAD_TEST_CONFIRM_TARGET=1` must be set as a deliberate opt-in.
 *   3. The URL must not contain `:5432` anywhere. On club deployment hosts
 *      (and on at least one developer machine) port 5432 is the LIVE
 *      PRODUCTION Postgres. The harness only ever speaks HTTP to the app,
 *      never to a database.
 *   4. The hostname must not be a known production domain (tokoroa.org.nz or
 *      any subdomain), must not contain "prod", and must be on the local
 *      allowlist: localhost / 127.0.0.1 / ::1 / host.docker.internal or a
 *      `.test` / `.localhost` name.
 *
 * Every scenario script calls `assertSafeTarget(__ENV)` in k6's init context,
 * so a violation aborts the run before a single VU starts, and again in
 * `setup()` as a belt-and-braces re-check.
 *
 * This module deliberately avoids k6-specific imports so `node --check`
 * (and unit tooling) can parse it. It also avoids the WHATWG `URL` class,
 * which k6's runtime does not provide globally.
 */

// Hostnames that may be load tested (throwaway local stacks only).
const ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
];

// Suffix allowlist: reserved non-routable TLDs used by local stacks
// (e.g. demo.alpineclub.test).
const ALLOWED_HOST_SUFFIXES = [".localhost", ".test"];

// Known real deployment domains. The apex and every subdomain are refused
// (Caddy serves the app on the apex plus www./bookings./dashboard.).
const DENIED_HOST_SUFFIXES = ["tokoroa.org.nz"];

// Defence in depth: refuse anything that self-identifies as production.
const DENIED_HOST_SUBSTRINGS = ["prod"];

function guardError(reason) {
  return new Error(
    "LOAD TEST TARGET REFUSED: " +
      reason +
      "\n\nThis harness may only run against a throwaway local stack " +
      "(see docs/LOAD_TESTING.md). Required environment:\n" +
      "  BASE_URL=http://localhost:3001        # staging compose stack\n" +
      "  LOAD_TEST_CONFIRM_TARGET=1            # explicit opt-in\n" +
      "Never point it at a live deployment, and never at port 5432 " +
      "(live production Postgres)."
  );
}

/**
 * Validate the target described by an env object (pass k6's `__ENV`).
 * Returns the normalised base URL (no trailing slash) or throws.
 */
export function assertSafeTarget(env) {
  const raw = (env && env.BASE_URL ? String(env.BASE_URL) : "").trim();
  if (!raw) {
    throw guardError("BASE_URL is not set. There is no default target.");
  }

  // Check the raw string first so a database URL pasted by mistake is
  // refused even if it would not parse as http.
  if (raw.indexOf(":5432") !== -1) {
    throw guardError(
      "BASE_URL contains :5432 — that is the live production Postgres " +
        "port. The harness talks HTTP to the app only, never to a database."
    );
  }

  if (!env || String(env.LOAD_TEST_CONFIRM_TARGET) !== "1") {
    throw guardError(
      "LOAD_TEST_CONFIRM_TARGET=1 is not set. Set it only after confirming " +
        "BASE_URL points at a throwaway local stack."
    );
  }

  // Minimal http(s) URL parse without WHATWG URL (absent in k6's runtime).
  // Captures: scheme, host (bracketed IPv6 or reg-name), optional port.
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?(?:[/?#]|$)/i.exec(
    raw
  );
  if (!match) {
    throw guardError(
      'BASE_URL "' + raw + '" is not a plain http(s) URL the guard can parse.'
    );
  }

  const host = match[2].toLowerCase();
  const port = match[3] || "";
  const bareHost =
    host.charAt(0) === "[" ? host.slice(1, host.length - 1) : host;

  if (port === "5432") {
    throw guardError("BASE_URL targets port 5432 (live production Postgres).");
  }

  for (const suffix of DENIED_HOST_SUFFIXES) {
    if (bareHost === suffix || bareHost.endsWith("." + suffix)) {
      throw guardError(
        'hostname "' + bareHost + '" is a known production domain (' + suffix + ")."
      );
    }
  }

  for (const fragment of DENIED_HOST_SUBSTRINGS) {
    if (bareHost.indexOf(fragment) !== -1) {
      throw guardError(
        'hostname "' + bareHost + '" contains "' + fragment + '" — refusing anything that looks like production.'
      );
    }
  }

  const allowedExact =
    ALLOWED_HOSTS.indexOf(host) !== -1 || ALLOWED_HOSTS.indexOf(bareHost) !== -1;
  const allowedSuffix = ALLOWED_HOST_SUFFIXES.some(function (suffix) {
    return bareHost.endsWith(suffix);
  });
  if (!allowedExact && !allowedSuffix) {
    throw guardError(
      'hostname "' +
        bareHost +
        '" is not on the local allowlist (' +
        ALLOWED_HOSTS.join(", ") +
        ", *" +
        ALLOWED_HOST_SUFFIXES.join(", *") +
        ")."
    );
  }

  return raw.replace(/\/+$/, "");
}
