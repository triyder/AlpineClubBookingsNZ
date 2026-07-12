# Email Message Registry

This is the registry of outbound email messages in the current repository state.
The main senders live under `src/lib/email/` (with `src/lib/email.ts` kept as a
re-export facade); the core `sendEmail` transport is in `src/lib/email/core.ts`
and most HTML bodies are in
`src/lib/email-templates.ts`. Direct one-off senders also exist in the contact
route, refund appeal admin route, admin bulk communications route, and email
retry cron.

Two tiers are documented. The `###` entries under "Exact Messages" are the
admin-editable templates registered in `EMAIL_TEMPLATE_DEFINITIONS`
(`src/lib/email-message-registry.ts`); a contract test
(`src/lib/__tests__/email-message-registry.test.ts`) keeps that list and those
sections in exact sync. The `####` entries under "Hardcoded Messages (Not In
The Admin-Editable Registry)" are live senders whose wording is fixed in code
and cannot be edited from `/admin/notifications`.

This audit covers mail sent by this repository through its Nodemailer/SES path.
I did not find a repo path that instructs Xero to email invoices; any Xero-side
invoice email would be outside this repo's sender inventory.

The `/admin/setup` hub links to `/admin/notifications`, where administrators
can edit shared email variables and template wording without changing
TypeScript files. Admin/system notification delivery policies are managed from
`/admin/notifications`.

Sensitive tokens (`{{doorCode}}`, `{{token}}`, `{{pin}}`, `{{resetUrl}}`,
`{{verifyUrl}}`, `{{confirmationUrl}}`) are body-only: subjects are persisted
in `EmailLog` for every template and travel in clear mail headers, so template
override subjects containing these tokens are rejected at save time, and the
renderer never substitutes their values into a subject line. Required tokens
must appear in the template body; a token in the subject does not satisfy the
requirement.

## Runtime Placeholders

The public checkout has no `config/club.json`, so the checked-in fallback values
come from `config/club.example.json`.

- `{{CLUB_NAME}}`: `Example Mountain Club` in this checkout.
- `{{CLUB_BOOKINGS_NAME}}`: `Example Mountain Club - Bookings` in this checkout.
- `{{CLUB_LODGE_NAME}}`: `Example Mountain Club Lodge` in this checkout.
- `{{CLUB_EMAIL_FROM_NAME}}`: `Example Mountain Club - Online Booking System`
  in this checkout.
- `{{SUPPORT_EMAIL}}`: `support@example.org` in this checkout unless overridden
  by `SUPPORT_EMAIL`.
- `{{CONTACT_EMAIL}}`: `bookings@example.org` in this checkout unless overridden
  by `CONTACT_EMAIL`.
- `{{BASE_URL}}`: `NEXTAUTH_URL` origin at runtime, or `http://localhost:3000`.
- `{{CLUB_LODGE_TRAVEL_NOTE}}`: `The lodge is located near the mountain. Please allow adequate travel time.`

## Common Email Frame

All messages built with `layout()` have this visible frame around the body:

```text
{{CLUB_EMAIL_FROM_NAME}}

Online Booking System

...message body...

{{CLUB_NAME}} • Online Booking System
{{BASE_URL without protocol}}
```

The contact form and permanent email-failure alert do not use this branded
frame.

Admin alert emails are sent once per active admin whose admin notification
preference allows that alert type. They are sent as separate emails, not one
BCC. SES bounce/complaint suppression can skip a recipient before SMTP send.

Member notification preferences (`NotificationPreference`, managed from the
profile page) split into two groups by design (#1285):

- **Must-send transactional (always sent, not toggleable):** booking
  confirmation/pending (`bookingConfirmation`), pending-booking bumps
  (`bookingBumped`), and cancellation/refund notices (`bookingCancelled`). These
  are essential updates about a booking the member owns, so the send path never
  gates them. The profile UI lists them as informational "Always sent" rows with
  no on/off switch — a switch there would promise control that is never honored
  and could hide a cancellation or refund from the person affected.
- **Optional (honored before the send path):** check-in reminders
  (`bookingReminder`, gated in `cron-checkin-reminders.ts` via `shouldSendEmail`)
  and chore rosters (`choreRoster`, gated in `admin-roster-service.ts` via
  `shouldSendChoreRoster`, before the chore token is created). A member who
  switches either off does not receive that mail. For chore rosters the
  preference is resolved with an **Option C hybrid** (#1285): the guest's own
  `NotificationPreference` row wins when it exists; otherwise, if the guest
  inherits their email from a primary member (`inheritEmailFromId`), the
  primary's preference governs (the roster lands in the primary's inbox, so a
  dependent follows the parent's opt-out); if neither has a row — including a
  non-member guest with no member record — the roster is sent (documented
  "no preference → send"). Club Communications (`marketingEmails`) is honored
  separately by the bulk-send recipient filter.

`shouldSendEmail` (`src/lib/email/core.ts`) is the canonical gate for the
optional member categories, with `shouldSendChoreRoster` (same file) layering
the dependent/inheritance resolution on top for chore rosters; neither is ever
applied to the must-send transactional senders.

Failed non-sensitive emails with retained HTML are retried every 30 minutes,
with a 15 minute backoff and at most 3 attempts. Token-bearing templates are not
auto-retried because their HTML is deliberately not retained.

## Exact Messages

### password-reset

Subject:

```text
Reset your {{CLUB_NAME}} password
```

Body:

```text
Password Reset

You requested a password reset for your {{CLUB_NAME}} booking account.

Click the button below to set a new password. This link expires in 1 hour.

Reset Password: {{BASE_URL}}/reset-password?token={{token}}

If you didn't request this, you can safely ignore this email. Your password will remain unchanged.
```

Triggers and frequency:

- `POST /api/auth/forgot-password`: when the submitted email belongs to an active login-enabled member. The route always responds success to avoid enumeration. Rate limit: 5 requests per hour.
- `src/lib/xero-member-import.ts` member import path when `sendInvites` is true. It creates a 7-day token, but this template still says "1 hour".
- One email per matching member/imported member per triggering request.

### admin-password-reset

Subject:

```text
Reset your {{CLUB_NAME}} password
```

Body:

```text
Password Reset

An administrator has requested a password reset for your {{CLUB_NAME}} booking account.

Click the button below to set a new password. This link expires in {{expiryLabel}}.

Reset Password: {{BASE_URL}}/reset-password?token={{token}}

If you believe this was sent in error, please contact the club administrator.
```

Triggers and frequency:

- `POST /api/admin/members/send-password-reset`: admin sends reset links to 1-100 active login-enabled members.
- Expiry label is one of `1 hour`, `1 day`, or `3 days`.
- Bulk sends to more than one member are throttled to once per 10 minutes per admin, sent in batches of 10 with 1 second between batches.

### member-setup-invite

Subject:

```text
Set up your {{CLUB_NAME}} account (7-day link)
```

Body:

```text
Set Up Your Account

Hi {{firstName}},

An administrator has created your {{CLUB_NAME}} booking account.

Use the button below to set your password and activate your login. This link expires in 7 days.

Set Up My Password: {{BASE_URL}}/reset-password?token={{token}}

If you were not expecting this invite, you can safely ignore it or contact the club.
```

Triggers and frequency:

- Admin creates a member with `sendInvite`.
- Admin imports members with `sendInvites`.
- Admin uses `POST /api/admin/members/send-setup-invite`.
- One email per selected/new/imported member per admin action.
- Bulk sends have no per-admin cooldown: the 100-ids-per-request cap plus SES batch pacing (batches of 10, 1 second between batches) are the sole provider protections. The response reports honest per-member outcomes (`sent`, `failed`, and a `results` array) so the admin UI surfaces failures inside the dialog and can retry the members whose email did not deliver.

### email-verification

Subject:

```text
Verify your email — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Verify Your Email

Hi {{firstName}}, thanks for creating your {{CLUB_NAME}} booking account!

Please verify your email address by clicking the button below.

Verify Email: {{BASE_URL}}/verify-email?token={{token}}

This link expires on {{expiresAt}}. If you did not create this account, please ignore this email.
```

Triggers and frequency:

- `POST /api/auth/resend-verification`: when the email belongs to a login-enabled member whose email is not verified.
- Rate limit: 3 requests per hour.
- One email per successful resend request.

### email-change-verification

Subject:

```text
Confirm your new email — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Confirm Your New Email

You requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.

Click the button below to confirm this change.

Confirm Email Change: {{BASE_URL}}/confirm-email-change?token={{token}}

This link expires on {{expiresAt}}. If you did not request this change, please ignore this email.
```

Triggers and frequency:

- `POST /api/auth/request-email-change`: authenticated member requests an email change.
- Rate limit: 3 requests per hour.
- Sent to the new email address once per successful request.

### email-change-notification

Subject:

```text
Email change requested — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Email Change Requested

Someone requested to change the email address on your {{CLUB_NAME}} account to {{newEmail}}.

If this wasn't you, please contact the club immediately.

If you made this request, you can safely ignore this email. The change will only take effect after verification.
```

Triggers and frequency:

- Same `POST /api/auth/request-email-change` request as above.
- Sent to the old email address once per successful request.

### booking-confirmed

Subject:

```text
Booking Confirmed - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Confirmed

Hi {{firstName}}, your lodge booking has been confirmed!

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Subtotal: {{subtotal}}                  [only when discountCents > 0]
Discount ({{promoCode}}): -{{discount}} [only when promoCode exists]
Discount: -{{discount}}                 [only when discount exists without promoCode]
Total Paid: {{totalPaid}}

Payment has been processed successfully.

How to get to the lodge

{{CLUB_LODGE_TRAVEL_NOTE}}

Door code: {{doorCode}} [only when a door code is set]

You can view your booking details and manage your stay from your account.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Booking creation for zero-dollar bookings that become confirmed/paid immediately.
- Draft booking confirmation for zero-dollar confirmed drafts.
- Stripe `payment_intent.succeeded` webhook after primary booking payment succeeds.
- Pending-booking cron when a held pending booking reaches its deadline, capacity is still available, and payment succeeds or price is zero.
- Waitlist offer confirmation when it becomes paid without payment collection.
- Admin force-confirm of a waitlisted booking when final status is `PAID`.
- Admin "confirm pending guests now" tool when the booking becomes `PAID` (the
  zero-amount `paid_zero` or charged-card `paid_charged` outcome).
- The admin force-confirm and confirm-pending-guests sends now honour a
  per-action member-email choice (#1769b, #1705 semantics): the admin may choose
  "Confirm without emailing", which skips this email and records
  `notifyMember: false` in the audit metadata — recorded only on the outcomes
  that actually send (the PAID force-confirm and the `paid_zero`/`paid_charged`
  confirm-pending outcomes). The default is to notify; every other outcome
  (priced force-confirm, `payment_owed`, charge failures) sends no email and
  records no notify field.
- One email per successful confirmation event. No template-level dedupe was found.

### booking-pending

Subject:

```text
Booking Pending - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Pending

Hi {{firstName}}, your lodge booking has been received and is currently pending.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Hold Until: {{holdUntil}}

Your booking includes non-member guests and will be held as pending until {{holdUntil}}.

During this time, club members have priority. If the lodge fills up with member bookings, your booking may be bumped. Your card will only be charged when the booking is confirmed.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Booking creation when status is `PENDING` and `nonMemberHoldUntil` exists.
- Waitlist offer confirmation when it transitions back to `PENDING`.
- One email per transition into that pending state. No template-level dedupe was found.

### booking-bumped

Subject:

```text
Booking Update - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Update

Hi {{firstName}}, unfortunately your pending lodge booking has been bumped due to member demand.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Your card has not been charged.

As a non-member booking, priority is given to club members when the lodge reaches capacity. You're welcome to rebook for different dates where availability exists.

Book Again: {{BASE_URL}}/book

We apologise for the inconvenience.
```

Triggers and frequency:

- Pending-booking cron every 3 hours when a pending booking reaches its hold deadline and capacity is no longer available.
- One email per bumped booking.

### booking-guests-cancelled

Subject:

```text
Booking Cancelled - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Cancelled

Hi {{firstName}}, you asked us to cancel your whole booking if your non-member guests couldn't come. The lodge filled up with member bookings, so we've cancelled it.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

Your card has not been charged.

You're welcome to rebook for different dates where availability exists.

Book Again: {{BASE_URL}}/book
```

Triggers and frequency:

- Pending-booking cron when a booking with the "only book if my guests can come" flag set loses capacity for its non-member guests.
- One email per cancelled booking. No refund — the booking was never charged.

### booking-cancelled

Subject:

```text
Booking Cancelled - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Cancelled

Hi {{firstName}}, your lodge booking has been cancelled.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

{{refundMessage}}

{{creditRestoredMessage}}

You can make a new booking at any time from your account.

Make a New Booking: {{BASE_URL}}/book
```

Refund message variants:

```text
A credit of {{refundAmount}} has been added to your account for future bookings.
```

```text
A refund of {{refundAmount}} has been processed to your original payment method.
```

```text
No refund was applicable based on the cancellation policy.
```

Restored-credit line (`{{creditRestoredMessage}}`, empty when no applied credit was
restored). Since #1164 the account credit originally applied to a booking is restored
subject to the same cancellation policy as the card slice, so it may be less than the
full amount applied:

```text
{{creditRestored}} of previously applied account credit has been restored to your account (per the cancellation policy).
```

Triggers and frequency:

- User/admin cancellation flow for waitlisted, waitlist-offered, pending, confirmed, paid, and no-refund bookings.
- One email per cancellation action after status is changed to `CANCELLED`.
- An admin / Booking Officer cancellation carries an explicit per-cancel choice
  (#1705, `notifyMember`): "Cancel without emailing" skips this email (including
  for linked provisional split children cancelled with the parent) and records
  `notifyMember: false` in the audit metadata. Member self-cancels always send.
  The Xero invoice email on the Internet Banking path is a payment instruction
  and is always sent regardless of the choice.
- Three cancellation flows are **deliberately always-notify** — outside the
  #1705 choice (owner decision 2026-07-10, #1730): joiner emails on a group
  organiser's group cancel, the admin review-rejection cancel, and
  deletion-request cleanup cancellations. The recipients are losing bookings
  they own; a missed email risks a member arriving for a stay that no longer
  exists.

### booking-modified

Subject:

```text
Booking Modified - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Modified

Hi {{firstName}}, your booking has been updated.

{{modificationTypeLabel}}

Previous Dates: {{oldCheckIn}} – {{oldCheckOut}} [only when dates changed]
New Dates: {{newCheckIn}} – {{newCheckOut}}       [only when dates changed]
Dates: {{newCheckIn}} – {{newCheckOut}}           [when dates did not change]
Previous Guests: {{oldGuestCount}}                [only when guest count changed]
New Guests: {{newGuestCount}}                     [only when guest count changed]
Guests: {{newGuestCount}}                         [when guest count did not change]
Previous Total: {{oldTotal}}                      [only when total changed]
New Total: {{newTotal}}                           [only when total changed]
Total: {{newTotal}}                               [when total did not change]
Change Fee: {{changeFee}}                         [only when changeFeeCents > 0]

{{paymentNote}}

You can view your updated booking details from your account.

View Booking: {{BASE_URL}}/bookings
```

Modification label variants:

```text
Dates Changed
Guests Added
Guest Removed
{{raw modificationType}} [for values such as BATCH_MODIFY]
```

Payment note variants:

```text
A refund of {{refundAmount}} has been processed to your original payment method.
```

```text
An additional payment of {{additionalAmount}} is required.
```

Triggers and frequency:

- Date modification route.
- Batch modification route.
- Guest add route.
- Guest remove route.
- One email per successful modification request.
- Admin / Booking Officer edits carry an explicit per-edit choice (#1696,
  `notifyMember`); the standalone guest-remove route honours the same flag for
  admins (#1705), and the admin guest-add route
  (`POST /api/bookings/[id]/guests`) honours it too (#1769b) — a non-admin
  caller carrying the flag is refused with a 403, so a member can never suppress
  their own edit email. "Without emailing" skips this email and records
  `notifyMember: false` in the audit metadata; member self-edits always send.

### checkin-reminder

Subject:

```text
Check-in Reminder - {{CLUB_LODGE_NAME}}
```

Body:

```text
Check-in Reminder

Hi {{firstName}}, your lodge stay begins tomorrow!

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Guest list:

{{guestFirstName}} {{guestLastName}}
...

Your arrival day chores:        [only when chores exist]

{{choreName}}: {{choreDescription}}
...

Please ensure you arrive prepared for alpine conditions. Check the weather forecast before departing.

{{CLUB_LODGE_TRAVEL_NOTE}}

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Cron job `checkin-reminders`, scheduled daily at 9:00 AM NZST.
- Sends for paid/operational bookings checking in tomorrow.
- Skips if a sent `checkin-reminder` email to the same recipient with the same subject exists within the last 48 hours.
- Honors the member's `bookingReminder` preference (#1285): skipped if the member has switched Check-in Reminders off.

### pre-arrival-reminder

Subject:

```text
Pre-arrival Information - {{CLUB_LODGE_NAME}}
```

Body:

```text
Upcoming Lodge Stay

Hi {{firstName}}, your lodge stay is coming up.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Expected arrival: {{expectedArrivalTime}} [only when provided]

How to get to the lodge

{{CLUB_LODGE_TRAVEL_NOTE}}

Door code: {{doorCode}} [only when a door code is set]

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Cron job `pre-arrival-reminders`, run by the in-process cron leader and
  `POST /api/cron` every 3 hours.
- Sends once for confirmed or paid bookings checking in within the 3-day NZ date-only reminder window.
- Claims each booking through `Booking.preArrivalReminderSentAt` before sending to prevent duplicate reminders.

### chore-roster

Subject:

```text
Your chore roster for {{formattedDate}} - {{CLUB_LODGE_NAME}}
```

Body:

```text
Chore Roster

Hi {{guestName}},

Here are your assigned chores for {{formattedDate}} at the lodge:

{{choreName}}: {{choreDescription}}
...

Mark Chores Complete: {{choreLink}} [only when choreLink exists]

Use this link to mark your chores as done from your phone. Link expires in 48 hours. [only when choreLink exists]

Last person to bed: Check heaters and fire are safe and doors are secure.

Thanks for helping keep the lodge running smoothly!
```

Triggers and frequency:

- Admin roster route email action for a lodge date.
- Sends one email per guest with an email address and assigned chores.
- For each guest that will be emailed, the route deletes old guest chore tokens for that guest/date before creating a new 48-hour token.
- Honors the `choreRoster` preference via the Option C hybrid resolver (#1285), evaluated in `admin-roster-service.ts` **before** the token is created so an opted-out recipient leaves no orphaned token: the guest's own preference wins, else the inheriting primary's (`inheritEmailFromId`), else send. Suppressed guests are reported in the response `skipped` count. Non-member guests have no preference and are always sent.
- Per-send email choice (#1785, part of the #1769b sweep): the admin roster send now offers, per send, whether to email or suppress the whole batch. Default = email (fresh 48-hour tokens reissued as today). Suppress (`notifyMember: false`) skips the send entirely **and** leaves existing guest chore tokens/links intact — no token deletion, no new tokens, no email — recording `notifyMember: false` in the audit log (`ADMIN_CHORE_ROSTER_EMAIL_SUPPRESSED`). The `choreRoster` per-member opt-out above still applies on top of the notify path.

### hut-leader-assignment

Subject:

```text
Your {{CLUB_NAME}} hut leader assignment
```

Body:

```text
Hut Leader Assignment

Hi {{firstName}}, thanks for taking on hut leader duties for the lodge.

Start date: {{startDate}}
End date: {{endDate}}
Kiosk PIN: {{pin}}

When you arrive, open the lodge kiosk and use this PIN to unlock hut leader controls for arrivals, departures, and roster management.

Please keep this PIN private and share it only with the assigned hut leader team for these dates.

Responsibilities include checking the lodge list, helping guests settle in, marking arrivals and departures, and making sure the daily chore roster is set up and completed.

Open Lodge View: {{BASE_URL}}/lodge

If you have any issues accessing the kiosk, please contact a club administrator.
```

Triggers and frequency:

- Admin creates a hut leader assignment.
- Admin regenerates or updates the hut leader PIN for an assignment.
- One email per assignment/PIN action.

### setup-intent-failed

Subject:

```text
Card Setup Failed - {{CLUB_LODGE_NAME}}
```

Body:

```text
Card Setup Failed

Hi {{firstName}},

We were unable to save your card details for your upcoming booking ({{checkIn}} – {{checkOut}}). Your booking is still held, but we won't be able to charge you automatically when it's confirmed.

Please log in and update your payment method to avoid your booking being cancelled.

Update Payment Method: {{BASE_URL}}/bookings

If you need help, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Stripe webhook `setup_intent.setup_failed` for a booking.
- One email per failed setup intent webhook event with a booking id.

### waitlist-confirmation

Subject:

```text
Waitlist Confirmation - {{CLUB_LODGE_NAME}}
```

Body:

```text
You're on the Waitlist

Hi {{firstName}}, the lodge is currently fully booked for your requested dates, but you've been added to the waitlist.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Waitlist Position: #{{position}}

We'll email you as soon as a spot opens up. You'll have 48 hours to confirm your booking.

View Booking: {{BASE_URL}}/bookings

You can cancel your waitlist entry at any time from your booking page.
```

Triggers and frequency:

- Booking creation route when capacity is exceeded and the user chooses to join the waitlist.
- One email per new waitlisted booking.

### waitlist-offer

Subject:

```text
Spot Available! - {{CLUB_LODGE_NAME}}
```

Body:

```text
A Spot Has Opened Up!

Hi {{firstName}}, great news — a spot has become available for your waitlisted booking.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Price: {{price}}

This offer expires on {{expiresAt}}. If you don't confirm in time, the spot will be offered to the next person in line.

Confirm Booking: {{BASE_URL}}/bookings/{{bookingId}}

If you no longer need this booking, you can decline from your booking page.
```

Triggers and frequency:

- `processWaitlistForDates()` when capacity is freed and the first FIFO waitlisted booking with full-range capacity is moved to `WAITLIST_OFFERED`.
- Called after cancellations, bumps, some date modifications, and by the waitlist processor after expired offers.
- Waitlist processor is scheduled every 30 minutes when the waitlist feature is enabled.
- Offer expiry defaults to 48 hours unless `WAITLIST_OFFER_HOURS` overrides it.
- One email per offered booking.

### waitlist-offer-expired

Subject:

```text
Waitlist Offer Expired - {{CLUB_LODGE_NAME}}
```

Body:

```text
Waitlist Offer Expired

Hi {{firstName}}, your waitlist offer for the dates below has expired.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
New Position: #{{position}}

You've been returned to the waitlist. We'll notify you again if another spot opens up.

View Booking: {{BASE_URL}}/bookings
```

Triggers and frequency:

- Waitlist processor expires stale `WAITLIST_OFFERED` bookings whose `waitlistOfferExpiresAt` is in the past.
- Waitlist processor is scheduled every 30 minutes when enabled.
- One email per expired offer.

### admin-waitlist-offer

Subject:

```text
Waitlist Offer: {{memberName}}
```

Body:

```text
Waitlist Offer Made

A waitlist offer has been sent to {{memberName}}.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Queue Position: #{{position}}

The member has 48 hours to confirm their booking.

View Waitlist: {{BASE_URL}}/admin/waitlist
```

Triggers and frequency:

- Sent to opted-in admins whenever `waitlist-offer` is sent.
- One alert event per offered booking, multiplied by opted-in admin recipients.

### nomination-request

Subject:

```text
Nomination request for {{applicantName}} — {{CLUB_NAME}}
```

Body:

```text
Membership Nomination Request

Hi {{nominatorName}},

{{applicantName}} has listed you as one of their {{CLUB_NAME}} nominators.

This application also includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]

Please review the application and confirm whether you agree to nominate this person for membership.

You will need to sign in before you can confirm the nomination.

Review Application: {{BASE_URL}}/nominations/{{token}}

This link expires on {{expiresAt}}.
```

Triggers and frequency:

- Membership application creation after the applicant lists two valid nominators.
- Sends to both nominators, so normally two emails per application.
- If a nominator has not confirmed, `nomination-reminders` renews the link and
  resends this message weekly for up to four automatic reminders. Admins can
  refresh the pending nomination workflow, which sends fresh links immediately
  and resets the four-reminder cycle, or replace an unconfirmed nominator.

### admin-membership-application-pending

Subject:

```text
Membership application ready: {{applicantName}}
```

Body:

```text
Membership Application Ready for Review

Both nominators have now confirmed a new membership application.

Applicant: {{applicantName}}
Email: {{applicantEmail}}

This application includes {{familyMemberCount}} dependent family member(s). [only when familyMemberCount > 0]

Review Application: {{BASE_URL}}/admin/member-applications

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Sent to opted-in admins when the second nominator confirmation moves an application to admin review.
- One alert event per application, multiplied by opted-in admin recipients.

### membership-application-approved

Subject:

```text
Your {{CLUB_NAME}} membership has been approved
```

Body:

```text
Membership Approved

Hi {{firstName}}, your {{CLUB_NAME}} membership application has been approved.

Your account is ready. Use the button below to set your password and access the bookings system.

Set Up My Account: {{BASE_URL}}/reset-password?token={{token}}

Committee note: {{adminNotes}} [only when adminNotes exists]

Your entrance fee and any membership charges will be managed separately through the club's normal process.

This setup link expires in 7 days.
```

Triggers and frequency:

- Admin approves a membership application, unless the admin chose not to notify
  (#1786).
- One email per approved applicant. The approval notice carries the
  account-setup (password) link, so suppressing it also withholds that link (the
  setup token is still created; the member recovers it via an admin resend or
  forgot-password). A suppressed send is recorded in the approval audit's
  `details` as `notifyMember: false`.
- The induction sign-off request emails fired on approval are token-bearing
  signer requests and always send regardless of the notify choice.

### membership-application-rejected

Subject:

```text
Update on your {{CLUB_NAME}} membership application
```

Body:

```text
Membership Application Update

Hi {{firstName}}, your {{CLUB_NAME}} membership application has been reviewed.

The committee has decided not to approve the application at this time.

Committee note: {{adminNotes}} [only when adminNotes exists]

If you would like more information, please contact the club directly.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a membership application, unless the admin chose not to notify
  (#1786).
- One email per rejected application; a suppressed notice is recorded in the
  rejection audit's `details` as `notifyMember: false`.

### family-group-invitation

Subject:

```text
{{inviterName}} invited you to join {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Invitation

{{inviterName}} has invited you to join the family group {{groupName}}.

You can accept or decline this invitation from your profile page.

View Invitation: {{BASE_URL}}/profile

If you weren't expecting this invitation, you can safely ignore it.
```

Triggers and frequency:

- Member invites another registered member to a family group.
- Admin approves a group creation request (`GROUP_CREATE`) that names a
  partner: the `ADULT_INVITE` is auto-filed and this same invitation email is
  sent to the partner (#1681).
- One email per invitation.

### family-group-invite-accepted

Subject:

```text
{{inviteeName}} has joined {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Invitation Accepted

{{inviteeName}} has accepted your invitation and joined {{groupName}}.

Your family group has been updated.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Invited member accepts a family group invitation.
- Sent to the original inviter once per accepted invitation.

### child-request-submitted

Subject:

```text
Infant/Child/Youth request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Request Submitted

Hi {{parentName}},

Your request to add {{childName}} to the family group {{groupName}} has been submitted.

An administrator will review your request and link the member to your family group. You'll be notified once it's been processed.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits an infant/child/youth family-group request.
- Sent to the requester once per request.

### child-request-approved

Subject:

```text
{{childName}} has been added to {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Added to Family Group

Hi {{parentName}},

{{childName}} has been added to your family group {{groupName}}.

You can now include them when making bookings.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves a `CHILD_REQUEST` family-group request, unless the admin chose
  not to notify (suppression audited `notifyMember: false`, #1789).
- Sent to the requester once per approval.

### child-request-rejected

Subject:

```text
Infant/Child/Youth request update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Infant/Child/Youth Request Update

Hi {{parentName}},

Your request to add {{childName}} to your family group was not approved.

Admin note: {{reason}} [only when reason exists]

If you have questions, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a `CHILD_REQUEST` family-group request, unless the admin chose
  not to notify (suppression audited `notifyMember: false`, #1789).
- Sent to the requester once per rejection.

### admin-family-group-request

Subject:

```text
Family Group Request: {{requesterName}} ({{requestType}})
```

Body:

```text
Family Group Request

A new {{requestType}} request has been submitted.

Requester: {{requesterName}}

Group: {{groupName}}

{{details}}

Review Requests: {{BASE_URL}}/admin/family-groups

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits an infant/child/youth request.
- Member submits a same-email adult request.
- Member submits a removal request.
- Member submits a join request.
- Sent to opted-in admins once per request event.

### join-request-confirmation

Subject:

```text
Join request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Join Request Submitted

Hi {{requesterName}},

Your request to join the family group {{groupName}} has been submitted.

An administrator will review your request. You'll be notified once it's been processed.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits a family-group join request.
- Sent to the requester once per request.

### family-group-create-request-confirmation

Subject:

```text
Family group request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Request Submitted

Hi {{requesterName}},

Your request to create the family group {{groupName}} has been submitted.

An administrator will review your request. You'll be notified once it's been processed.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Group-less member submits a "create family group" request (#1681).
- Sent to the requester once per request.

### family-group-create-approved

Subject:

```text
Your family group {{groupName}} has been created — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Created

Hi {{requesterName}},

Your family group {{groupName}} has been approved and created. You are the group admin.

Any partner invitation has been sent for them to accept from their profile, and any infant/child/youth requests you included are reviewed separately by an administrator.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves a group creation request (`GROUP_CREATE`), unless the admin
  chose not to notify the requester (suppression audited `notifyMember: false`,
  #1789).
- Sent to the requester once per approval. When the request named a partner,
  the auto-filed invite reuses the `family-group-invitation` template and is
  sent regardless of the notify choice — the invited partner cannot join
  without its token (#1789).

### family-group-create-rejected

Subject:

```text
Family group request update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Request Update

Hi {{requesterName}},

Your request to create the family group {{groupName}} was not approved.

Admin note: {{reason}} [only when reason exists]

If you have questions, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a group creation request (`GROUP_CREATE`), unless the admin
  chose not to notify (suppression audited `notifyMember: false`, #1789);
  bundled pending infant/child/youth requests are cascade-rejected in the same
  review without separate child-rejection emails.
- Sent to the requester once per rejection.

### partner-invite

Subject:

```text
{{inviterName}} invited you to join {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Invitation

{{inviterName}} has invited you to join the family group {{groupName}}.

Use the button below to get started. If you don't have a member account yet, you'll be guided through joining first, then you can accept this invitation once your login is active.

Accept Invitation: {{BASE_URL}}/family-invite/{{token}}

This link expires on {{expiresAt}}.

If you weren't expecting this invitation, you can safely ignore it.
```

Triggers and frequency:

- A group-less member's "create family group" request (#1681) names a partner by
  email who is **not** a registered member (#1682). A single-use, hash-at-rest
  bearer token is minted carrying the family group id, invited email, and
  creator, and this invitation is emailed to that address.
- Sent once to the invited address when the token is minted. Admins can revoke
  an outstanding token from the family groups admin page.
- The claim link routes an unregistered recipient through the normal membership
  application first; once their login is active they return to the same link to
  accept. TTL is 30 days (vs the 7-day nomination link) to span the membership
  process.

### partner-invite-claimed

Subject:

```text
You've joined {{groupName}} — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Family Group Joined

Hi {{firstName}},

You've joined the family group {{groupName}}.

You can now be included when your family makes bookings. Manage your family group from your profile page.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- The invited partner registers and claims their partner-invite token, which
  auto-files an already-accepted `ADULT_INVITE` into the (approved) family group.
- Sent once to the newly-registered partner per successful claim. The inviter is
  notified separately via the existing `family-group-invite-accepted` template.

### partner-link-request

Subject:

```text
{{requesterName}} asked to record you as their partner — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Partner Confirmation Request

{{requesterName}} has asked to record you as their partner (husband, wife, or partner).

Confirming records the relationship with the club. You can confirm or decline from your profile page.

Respond to Request: {{BASE_URL}}/profile

If you weren't expecting this request, you can decline it or safely ignore this email.
```

Triggers and frequency:

- A member declares another registered login adult as their partner (#1742) —
  from the profile Partner card or by marking the named partner during family
  group creation. A `PENDING` `MemberPartnerLink` is created and this consent
  request is emailed to the target.
- Sent once per partner-link request. No email is sent for the one-step
  family-admin declaration (the target has no login) or admin assignment
  (see `partner-link-confirmed`).

### partner-link-confirmed

Subject:

```text
Your partner relationship with {{partnerName}} has been recorded — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Partner Relationship Recorded

Your partner relationship with {{partnerName}} has been recorded with the club.

You can view or remove this relationship from your profile page.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- A partner-link reaches `CONFIRMED` (#1742): the requested member accepts (the
  initiator is emailed), an unregistered partner claims a `createPartnerLink`
  invite token (the inviter is emailed), or an admin assigns the link directly
  (both members are emailed, once if they share an address) unless the admin
  chose not to notify (#1769a).
- Sent once per confirmation per distinct recipient address.

### partner-link-removed

Subject:

```text
Your partner relationship with {{partnerName}} has been removed — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Partner Relationship Removed

Your recorded partner relationship with {{partnerName}} has been removed.

If you weren't expecting this change, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- A `CONFIRMED` partner link is removed (#1742): one partner dissolves it (the
  other partner is emailed) or an admin removes it (both members are emailed,
  once if they share an address) unless the admin chose not to notify (#1769a).
  Declining or withdrawing a still-pending request sends no email.
- Sent once per removal per distinct recipient address.

### membership-cancellation-submitted

Subject:

```text
Membership cancellation request submitted — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Request Submitted

Hi {{firstName}},

Your membership cancellation request has been submitted for admin review.

Included memberships: {{participantSummary}}

Reason: {{reason}} [only when reason exists]

Memberships remain active until an administrator approves the request. Any included login-capable adult must confirm before an administrator can process their cancellation.

View Request: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits a membership cancellation request.
- Sent once to the requester after the request is recorded.
- Email failure is returned as a non-blocking warning; the submitted request remains valid.

### membership-cancellation-confirmation

Subject:

```text
Confirm membership cancellation request — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Confirm Membership Cancellation

Hi {{firstName}},

{{requesterName}} has included {{participantName}} in a membership cancellation request.

Your membership will remain active unless you sign in and confirm that you want to be included. This confirmation does not approve or process the cancellation; an administrator still needs to review the request.

Review Cancellation Request: {{BASE_URL}}/membership-cancellation/{{token}}

This link expires on {{expiresAt}}.

If you do not want to be included, use the link and choose Decline. If you were not expecting this request, you can ignore this email or contact the club.
```

Triggers and frequency:

- Member includes another login-capable adult in a membership cancellation request.
- Sent once per pending participant confirmation.

### membership-cancellation-approved

Subject:

```text
Membership cancellation approved — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Approved

Hi {{firstName}},

The membership cancellation for {{participantName}} has been approved and processed.

Request reason: {{reason}} [only when reason exists]

This membership is now inactive and the booking login has been disabled. Booking, payment, and audit history has been retained.

Admin note: {{adminNote}} [only when adminNote exists]

{{rejoinProcessText}} [only when rejoinProcessText exists]

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves and locally processes a membership cancellation participant,
  unless the reviewing admin chose not to notify (suppression audited
  `notifyMember: false`, #1787).
- Sent once per approved participant. Email failure is logged but does not block local cancellation processing.
- No Xero credit note, contact group, or archive action is performed by this email path.

### membership-cancellation-rejected

Subject:

```text
Membership cancellation update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Cancellation Request Update

Hi {{firstName}},

The membership cancellation request for {{participantName}} was not approved at this time.

Request reason: {{reason}} [only when reason exists]

Admin note: {{adminNote}} [only when adminNote exists]

This membership remains active.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects a membership cancellation participant, unless the reviewing
  admin chose not to notify (suppression audited `notifyMember: false`, #1787).
- Sent once per rejected participant.

### admin-membership-cancellation-request

Subject:

```text
Membership cancellation ready: {{requesterName}}
```

Body:

```text
Membership Cancellation Ready for Review

{{requesterName}} submitted a membership cancellation request with at least one participant ready for admin review.

Requester: {{requesterName}}
Included memberships: {{participantSummary}}

Reason: {{reason}} [only when reason exists]

Review Cancellation Requests: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- A membership cancellation request is submitted with at least one immediately reviewable participant, or an adult participant confirms inclusion.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### age-up-invitation

Subject:

```text
You're now {{targetAgeTierLabel}} — set up your {{CLUB_NAME}} account
```

Body:

```text
Welcome to Your Own Account, {{firstName}}!

Congratulations — you've reached the {{targetAgeTierLabel}} age tier. You can now log in and book stays at the lodge yourself.

Click the button below to set up your password and activate your account. This link expires in 7 days.

Set Up My Password: {{BASE_URL}}/reset-password?token={{token}}

Once you set your password, you can log in at any time to book stays, view your bookings, and manage your profile.

If you have any questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Age-up cron, scheduled daily at 6:30 AM NZST.
- Candidate criteria: active member, cannot login yet, age tier is not ADULT, date of birth places them in the configured ADULT age tier at the season start date.
- Requires the member to have a unique login email and no email-inheritance source.
- Skips if a sent/queued `age-up-invitation` already exists for the member email.
- Rolls back the login upgrade/token if email delivery fails so a later cron can retry.

### age-up-parent-email-handoff

Subject:

```text
Email address needed for {{memberName}}'s {{CLUB_NAME}} login
```

Body:

```text
Email Address Needed for {{memberName}}

Hi {{recipientName}},

{{memberName}} has reached the {{targetAgeTierLabel}} age tier. Before we can activate their own booking login, they need a unique email address on their member record.

They are currently using or inheriting another member's login email, so we have not enabled their login yet.

Please contact the club at {{SUPPORT_EMAIL}} with {{memberName}}'s preferred email address. Once it is updated, their booking login can be activated.
```

Triggers and frequency:

- Age-up cron, scheduled daily at 6:30 AM NZST.
- Sent to the parent, email-inheritance source, or existing shared-login holder when an ageing-up member still shares or inherits a login email.
- Does not include a token or login setup link.
- Leaves the ageing-up member unchanged: no login enablement, no setup token, and no age-tier update.
- Records an audit event keyed to the ageing-up member so the handoff is not resent every day; separate youths sharing the same recipient email are deduped independently.

### account-deletion-approved

Subject:

```text
Your Account Deletion Request Has Been Processed
```

Body:

```text
Account Deletion Confirmed

Hi {{firstName}},

We have processed your account deletion request. Your personal data has been anonymised in accordance with our Privacy Policy.

Your account is now deactivated and you will no longer be able to log in. Booking history has been retained for financial and audit purposes with your personal details removed.

If you have any questions, please contact the club.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin approves an account deletion request.
- Sent before anonymisation, once per approval attempt. Email failure is logged but does not block deletion.
- Deliberately always-send with no admin notify choice: the member requested
  deletion, cannot log in afterward to check, and this is the final privacy
  receipt (owner-ratified always-send, #1788).

### account-deletion-rejected

Subject:

```text
Update on Your Account Deletion Request
```

Body:

```text
Account Deletion Request Update

Hi {{firstName}},

Your account deletion request has been reviewed and was not approved at this time.

Admin note: {{adminNote}} [only when adminNote exists]

If you have questions about this decision, please contact the club directly.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin rejects an account deletion request, unless the admin chose not to
  notify (suppression audited `notifyMember: false`, #1788).
- Sent once per rejection when notifying.

### admin-account-deletion-requested

Subject:

```text
Account deletion requested: {{memberName}}
```

Body:

```text
Account Deletion Request Submitted

{{memberName}} submitted an account deletion request.

Member: {{memberName}}
Email: {{memberEmail}}

Reason:
{{reason}} [only when reason exists]

Review Deletion Requests: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Member submits a self-service account deletion request.
- Sent once per newly queued pending deletion request. Email failure is logged but does not block queueing.

### admin-member-archive-requested

Subject:

```text
Member archive requested: {{memberName}}
```

Body:

```text
Member Archive Requested

{{requesterName}} requested archive review for {{memberName}}.

Member: {{memberName}}
Requested by: {{requesterName}}

Reason:
{{reason}}

Review Archive Requests: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin submits an archive request for a cancelled member.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### member-archive-approved

Subject:

```text
Membership archive completed — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Archive Completed

Hi {{firstName}},

Your cancelled membership record has been archived.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

Archive preserves booking, payment, Xero, and audit history while removing the record from default operational lists.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin approves an archive lifecycle request, unless the approving admin
  chose not to notify (suppression audited `notifyMember: false`, #1788); a
  member with no email on file is never emailed and records no notify field.
- Sent once to the archived member. Email failure is logged but does not block archival.

### member-archive-rejected

Subject:

```text
Membership archive request update — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Membership Archive Request Update

Hi {{firstName}},

The archive request for your cancelled membership was not approved at this time.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin rejects an archive lifecycle request, unless the reviewing admin
  chose not to notify (suppression audited `notifyMember: false`, #1788); a
  member with no email on file is never emailed and records no notify field.
- Sent once to the member whose archive was rejected. Email failure is logged but does not block rejection.

### admin-member-delete-requested

Subject:

```text
Member delete requested: {{memberName}}
```

Body:

```text
Member Delete Requested

{{requesterName}} requested hard-delete review for {{memberName}}.

Hard delete is only for records added in error with no meaningful booking, financial, lodge, Xero, or audit history.

Member: {{memberName}}
Requested by: {{requesterName}}

Reason:
{{reason}}

Review Member: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Admin submits a hard-delete lifecycle request.
- Sent to admins opted in to member request alerts.
- Respects the admin/system delivery policy for this template.

### admin-member-delete-approved

Subject:

```text
Member delete approved: {{memberName}}
```

Body:

```text
Member Delete Approved

Hi {{requesterName}},

The hard-delete request for {{memberName}} was approved and processed.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

A request snapshot was retained before the member record was deleted.

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin approves a hard-delete lifecycle request.
- Sent to the requesting admin after the member record is deleted. The target member is not emailed because hard delete is reserved for erroneous records.

### admin-member-delete-rejected

Subject:

```text
Member delete rejected: {{memberName}}
```

Body:

```text
Member Delete Request Rejected

Hi {{requesterName}},

The hard-delete request for {{memberName}} was not approved.

Reason:
{{reason}}

Review note: {{reviewNote}} [only when reviewNote exists]

Open Member: {{reviewUrl}}

{{CLUB_NAME}} — {{SUPPORT_EMAIL}}
```

Triggers and frequency:

- Second admin rejects a hard-delete lifecycle request.
- Sent once to the requesting admin. The target member is not emailed because hard delete is reserved for erroneous records.

### admin-minors-review

Subject:

```text
Review required: booking has only under-18 guests ({{memberName}})
```

Body:

```text
Booking Review Required

A paid booking was edited and now has only under-18 guests. It is blocked from lodge check-in until an admin reviews it.

{{reviewReason}}

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Review Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- A guest removal or batch edit newly drops a paid (capacity-holding) booking into a minors-only (no-adult) composition (F27 / #1372).
- The booking keeps its PAID status but is blocked from lodge check-in until an admin clears the review; sent once to opted-in admins per event. Not sent when the booking already carried a pending review or still has an adult.
- Gated by its own "Booking review required" (`adminBookingReviewRequired`) admin notification preference (#1422), separate from routine new-booking alerts, so muting new-booking mail does not silence this review alert.

### admin-owner-substitution

Subject:

```text
Owner substitution — reconcile Xero contact for booking request {{requestId}}
```

Body:

```text
Owner Substitution — Xero Reconciliation Required

An owner substitution occurred while converting booking request {{requestId}} into booking {{bookingId}}. The booking (and its Xero invoice) will bill a newly-created contact instead of the intended owner.

Action required: reconcile the invoice's contact in Xero — repoint it from the newly-created contact to the intended organisation.

Intended owner (should be billed): {{intendedMemberName}} ({{intendedMemberId}})
Substituted contact (currently billed): {{substituteMemberName}} ({{substituteMemberId}})
Reason: {{reason}}
Requester: {{requesterName}} ({{memberEmail}})
Check-in: {{checkIn}}
Check-out: {{checkOut}}

Review Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- A held booking-request owner was no longer a valid non-login contact by the time the requester accepted (login enabled, archived, deactivated, role changed), so the accept substituted a fresh non-login contact to avoid failing the requester (issue #1255 residual-risk decision 1). Sent once per conversion that substitutes.
- Fires post-commit alongside the durable `booking_request.owner_substituted` audit row (F20 residual #2 / #1377); a failed send never fails the conversion.
- Gated by the "Xero sync errors" (`adminXeroSyncError`) admin notification preference, because the remedy is a Xero contact reconciliation (repoint the invoice's contact to the intended organisation) so the finance/Xero admin audience is the right recipient set.

### admin-partner-share-swept

Subject:

```text
Review required: shared double-bed placements removed ({{memberName}})
```

Body:

```text
Shared Double-Bed Placements Removed

A partner pair no longer qualifies for double-bed sharing, so their future shared placements were removed. The affected guest nights are back in the awaiting-allocation queue and may need re-planning on the allocation board.

Member: {{memberName}}
Partner: {{partnerName}}
Reason: {{reason}}
Removed night{{s}}: {{date}}

Review Bed Allocation: {{BASE_URL}}/admin/bed-allocation
```

Triggers and frequency:

- A CONFIRMED partner link was dissolved (member self-service or admin removal), a member was deactivated (member edit, bulk update, or account-deletion anonymisation), or an ADULT member was re-tiered to a minor/N-A tier, while the pair still held future `isSecondOccupant` shared double-bed allocations (#1756). The sweep removes the second occupant back to the awaiting-allocation queue inside the same transaction and audits both bookings; this alert fires post-commit.
- Sent once per event that removed at least one placement; a no-op sweep sends nothing. A failed send never fails the dissolve/deactivation.
- Gated by the "Booking review required" (`adminBookingReviewRequired`) admin notification preference — the queue entry needs a human re-plan on the allocation board, the same review-shaped audience as the minors-only alert.

### admin-new-booking

Subject variants:

```text
Booking Review Required: {{memberName}}
New Booking: {{memberName}} ({{status}})
```

Body:

```text
New Booking Created

A new booking has been created.

{{reviewReason}} [only when reviewReason exists]

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Total: {{total}}
Status: {{status}}

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Booking creation route for new bookings.
- Waitlist booking creation.
- Draft booking confirm route, only if `requiresAdminReview`.
- Payment intent creation for draft -> payment pending, only if `requiresAdminReview`.
- Sent to opted-in admins once per relevant event.

### admin-payment-failure

Subject:

```text
Payment Failed — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Payment Failed

A payment has failed and may require manual attention.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Amount: {{amount}}
Error: {{errorMessage}}
Stripe PI: {{paymentIntentId}}

View Payments: {{BASE_URL}}/admin/payments
```

Triggers and frequency:

- Stripe payment failure webhook.
- Off-session saved-card charge requires additional authentication.
- Stripe amount mismatch manual-review paths.
- Stripe captures payment after booking cancellation and auto-refund path.
- Pending-booking cron every 3 hours when a Stripe charge attempt fails.
- Payment reconciliation capacity/refund failure path.
- Sent to opted-in admins once per failure event.

### admin-pending-deadline

Subject:

```text
{{count}} Pending Booking{{s}} Approaching Deadline
```

Body:

```text
Pending Bookings Approaching Deadline

{{count}} pending booking(s) will reach their hold deadline within 48 hours.

Member | Dates | Guests | Deadline | Remaining
{{memberName}} | {{checkIn}} – {{checkOut}} | {{guestCount}} | {{deadline}} | {{hoursRemaining}}h
...

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Pending deadline cron, scheduled daily at 8:00 AM NZST.
- Sends only when one or more `PENDING` bookings have `nonMemberHoldUntil` greater than now and within the next 48 hours.
- One digest alert event per daily run with matches, multiplied by opted-in admin recipients.

### admin-booking-bumped

Subject:

```text
Booking Bumped: {{bumpedMemberName}}
```

Body:

```text
Booking Bumped

A pending booking has been bumped due to a member booking.

Bumped Member: {{bumpedMemberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Triggered By: {{triggeringMemberName}}

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Sent to opted-in admins by the pending-booking cron after a pending booking is bumped.
- One alert event per bumped booking.

### admin-capacity-warning

Subject:

```text
Capacity Warning: {{count}} high-occupancy day{{s}} ahead
```

Body:

```text
Capacity Warning

{{count}} day(s) in the next 14 days have high occupancy.

Date | Occupied | Available | Occupancy
{{date}} | {{occupiedBeds}}/{{LODGE_CAPACITY}} | {{availableBeds}} | {{percent}}%
...

View Bookings: {{BASE_URL}}/admin/bookings
```

Triggers and frequency:

- Capacity warning cron, scheduled daily at 7:00 AM NZST.
- Looks at the next 14 nights and sends when any night has 5 or fewer beds available.
- One alert event per daily run with high-occupancy days, multiplied by opted-in admin recipients.

### admin-daily-digest

Subject:

```text
Admin Daily Digest - {{totalAlerts}} alert{{s}} in past 24h
```

Body when alerts exist:

```text
Admin Daily Digest

Summary of admin alerts from the past 24 hours.

Alert Type | Count | Action
New Bookings | {{count}} | View
Payment Failures | {{count}} | View
Capacity Warnings | {{count}} | View
Bookings Bumped | {{count}} | View
Pending Deadlines | {{count}} | View
Xero Errors | {{count}} | View

Total alerts: {{totalAlerts}}

Open Admin Dashboard: {{BASE_URL}}/admin/dashboard
```

Body when no alerts exist:

```text
Admin Daily Digest

Summary of admin alerts from the past 24 hours.

No alerts were triggered in the past 24 hours. All systems running normally.

Total alerts: 0

Open Admin Dashboard: {{BASE_URL}}/admin/dashboard
```

Triggers and frequency:

- Admin digest cron, scheduled daily at 7:30 AM NZST.
- Counts distinct sent/queued admin alert events from the last 24 hours by `templateName + subject`.
- Default delivery policy is content-only, so the cron run is logged but no
  email is sent when the count is zero. Admins can change the policy to always
  send or disabled from `/admin/notifications`.

### admin-xero-sync-error

Subject:

```text
Xero Sync Error — {{CLUB_BOOKINGS_NAME}}
```

Body:

```text
Xero Sync Error

A Xero integration error occurred and may require attention.

Error Type: {{errorType}}
Operation: {{operation}}
Error Message: {{errorMessage}}
Timestamp: {{timestamp}}

View Xero Status: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- Deduplicated `notifyXeroSyncError()` wrapper.
- Called when booking invoice queueing fails after Stripe payment success.
- Called from Xero contact/group sync error handling.
- Suppressed if any sent/queued `admin-xero-sync-error` exists in the last hour.
- At most one of this template per hour across the app.

### admin-xero-repeated-failure

Subject:

```text
Repeated Xero Failure: {{correlationKey}}
```

Body:

```text
Repeated Xero Failures

The same Xero sync correlation key has failed repeatedly and now needs operator attention.

Correlation Key: {{correlationKey}}
Failures in Window: {{failureCount}} in the last {{windowHours}} hour(s)
Entity: {{entityType}}
Operation: {{operationType}}
Local Record: {{localModel}} {{localId}} OR Unavailable
Latest Error: {{latestErrorMessage}} OR Unavailable
Timestamp: {{timestamp}}

Open local record [only when localUrl exists]
Open Xero object [only when xeroObjectUrl exists]

Open Xero Admin: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- When a Xero sync operation becomes `FAILED` or `PARTIAL`.
- Default threshold: at least 3 failed/partial operations with the same correlation key in a 24-hour window.
- Suppressed if a sent/queued alert for the same subject exists in that same window.

### admin-xero-reconciliation-report

Subject variants:

```text
Xero Reconciliation Report - clean
Xero Reconciliation Report - action needed: {{issueCategoryCount}} categor{{y|ies}}, {{issueTotalCount}} item{{s}}
```

Body:

```text
Xero Reconciliation Report

No open reconciliation gaps were detected in this report window.
```

or:

```text
Xero Reconciliation Report

Reconciliation gaps were detected. Start with the action sections below, then use the diagnostic totals for context.

Generated: {{generatedAt}}
Lookback Window: {{lookbackHours}} hour(s)
Stale Pending Threshold: {{stalePendingMinutes}} minute(s)
Issue Categories: {{issueCategoryCount}}
Total Issue Count: {{issueTotalCount}}

{{severityLabel}} • {{section.count}}
{{section.title}}
What went wrong: {{section.whatWentWrong}}
How to fix: {{section.howToFix}}

{{item.label}}
{{item metadata}}
{{item.detail}}
Latest error: {{item.latestErrorMessage}}
Open booking record
Open Xero

Diagnostic totals
Missing member contact links: {{count}}
Missing payment invoice links: {{count}}
Missing refund credit note links: {{count}}
Missing subscription invoice links: {{count}}
Mismatched canonical links: {{count}}
Stale canonical links: {{count}}
Duplicate active canonical links: {{count}}
Stale pending/running operations: {{count}}
Recent failed operations: {{count}}
Recent partial operations: {{count}}
Unsupported partial operations: {{count}}
Repeated-failure correlations: {{count}}

Open Xero Admin: {{BASE_URL}}/admin/xero
```

Triggers and frequency:

- Nightly Xero reconciliation cron, scheduled daily at 2:35 AM NZST when the Xero module is enabled.
- `POST /api/cron/xero` with task `report` or `all`.
- Default delivery policy is content-only, so a clean report is logged but not
  emailed. Admins can change the policy to always send or disabled from
  `/admin/notifications`.

### admin-refund-request

Subject:

```text
Refund Appeal: {{memberName}}
```

Body:

```text
Refund Appeal Submitted

{{memberName}} has submitted a refund appeal.

Member: {{memberName}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Paid: ${{paidAmount}}
Already Refunded: ${{refundedAmount}}
Remaining: ${{remainingAmount}}
Requested: ${{requestedAmount}} [only when requestedAmountCents is truthy]

{{reason}}

Review Appeal: {{BASE_URL}}/admin/refund-requests
```

Triggers and frequency:

- Member submits a refund appeal for an eligible cancelled booking.
- Sent to opted-in admins once per submitted refund request.

### admin-booking-change-request

Subject:

```text
Booking Change Request: {{memberName}}
```

Body:

```text
Booking Change Request Submitted

{{memberName}} has requested an admin-reviewed booking change for a locked same-day or past-night period.

Member: {{memberName}}
Email: {{memberEmail}}
Booking: {{bookingId}}
Current check-in: {{checkIn}}
Current check-out: {{checkOut}}
Requested change: {{requestedSummary}}

Reason: {{reason}} [only when reason exists]

Review Request: {{reviewUrl}}
```

Triggers and frequency:

- Member or admin submits a booking change request for locked same-day or
  past-night booking changes.
- Sent to opted-in admins once per submitted booking change request.

### refund-request-resolved

Approved subject:

```text
Refund Appeal Approved — {{CLUB_BOOKINGS_NAME}}
```

Rejected subject:

```text
Refund Appeal Update — {{CLUB_BOOKINGS_NAME}}
```

Approved body:

```text
Refund Appeal Approved

Hi {{firstName}},

Your refund appeal for your booking ({{checkIn}} - {{checkOut}}) has been approved. A refund of {{amount}} will be processed to your original payment method.

Notes:
{{adminNotes}} [only when adminNotes exists]

If you have questions, contact the club at {{SUPPORT_EMAIL}}.
```

Rejected body:

```text
Refund Appeal Update

Hi {{firstName}},

Your refund appeal for your booking ({{checkIn}} - {{checkOut}}) was not approved at this time.

Notes:
{{adminNotes}} [only when adminNotes exists]

If you have questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Admin approves or rejects a pending refund appeal, unless the admin chose not
  to notify (suppression audited `notifyMember: false`, #1792). The refund
  execution, ledger/aggregate math, and Stripe/Xero effects are identical either
  way — only the outcome notice is suppressed.
- One email to the member per appeal review.

### admin-issue-report

Subject:

```text
Issue Report: {{memberName}}
```

Body:

```text
Issue Report Submitted

{{memberName}} has reported an issue from the bookings site.

Member: {{memberName}}
Email: {{memberEmail}}
Page: {{pageTitle OR pageUrl}}
Screenshot: Available in admin OR Not included

{{description}}

Review Issue Report: {{issueReportUrl}}

Open Reported Page: {{pageUrl}}
```

Triggers and frequency:

- Authenticated member submits an issue report.
- Sent to opted-in admins once per issue report.

### bulk-communication

Subject:

```text
{{adminEnteredSubject}}
```

Body:

```text
{{adminEnteredSubject}}

{{adminEnteredBody}}

This email was sent to you by the {{CLUB_NAME}} administration. You can update your email preferences in your account settings.

Manage Preferences: {{BASE_URL}}/profile
```

Triggers and frequency:

- `POST /api/admin/communications/send`.
- Admin chooses recipients: all active, members-only, admins-only, or custom.
- Recipients are filtered to those with `marketingEmails === true`; no preference record means excluded.
- Global rate limit: 1 bulk send per hour.
- Sends in background batches of 10 with 1 second between batches.

### website-contact

Subject:

```text
Website Contact{{recipientLabel}}: {{name}}
```

Body:

```text
New Contact Form Submission

Name: {{name}}
Email: {{email}}
Message: {{message}}
```

Triggers and frequency:

- `POST /api/contact`.
- Sends to `CONTACT_EMAIL` or a published, active, contactable committee
  assignment matching `recipient`; committee delivery uses the role email first
  and the linked member email when the role email is blank. Committee-routed app
  logs use an opaque recipient marker instead of the private member email.
- Actual rate limiter is 10 requests per hour. The route comment says 5 per hour, but the configured limiter is 10 per hour.
- This message does not use the common branded layout.

### admin-email-failure

Subject:

```text
Email delivery permanently failed
```

Body:

```text
Email to {{originalRecipient}} (template: {{originalTemplateName}}) has failed after {{attemptCount}} attempts and will not be retried.
```

Triggers and frequency:

- Email retry cron runs every 30 minutes.
- When a non-sensitive failed email reaches 3 attempts, active admins are alerted.
- This alert is not itself retried recursively.
- This message does not use the common branded layout.

### credit-applied-to-booking

No sender was found for this template.

Subject: no subject is defined in `email.ts`.

Body:

```text
Account Credit Applied

Hi {{firstName}}, account credit was applied to your booking.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Credit applied: {{creditUsed}}
Remaining credit: {{remainingCredit}}
```

### booking-request-verification

Subject:

```text
Confirm your booking request — {{CLUB_NAME}}
```

Body:

```text
Confirm Your Booking Request

Hi {{firstName}}, thanks for your booking request with {{CLUB_NAME}}.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Please confirm your email address to add your request to our review queue.

Confirm Request: {{BASE_URL}}/booking-requests/verify/{{token}}

This link expires on {{expiresAt}}. If you did not submit this request, please ignore this email.
```

Triggers and frequency:

- `POST /api/booking-requests`: when a non-member submits the public booking request form. Per booking request submission. Rate limit: 5 requests per hour per IP.

### booking-request-approved

Subject:

```text
Your booking request has been approved — {{CLUB_NAME}}
```

Body:

```text
Booking Request Approved

Hi {{firstName}}, great news — your booking request has been approved!

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Total: {{price}}
Booking reference: {{bookingReference}}

Please complete payment to confirm your booking.

Pay Now: {{BASE_URL}}/pay/{{token}}

This payment link expires on {{expiresAt}}. If it expires before you pay, please contact the club to request a new link.
```

Triggers and frequency:

- `POST /api/admin/booking-requests/[id]/approve`: when a booking officer approves a priced request and it converts to a PENDING booking with a tokenised payment link. Per booking request approval.

### booking-request-quote

Subject:

```text
Your booking quote is ready — {{CLUB_NAME}}
```

Body:

```text
Booking Quote Ready

Hi {{firstName}}, the club has prepared a quote for your lodge request.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

{{quoteOptions}}

Respond to Quote: {{BASE_URL}}/booking-requests/respond/{{token}}

This quote link expires on {{expiresAt}}. You can use it to accept, cancel, request changes, or send a question.
```

Triggers and frequency:

- `POST /api/admin/booking-requests/[id]/send-quote`: when a booking officer sends the latest versioned public booking request quote. Per quote version sent.

### booking-request-declined

Subject:

```text
Update on your booking request — {{CLUB_NAME}}
```

Body:

```text
Booking Request Update

Hi {{firstName}}, thank you for your interest in staying with {{CLUB_NAME}}.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

Unfortunately we're unable to accommodate this request.

Note: {{reason}} [only when reason exists]

If you have any questions, please contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- `POST /api/admin/booking-requests/[id]/decline`: when a booking officer declines a verified or priced request, unless the admin chose not to notify the requester (suppression audited `notifyMember: false`, #1791). Per booking request decline. The booking-request approved and quote emails carry the payment/quote link and always send regardless of the notify choice.

### admin-booking-request-pending

Subject:

```text
Booking request ready for review: {{requesterName}}
```

Body:

```text
Booking Request Ready for Review

{{requesterName}} has verified their email and the request is ready for pricing.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Review Request: {{reviewUrl}}
```

Triggers and frequency:

- `GET /api/booking-requests/verify/[token]`: when a requester confirms their email and the request enters the admin queue. Per verified booking request. Sent to admins who opt in to the "Public booking requests" notification.

### admin-booking-request-hold-expired

Subject:

```text
Request booking unpaid at hold expiry: {{requesterName}}
```

Body:

```text
Request Booking Unpaid at Hold Expiry

{{requesterName}}'s request-origin booking has reached its hold deadline without payment.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Total due: {{total}}
Hold until: {{holdUntil}}

Review Bookings: {{reviewUrl}}
```

Triggers and frequency:

- `POST /api/cron` (confirm-pending job): when a request-origin booking (no saved card) reaches its hold deadline unpaid; the hold is extended and admins are alerted instead of auto-charging. Per hold-expiry check on an unpaid request booking. Sent to admins who opt in to the "Public booking requests" notification.

### booking-review-approved

Subject:

```text
Your booking has been approved - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Approved

Hi {{firstName}}, an admin has approved your booking. You can now complete payment to confirm it.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

Note from admin: {{adminNotes}} [only when adminNotes is non-empty]

Complete Payment: {{BASE_URL}}/bookings/{{bookingId}}
```

Triggers and frequency:

- `POST /api/admin/bookings/[id]/review` (approve): when an admin approves a booking held for review (minors flow), releasing it for payment — unless the admin chose not to notify (suppression audited `notifyMember: false`, #1790). One email per approval decision, to the booking owner.

### booking-review-rejected

Subject:

```text
Your booking could not be approved - {{CLUB_LODGE_NAME}}
```

Body:

```text
Booking Declined

Hi {{firstName}}, an admin has reviewed your booking and was not able to approve it. The booking has been cancelled — no payment was taken.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

Reason from admin: {{adminNotes}} [only when adminNotes is non-empty]

You are welcome to make a new booking that includes an adult guest, or contact the club to discuss.

Make a New Booking: {{BASE_URL}}/book
```

Triggers and frequency:

- `POST /api/admin/bookings/[id]/review` (reject): when an admin declines a booking held for review (minors flow); the booking is cancelled and no payment is taken. The admin may choose not to notify (suppression audited `notifyMember: false`, #1790), which withholds only this review-declined notice — the separate cancellation email from the shared cancel flow is deliberately always-notify (#1730), so a suppressed reject still emails the member the cancellation. One email per rejection decision, to the booking owner.

### induction-sign-off-request

Subject:

```text
Lodge induction sign-off for {{inducteeName}} — {{CLUB_NAME}}
```

Body:

```text
Lodge Induction Sign-Off Request

Hi {{signerName}},

{{inducteeName}} needs their {{CLUB_NAME}} lodge induction signed off, and you can do this as their {{signerRoleLabel}}.

Once you have taken them through the lodge induction checklist and you are satisfied they are competent, please sign in and confirm the sign-off on your induction page.

You will need to sign in before you can complete the sign-off.

Open My Induction Page: {{inductionUrl}}
```

Triggers and frequency:

- `POST /api/admin/inductions`: when an admin assigns induction sign-off signers. One email per assigned signer with an email address.
- Membership application approval (`approveMemberApplication` in `src/lib/nomination.ts`): sign-off requests also go out automatically to the assigned signers when an application is approved.

### school-attendee-confirmation

Subject:

```text
Confirm your attendee list — {{CLUB_NAME}}
```

("Reminder: confirm your attendee list — {{CLUB_NAME}}" when a prompt has
already been sent for this request.)

Body:

```text
Confirm Your Attendee List [heading becomes "Reminder: Confirm Your Attendee List" on reminders]

Hi {{firstName}}, {{schoolName}}'s stay at {{CLUB_NAME}}'s lodge is coming up, and the booking currently lists placeholder attendee names. Please tell us who is coming so the lodge roster shows real names on arrival. [falls back to "your school group's stay" when no school name is recorded]

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Attendees: {{guestCount}}

Use the secure link below to update the names and confirm the list. You can come back and edit until you confirm; the link stays valid until check-in.

Confirm Attendees: {{BASE_URL}}/school-bookings/confirm/{{token}}

Need to change how many people are coming, or their age groups? Contact the club instead — headcount changes go through a revised quote.

If you have any questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- `POST /api/cron` (school-attendee-confirmations job): prompts school contacts whose converted booking still lists placeholder attendees ahead of check-in; marked as a reminder after the first send. The tokenized link is rotated on every send.
- `POST /api/admin/booking-requests/[id]/resend-attendee-confirmation`: explicit admin resend button. One email per send, to the school contact.

### admin-school-manual-invoice

Subject:

```text
School booking needs a manual invoice: {{schoolName}}
```

Body:

```text
School Booking Needs a Manual Invoice

A school group booking has been approved and confirmed. The Xero module is currently off, so no invoice was raised automatically. Please invoice the school manually and record payment through the usual paths.

School: {{schoolName}}
Contact email: {{contactEmail}}
Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}
Amount: {{amount}}

View Booking Requests: {{reviewUrl}}
```

Triggers and frequency:

- School booking-request conversion (`src/lib/school-booking-request.ts`): when an approved school request converts to a confirmed booking while the Xero module is off, so no invoice was raised automatically. The named school/contact is the party to invoice — the email itself goes to admins. Per conversion. Sent to admins who opt in to the "Public booking requests" notification.

### group-booking-join-verification

Subject:

```text
Confirm your group booking spot — {{CLUB_NAME}}
```

Body (reuses the `booking-request-verification` template, pointed at the
group-join verify page):

```text
Confirm Your Booking Request

Hi {{firstName}}, thanks for your booking request for {{CLUB_NAME}}'s lodge.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

Please confirm your email address so the club can review your request. Your request will not be reviewed until you confirm.

Confirm My Email: {{BASE_URL}}/join/verify/{{token}}

This link expires on {{expiresAt}}. If you did not make this request, you can safely ignore this email and the request will be deleted.
```

Triggers and frequency:

- Non-member group join (`src/lib/group-booking.ts`): when a non-member uses a join code to claim a spot on a group booking, they must confirm their email before the join proceeds. Link expires after 48 hours. One email per join attempt.

### group-settlement-receipt

Subject:

```text
Your group booking is settled — {{CLUB_NAME}}
```

Body:

```text
Your Group Booking Is Settled

Hi {{firstName}}, thanks for settling your group's stay at {{CLUB_NAME}}'s lodge. Everyone you are paying for is now confirmed.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Joiners settled: {{joinerCount}}
Total paid: {{total}}

Each joiner has been emailed to confirm their spot. There is nothing more for them to pay.

If anything looks wrong, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Group settlement success (`src/lib/group-settlement.ts`, Stripe webhook path): after an organiser-pays combined payment settles. One receipt to the organiser per settlement.

### group-join-settled

Subject:

```text
Your spot is confirmed — {{CLUB_NAME}}
```

Body:

```text
Your Spot Is Confirmed

Hi {{firstName}}, {{organiserName}} has settled the cost of your stay at {{CLUB_NAME}}'s lodge as part of their group booking. Your spot is confirmed and there is nothing for you to pay.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Guests: {{guestCount}}

If you have any questions about your stay, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Same group settlement success as `group-settlement-receipt`: one email per joiner booking covered by the organiser's settled payment.

### group-settlement-expired

Subject:

```text
Your group payment expired — {{CLUB_NAME}}
```

Body:

```text
Your Group Settlement Has Expired

Hi {{firstName}}, the combined payment you started for your group's stay at {{CLUB_NAME}}'s lodge was not completed in time, so the beds held for your joiners have been released.

Check-in: {{checkIn}}
Check-out: {{checkOut}}
Joiners affected: {{joinerCount}}
Amount not charged: {{total}}

No money has been taken. If your group still plans to come, restart the payment from your group booking page — the beds are subject to availability.

If anything looks wrong, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- `POST /api/cron` (group-settlement-reaper job): when an organiser's started combined payment is not completed in time and the held joiner beds are released. One email to the organiser per expired settlement.

### group-join-released

Subject:

```text
Your held spot has been released — {{CLUB_NAME}}
```

Body:

```text
Your Held Spot Has Been Released

Hi {{firstName}}, {{organiserName}} started a combined payment for your stay at {{CLUB_NAME}}'s lodge but it was not completed in time, so your held bed has been released.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

Your booking is back to awaiting payment. If the group still plans to come, the organiser can restart the payment — or check with them about what happens next.

If you have any questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- Same group-settlement-reaper sweep as `group-settlement-expired`: one email per joiner whose held bed was released; the joiner's booking returns to awaiting payment.

### group-join-cancelled

Subject:

```text
Your group booking has been cancelled — {{CLUB_NAME}}
```

Body:

```text
Your Group Booking Has Been Cancelled

Hi {{firstName}}, the combined group payment {{organiserName}} started for your stay at {{CLUB_NAME}}'s lodge was never completed, so your pending booking has now been cancelled. Nothing has been charged to you.

Check-in: {{checkIn}}
Check-out: {{checkOut}}

If you still want to come, you can make your own booking for these dates — or talk to the organiser about starting a fresh group trip.

If you have any questions, contact the club at {{SUPPORT_EMAIL}}.
```

Triggers and frequency:

- `POST /api/cron` (group-settlement-reaper job, terminal stage, #1094): when a reaped organiser-pays place is never retried and the joiner's pending booking is cancelled. One email per cancelled joiner booking.

## Hardcoded Messages (Not In The Admin-Editable Registry)

Only one live sender keeps its subject and body wording fixed in code
(`src/lib/email/*.ts` plus `src/lib/email-templates.ts`). It has no
`EMAIL_TEMPLATE_DEFINITIONS` entry in `src/lib/email-message-registry.ts`, so
`/admin/notifications` cannot edit its wording — two-factor codes are
security-sensitive and stay out of the admin-editable registry by design. The
sync contract test (`src/lib/__tests__/email-message-registry.test.ts`) keeps
the `###` sections above in exact lockstep with the editable registry — this
entry uses a `####` heading so it stays out of that contract. Do not promote it
to `###` without also registering it for admin editing (that is feature work,
not a docs change).

#### two-factor-code

Subject:

```text
Your {{CLUB_NAME}} two-factor code
```

Body:

```text
Two-factor code

Hi {{firstName}},

Use this code to finish signing in to your {{CLUB_NAME}} booking account:

{{code}}

This code expires on {{expiresAt}}. If you did not try to sign in, change your password and contact the club.
```

Triggers and frequency:

- `POST /api/auth/2fa/email/send`: when a member with email two-factor enabled requests a sign-in code during login. Per request; codes expire after 10 minutes. Rate limited (shared two-factor limiter).
