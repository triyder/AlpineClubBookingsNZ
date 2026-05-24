# 48-hour change audit summary

**Window**: 2026-05-23 to 2026-05-24 NZT
**Branch reviewed**: `claude/loving-meitner-Z6S0K` (mirrors `main` at HEAD as of 2026-05-24 23:45 NZT)
**Base commit**: `eeb1a7f`
**Diff size**: 196 files, 23,466 insertions, 1,051 deletions
**Non-merge commits**: 23 across 8 new Prisma migrations
**Output**: report only - no code changes made in this run

## Findings totals

| Track | Critical | High | Medium | Low/Info | Total |
|-------|---------:|-----:|-------:|---------:|------:|
| 1 - Consistency | 0 | 1 | 4 | 4 | 9 |
| 2 - Code quality | 0 | 1 | 9 | 6 | 16 |
| 3 - Hardening | 1 | 4 | 5 | 2 | 12 |
| 4 - Security | 0 | 0 | 2 | 3 | 5 |
| 5 - Stripe / Xero | 1 | 4 | 4 | 3 | 12 |
| **Total** | **2** | **10** | **24** | **18** | **54** |

## Critical findings (require attention before private repo sync)

1. **Membership cancellation token confirm/decline is not atomic** - `src/lib/membership-cancellation-requests.ts:756-865`. Two concurrent token uses can silently overwrite each other, producing wrong audit log entries and wrong follow-up emails. Fix: `updateMany` with guards in `where`. (Track 3)
2. **Membership cancellation never triggers a Stripe refund for paid subscriptions** - `src/lib/membership-cancellation-admin.ts:601-727`. Members who paid annually and cancel mid-season see their membership cancelled but the money stays in Stripe with no credit note in Xero. Fix: either explicitly block-and-alert or wire `refundPaymentTransactions` + Xero credit allocation. (Track 5)

## High findings (10)

- 1x Consistency: Booking change request alert reuses unrelated admin preference key
- 1x Quality: `PUT /api/bookings/[id]/modify` handler is 960 lines
- 4x Hardening: serialisable isolation for member delete, idempotent archive approval, post-transaction Stripe refund silent failure, missing `BookingGuest` stay range CHECK constraint
- 4x Stripe/Xero: undocumented recovery cron scheduler dependency, orphaned `modify-dates` supplementary intents, asymmetric zero-dollar handling between `modify` and `modify-dates`, recovery refund double-count risk on partial DB failure

## What's confirmed good

- **Email template adherence**: all 5 new templates (`membership-cancellation-confirmation`, `membership-cancellation-approved`, `membership-cancellation-rejected`, `age-up-parent-email-handoff`, `admin-booking-change-request`) are correctly registered in `EMAIL_AUDIT_DEFAULTS` and reach the admin Notifications editor. No hardcoded email bodies introduced.
- **Token security**: 256-bit `randomBytes` tokens, sha256-hashed at rest, TTL enforced, single-use, member-bound, rate-limited (10 per 15min on consume).
- **Stripe webhook signature** verification path intact; new code runs only inside the post-verification branch.
- **Webhook idempotency**: `ProcessedWebhookEvent` claim uses canonical P2002 collision pattern.
- **Payment recovery idempotency keys** are deterministic and unique per logical operation.
- **Atomic claim** of payment recovery operations via `updateMany`.
- **WAITING_PAYMENT** gate on Xero supplementary invoices correctly defers Xero ledger until Stripe settles.
- **All 32 new/changed admin routes** enforce `session.user.role !== "ADMIN"` server-side, not UI-only.
- **No new `dangerouslySetInnerHTML`**, no `$executeRawUnsafe` over user input, email template renderer escapes user-controlled values.
- **CRON endpoint** uses `timingSafeEqual` on `CRON_SECRET`.

## Files in this directory

- `00-summary.md` - this file
- `01-consistency.md`
- `02-code-quality.md`
- `03-hardening.md`
- `04-security.md`
- `05-stripe-xero.md`
- `06-best-practices.md` - recommendations for ongoing process discipline

## Next steps

GitHub issues opened on `thatskiff33/AlpineClubBookingsNZ`, one per actionable finding (with related low/cosmetic findings grouped into per-track polish sweeps). Labels:

- `severity:critical` / `severity:high` / `severity:medium` / `severity:low`
- `review:consistency` / `review:code-quality` / `review:hardening` / `review:security` / `review:stripe`
- Feature commit short-SHA where applicable

After this report and issues, the user will sync changes to the private Tokoroa repo and request a similar pass there.
