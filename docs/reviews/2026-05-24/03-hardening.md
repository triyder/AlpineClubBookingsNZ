# Track 3 - Hardening / robustness

## Summary
- Files reviewed: 49 changed routes/lib files plus 8 new migrations
- Findings: 1 critical, 4 high, 5 medium, 2 low

## Findings

### [CRITICAL] Cancellation token confirm/decline is not atomic
- **Location**: `src/lib/membership-cancellation-requests.ts:756-865`
- **Risk**: `respondToMembershipCancellationConfirmation` does a separate `findUnique` (line 757), runs four status checks in JavaScript, then calls `update` by `id` (line 813). Two concurrent POSTs with the same token both pass `findUnique` before either runs `update`. The second write silently overwrites the first (e.g. a `decline` would clobber a just-recorded `confirm`, or vice versa), producing a wrong audit log entry and the wrong response email later in the lifecycle.
- **Repro / trigger**: Member opens the confirmation link in two tabs and double-clicks confirm/decline buttons; or the link is loaded by a preview crawler at the same time the member clicks.
- **Suggested fix**: Convert the read+write into a single `updateMany` with the status/expiry guards in the `where` clause (token hash + `status: PENDING_CONFIRMATION` + `confirmationTokenExpiresAt > now`), check `count === 1`, then load the updated row. Wrap the update + audit log in `prisma.$transaction`.
- **Commit**: 8c0a9ec / 22bad90
- **Acceptance**: Add a concurrent test (two `respondToMembershipCancellationConfirmation` calls with the same token in `Promise.all`) and assert exactly one succeeds while the other returns a 409.

### [HIGH] Delete eligibility re-checked then mutated without serializable isolation
- **Location**: `src/lib/member-lifecycle-actions.ts:769-808`
- **Risk**: On approve, the transaction recounts blockers and then deletes the member, but the surrounding `$transaction` uses the default READ COMMITTED isolation level. Between the eligibility re-check and the `member.delete`, a separate request could create a booking, guest appearance, family request, or refund tied to the member; that row would either fail with FK RESTRICT (transaction rollback, user sees an opaque error) or be orphaned if a SET NULL FK exists.
- **Repro / trigger**: Admin approves a delete request at the same moment another admin (or background cron) creates a booking referencing the member.
- **Suggested fix**: Set `isolationLevel: 'Serializable'` on the transaction, or take a row lock with `SELECT … FOR UPDATE` on the Member row early in the transaction, or use the `pg_advisory_xact_lock` pattern already used in `bookings/[id]/modify/route.ts:143`.
- **Commit**: e3ca9c5
- **Acceptance**: Concurrency test that creates a booking after the eligibility count fires but before delete commits should either block (preferred) or roll back cleanly with a 409, not produce an FK error 500.

### [HIGH] Archive approval not idempotent under retry
- **Location**: `src/lib/member-lifecycle-actions.ts:906-969`
- **Risk**: The archive approve transaction re-loads the member, asserts not already archived, then writes `archivedAt`. If two admins approve a duplicate archive request (e.g. one created via the foundation migration plus a stale tab) in parallel, both pass `assertArchiveEligible` because READ COMMITTED won't serialise them. The second write overwrites `archivedAt`/`archivedReason`/`archivedViaLifecycleActionRequestId`. Audit log shows two "archive_approved" events for the same member, both successful.
- **Repro / trigger**: Two admins click "Approve" on overlapping requests within a few hundred ms.
- **Suggested fix**: Use `updateMany` with `where: { id, archivedAt: null }` as the claim step and verify `count === 1`. Bonus: add a unique partial index `WHERE archivedAt IS NULL` on a derived column to enforce single-archive-active at the DB level, or simply rely on the `updateMany` guard.
- **Commit**: 0988acb
- **Acceptance**: Parallel approval test produces exactly one APPROVED archive request and one rejection with 409.

### [HIGH] Booking modify post-transaction Stripe refund failure leaves silent gap
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:892-908`
- **Risk**: After the DB transaction commits the new totals and refund amount, the actual Stripe refund call is fire-and-forget with only `logger.error`. If Stripe is down or returns 4xx, the booking is reflected at the new (lower) price but the customer never receives the refund and no admin alert is raised. The comment ("requires manual reconciliation") confirms this is the intent but there is no escalation path.
- **Repro / trigger**: Stripe API outage during a member's booking edit that triggers a refund.
- **Suggested fix**: Enqueue refund-on-failure into `PaymentRecoveryOperation` (you already have an idempotent recovery queue for cancellations - extend it to cover this refund case), or call `sendAdminPaymentFailureAlert` here so unrecovered refunds raise.
- **Commit**: 92d1125
- **Acceptance**: Inject a Stripe failure in a refund-triggering modification; verify an admin alert email is queued or a `PaymentRecoveryOperation` row appears.

### [HIGH] BookingGuest stay range FK lacks ON DELETE behaviour audit
- **Location**: `prisma/migrations/20260524090000_add_booking_guest_stay_ranges/migration.sql`
- **Risk**: The new `stayStart`/`stayEnd` columns are `NOT NULL` and backfilled from the parent booking, which is correct. However, there is no DB-level invariant that `stayStart >= booking.checkIn` and `stayEnd <= booking.checkOut`. The capacity logic and in-progress edit plan in `booking-edit-guest-ranges.ts:121-128` rely on this invariant. A bug elsewhere (or a future migration) could produce a row that quietly breaks capacity reporting in `countActiveGuestsForNight`.
- **Repro / trigger**: An admin direct DB edit, or a future migration that shifts booking dates without touching guest dates.
- **Suggested fix**: Add a CHECK constraint `CHECK (stayStart < stayEnd)` at minimum; ideally a trigger or application invariant ensuring guest range lies within booking range. The current code only asserts `stayEnd > stayStart` indirectly through pricing logic.
- **Commit**: 47ceaed
- **Acceptance**: `INSERT INTO BookingGuest (stayStart='...', stayEnd='...same value...')` should fail at the DB layer.

### [MEDIUM] modify and modify-dates JSON parse outside try block
- **Location**: `src/app/api/bookings/[id]/modify/route.ts:120`, `src/app/api/bookings/[id]/modify-dates/route.ts:64`
- **Risk**: `await request.json()` is called outside the outer `try` block. A malformed JSON body throws a `SyntaxError` that escapes to Next.js's default error handler, returning an opaque 500. Other routes (`confirm/route.ts:63`, `confirm-modification-payment/route.ts:38`) handle this correctly with try/catch around `parse`. Not data-loss but user-facing degradation.
- **Repro / trigger**: Client sends `Content-Type: application/json` with body `{not json`.
- **Suggested fix**: Wrap the `await request.json()` in a try/catch returning 400, or move it inside the existing outer try block and re-throw as ApiError.
- **Commit**: 7932719, 92d1125
- **Acceptance**: curl a malformed JSON body and get 400 with a parseable error, not 500.

### [MEDIUM] Booking change request review does not validate the requested change is still actionable
- **Location**: `src/app/api/admin/booking-change-requests/[id]/route.ts:107-122`
- **Risk**: PATCH only updates the change-request row's status. It never re-applies the change to the booking, nor does it check whether the requested dates/guests are still feasible (capacity, lifecycle status). An admin "Resolve" is purely an attestation. If the workflow assumes the admin will manually edit the booking via the `modify` endpoint afterwards, a discrepancy between "resolved" status and actual booking state can persist. This is by design but the API offers no link between resolve and the modification it triggered.
- **Repro / trigger**: Admin marks request resolved but forgets to apply the change; member sees "approved" but booking unchanged.
- **Suggested fix**: Either require the admin to attach a `bookingModificationId` to the resolution, or rename the action to "Acknowledge" and add explicit messaging that the booking edit is still pending. Track a `linkedModificationId` field on the change request.
- **Commit**: 6d9ba04
- **Acceptance**: Schema test confirms RESOLVED status carries an explicit pointer to the executed edit, or UI/email copy clarifies the manual follow-up.

### [MEDIUM] Payment recovery cron task validation gives up on unknown tasks rather than supporting future tasks
- **Location**: `src/app/api/cron/payments/route.ts:60-66`
- **Risk**: `task` is sourced from the query string and validated against a hardcoded set of one entry. Not a hardening bug per se, but the cron path lacks zod validation and the route accepts any number of repeated `task` query params silently (only the first is read).
- **Repro / trigger**: Cron config drift sends `?task=recovery&task=foo`; behaviour is "first wins" and unsurprising but undocumented.
- **Suggested fix**: zod-parse `searchParams` like `admin/booking-change-requests/route.ts:21` does. Cheap and consistent.
- **Commit**: not in this window (predates)
- **Acceptance**: Invalid extra params produce 400 with details.

### [MEDIUM] Membership cancellation candidate eligibility check uses stale snapshot
- **Location**: `src/lib/membership-cancellation-requests.ts:484-551`
- **Risk**: `createMembershipCancellationRequest` calls `loadCancellationCandidates` (line 485) outside the create transaction, then creates participants. Between candidate load and create, a family group join could complete, a participant could be archived, or another cancellation request could be filed. The participant creation has a unique constraint `(requestId, memberId)` but no cross-request guard - two concurrent cancellation requests can both list the same member.
- **Repro / trigger**: Two family adults submit cancellation requests for the same dependent within seconds.
- **Suggested fix**: After load, re-check `OPEN_PARTICIPANT_STATUSES` for each selected memberId within the create transaction. Either fail with 409 or merge into the existing request.
- **Commit**: 22bad90
- **Acceptance**: Concurrent test produces exactly one cancellation request per member with no duplicate participants.

### [MEDIUM] cleanupArchivedMemberLinks not safe for re-run
- **Location**: `src/lib/member-lifecycle-actions.ts:546-565`
- **Risk**: The cleanup runs unconditional `updateMany`/`deleteMany`. If invoked twice (retry, replay), the second invocation will succeed silently with `count: 0`. That's actually fine here but worth noting: the function does not return what it cleaned, so the audit log shows "archive_approved" but no record of how many child links were nulled. If the count is wanted for forensics later, capture it.
- **Repro / trigger**: Diagnosing why a member's children lost parent links.
- **Suggested fix**: Return counts and stash them in the audit log metadata.
- **Commit**: 0988acb
- **Acceptance**: Audit log includes `cleanedFamilyGroupMembers`, `nulledChildren`, `nulledInheritance` counts.

### [LOW] Booking change request rejection still leaves token-style locked-period checks running on default new Date()
- **Location**: `src/app/api/bookings/[id]/change-requests/route.ts:74`
- **Risk**: `requestedEffectiveDate <= today` uses `editPolicy.today` which itself uses `getTodayDateOnly()`. That helper does honour NZ timezone. So no actual bug, but the file uses `parseDateOnly` (UTC) for the requested values while the boundary uses NZ-normalised today. The comparison happens to work because both are date-only midnight-UTC. Note to future maintainers: this is fragile. A change to `parseDateOnly` semantics will silently break this comparison.
- **Suggested fix**: Add a code comment, or normalise both sides through `normalizeDateOnlyForTimeZone` explicitly.
- **Commit**: 6d9ba04
- **Acceptance**: Comment in code or explicit normalisation.

### [LOW] Confirmation email send loop ignores partial failure ordering
- **Location**: `src/lib/membership-cancellation-requests.ts:574-599`
- **Risk**: `Promise.all` over participant emails: if email N fails after email M succeeded, the request is created and some emails sent. The `emailWarnings` array is returned but there's no retry or re-send path. A participant who never received their token has no way to recover other than admin intervention.
- **Suggested fix**: Add an admin endpoint to re-issue confirmation tokens for a participant in PENDING_CONFIRMATION, or queue the email send via the existing email retry cron.
- **Commit**: 22bad90 / 8c0a9ec
- **Acceptance**: Failure injection test confirms warnings, and admin can re-issue a token.

## Migrations review

- `20260523100000_add_email_message_settings` — Adds `EmailMessageSetting`, `EmailTemplateOverride`, `NotificationDeliveryPolicy`. UNIQUE on `templateName` matches code's expectation of one row per template. Default ID `'default'` for `EmailMessageSetting` matches singleton pattern. Indices look reasonable. OK.

- `20260523113000_add_payment_recovery_operations` — UNIQUE on `idempotencyKey` is critical and correctly enforced. Compound index `(status, nextRetryAt, createdAt)` matches the queue's findMany sort. FK to Booking/Payment is RESTRICT, blocking accidental delete. Backfill insert is well-guarded with `ON CONFLICT DO NOTHING`. `paymentTransactionId` nullable is intentional and correct. Good.

- `20260524090000_add_booking_guest_stay_ranges` — `NOT NULL` enforced after backfill - correct. Missing CHECK constraint that range is within parent booking range (see High finding above). Otherwise OK.

- `20260524100000_membership_cancellation_foundation` — UNIQUE on `(requestId, memberId)` prevents same participant on the same request twice (good). FK on participants to Member is RESTRICT (good - prevents losing audit trail). FK on `requestedByMemberId` is SET NULL (good - preserves request history if admin departs). `MembershipCancellationSetting` singleton ID matches pattern. OK.

- `20260524113000_membership_cancellation_confirmation_tokens` — UNIQUE on `confirmationTokenHash` is correctly placed (concurrent-claim safety). Both UNIQUE and INDEX exist on the same column - the index is redundant since UNIQUE creates one, but harmless. The `confirmationTokenExpiresAt` index supports expiry sweeps if added later. No expiry cleanup cron yet - confirm one is intended.

- `20260524190000_member_delete_lifecycle_actions` — `memberId` deliberately has no FK (snapshot must survive delete). Good documentation in `20260524230000` migration. `reason` is `NOT NULL` matching `requireCleanText` in code. Status index `(memberId, action, status)` matches `pendingDeleteWhere` query shape. OK.

- `20260524220000_add_booking_change_requests` — `bookingId` FK is RESTRICT (good - blocks booking delete with pending request, though there is no API path to delete a booking). `requesterId` is RESTRICT - this means if a member is hard-deleted via the lifecycle queue while they have a request, the delete will fail. This is consistent with the eligibility blockers in `getMemberDeleteEligibility` although that function does not currently check `BookingChangeRequest`. Add that to the eligibility blocker list. `requestedChanges` is JSONB with no schema validation at the DB layer - rely on zod parsing being complete.

- `20260524230000_member_archive_lifecycle_actions` — Adds ARCHIVE enum value and archive metadata columns. `archivedViaLifecycleActionRequestId` FK is SET NULL on delete (correct - allows lifecycle history retention). No unique index preventing two archive requests for same member; code asserts via `findFirst` in `createMemberArchiveRequest`. See High finding above re race. Indices look reasonable.

## Gap not in scope but flagged

- `getMemberDeleteEligibility` (`src/lib/member-lifecycle-actions.ts:196-303`) does 24 sequential Promise.all `count()` queries on every eligibility check. With concurrent admins this could load the DB. Consider caching for 30 seconds, or materialising the blocker counts into a single Prisma `aggregate` call. Not blocking.
- `BookingChangeRequest` is not in the `getMemberDeleteEligibility` blocker list (`member-lifecycle-actions.ts:196-303`). A pending change request would silently block a delete via FK RESTRICT, producing a 500 instead of a graceful 409. Add `bookingChangeRequest.count({ where: { requesterId: memberId, status: 'PENDING' } })` to the blocker check.
