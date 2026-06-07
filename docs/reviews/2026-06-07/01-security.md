# Security and API Boundaries

**Primary child issue**: #675
**Remediation PR**: #689
**Status**: Closed

## Result

No unresolved critical or high security findings remain from the #675 review range.

The security review found one medium-class API-boundary issue: several changed route handlers called `request.json()` directly. Malformed JSON could therefore escape as framework/default failure behavior instead of returning a controlled `400` response with a stable error envelope.

## Fixes Merged

PR #689 added `parseJsonRequestBody()` and applied it to changed booking, payment, promo-code, and bed-allocation API routes. The fixed behavior is:

- Malformed JSON returns `400`.
- The response shape is stable: `error: "Invalid JSON"` with body-level details.
- Existing auth, active-session, ownership, admin, and feature-gate checks remain in place.

## Confirmed Boundaries

The review confirmed:

- Admin bed allocation routes still require server-side admin authorization.
- Booking/payment mutation routes still check active sessions and ownership/admin role before mutation.
- Stripe webhook processing still verifies the signature before event handling.
- Xero webhook processing still verifies raw-body HMAC before parsing/recording.
- Raw SQL in the reviewed range is static or parameterized through Prisma SQL helpers.
- Xero OAuth token storage remains encrypted and logging still uses redaction helpers.

## Validation Evidence

PR #689 validation included:

- Targeted malformed JSON and API boundary tests.
- `npm run lint`.
- `npx tsc --noEmit`.
- `npx prisma validate` with a local dummy database URL.
- `git diff --check`.

PR #691 and the final baseline later re-ran the broader local validation stack and GitHub Actions checks.

## Security Conclusion

The hardening pass did not identify any remaining critical or high API-boundary issue in the changed range. The main residual security dependency is procedural: keep the same shared JSON parser pattern for future API routes that read request bodies.

