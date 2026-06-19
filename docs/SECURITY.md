# Security Notes

This document captures security decisions and trade-offs that are too
implementation-specific for `SECURITY.md` at the repository root. The
root `SECURITY.md` covers the public reporting policy; this file
captures internal mitigations and operator-facing rationale.

## Token-bearing URL paths

### Context

Some emailed confirmation and payment links carry 256-bit tokens in URL paths:

```
https://<host>/membership-cancellation/<token>
https://<host>/chores/<token>
https://<host>/nominations/<token>
https://<host>/pay/<token>
https://<host>/booking-requests/verify/<token>
```

URL paths are routinely captured by:

- Next.js / Node access logs
- Reverse-proxy logs (Caddy, in our deployment topology)
- Sentry and any other observability tooling that captures request
  metadata
- Browser history
- The `Referer` header of any outbound link click from the confirmation
  page

### Residual risk

Some token routes are also session-bound; others are intentionally public
opaque-token flows. A stolen public payment, chore, nomination, or booking
request verification token can act as the bearer credential for that specific
workflow until it is used, revoked, or expires.

### Mitigation

The shared text redaction layer (`src/lib/redact-sensitive-json.ts`)
strips the token segment from any supported token-bearing path before the
value is emitted by the Pino logger or attached to an `err` payload. This
covers structured request logs, captured error stacks, URL-encoded login
callback paths, and any other observability surface that flows through
`redactSensitiveText`.

The token remains in clear text in the email body sent to the participant or
requester, which is the only place they need it.

### Operator checklist

When reviewing observability dashboards or proxy access logs that are
exported outside of the application process, confirm that the source
also redacts these token-bearing path segments. The application-level
redaction does not protect logs that the application does not emit.
