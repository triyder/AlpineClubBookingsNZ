# Documentation Coverage Matrix

Audience: Developer, Agent (workplan input)

This matrix enumerates **every admin route area** under
`src/app/(admin)/admin/*` and records, for each, the reference documentation
that exists today and whether a dedicated **operator guide** (per the skeleton
in [`STYLE_GUIDE.md`](STYLE_GUIDE.md)) exists yet.

It is the authoritative workplan input for the operator-guide programme (issue
#2050). "Reference coverage" means architecture/runbook prose that describes the
behaviour; it is **not** the same as a task-focused operator guide with
screenshots. Almost every area therefore shows an operator-guide **GAP** today —
that is expected: #2049 lays the foundation and #2050 fills the gaps.

The area list is generated from the actual route directories (69 areas,
excluding `__tests__`), so it is exhaustive and will not silently miss a
surface. When a new admin area is added, add a row here in the same PR (this is
part of the docs-lockstep rule in `AGENTS.md`).

**Where the guides go:** every operator guide lands in **`docs/guides/`**, one
file per area named after the route (`docs/guides/bookings.md`), per
[`STYLE_GUIDE.md`](STYLE_GUIDE.md) ("Where operator guides live"). When you fill
a `GAP`, replace it with a relative link to that file (e.g.
`[guide](guides/bookings.md)`).

## How to read the columns

- **Area** — the route directory, i.e. `/admin/<area>`.
- **Permission area** — the `ADMIN_PERMISSION_AREAS` bucket it resolves to (see
  `ARCHITECTURE.md` → "Admin and Lodge"). Useful for grouping guides.
- **Reference coverage** — existing doc(s) that describe the behaviour, or `—`.
- **Operator guide** — `GAP` (no guide yet, planned in #2050), or a link once
  the guide lands.
- **Batch** — which #2050 delivery batch (1–4) this admin area belongs to; see
  [Delivery batches](#delivery-batches-2050) below. (Batch 5, member-facing
  journeys, is the public/member surface and has no admin rows here.)

## Matrix

| Area (`/admin/…`) | Permission area | Reference coverage | Operator guide | Batch |
| --- | --- | --- | --- | --- |
| `access-roles` | support | `ARCHITECTURE.md` (access roles / definitions) | GAP | 4 |
| `age-tier-settings` | bookings | `ARCHITECTURE.md`, `AUTHORITATIVE_FEES.md` | GAP | 1 |
| `appearance` | content | — | GAP | 4 |
| `audit-log` | support | `AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` | GAP | 4 |
| `background-jobs` | support | `ARCHITECTURE.md` (Cron Jobs) | GAP | 4 |
| `bed-allocation` | bookings | `ARCHITECTURE.md` (bed allocation), `CAPACITY_MODEL.md` | GAP | 1 |
| `book` | bookings | — (admin book-on-behalf) | GAP | 1 |
| `booking-approvals` | bookings | `STATE_MACHINES.md` | GAP | 1 |
| `booking-change-requests` | bookings | `STATE_MACHINES.md` | GAP | 1 |
| `booking-messages` | support | — | GAP | 1 |
| `booking-policies` | bookings | `ARCHITECTURE.md` (booking policies), `CANCELLATIONS.md` | GAP | 1 |
| `booking-requests` | bookings | `ARCHITECTURE.md` (public booking requests) | GAP | 1 |
| `bookings` | bookings | `ARCHITECTURE.md` (booking/payment flow), `STATE_MACHINES.md` | GAP | 1 |
| `bookings-setup` | bookings | — | GAP | 1 |
| `chores` | lodge | — | GAP | 3 |
| `committee` | membership | `ARCHITECTURE.md` (committee roles/assignments) | GAP | 2 |
| `communications` | membership | `src/lib/email-message-registry.ts` | GAP | 4 |
| `config-transfer` | support | `config-transfer/README.md` (planned feature) | GAP | 4 |
| `dashboard` | overview | `ARCHITECTURE.md` (Needs Attention / badges) | GAP | 4 |
| `deletion-requests` | membership | `ARCHITECTURE.md` (member lifecycle delete) | GAP | 2 |
| `display` | content | `lobby-display/README.md`, `lobby-display/operating.md` | Feature hub (extend in #2050) | 4 |
| `email-deliverability` | support | `ARCHITECTURE.md` (email), email registry | GAP | 4 |
| `email-messages` | support | `src/lib/email-message-registry.ts` | GAP | 4 |
| `family-groups` | membership | `ARCHITECTURE.md` (family groups / billing) | GAP | 2 |
| `family-suggestions` | membership | `ARCHITECTURE.md` (hidden family suggestions) | GAP | 2 |
| `fee-configuration` | finance | `AUTHORITATIVE_FEES.md` | GAP | 2 |
| `fees` | finance | `AUTHORITATIVE_FEES.md` | GAP | 2 |
| `health` | support | — | GAP | 4 |
| `hut-leaders` | lodge | `ARCHITECTURE.md` (hut-leader auto-assign cron) | GAP | 3 |
| `image-manager` | content | — | GAP | 4 |
| `induction` | membership | — | GAP | 2 |
| `integrations` | support | `CONFIGURATION.md`, `DEPLOYMENT.md` | GAP | 4 |
| `internet-banking` | finance | `ARCHITECTURE.md` (Internet Banking), `xero/ARCHITECTURE.md` | GAP | 2 |
| `issue-reports` | support | `ARCHITECTURE.md` (issue reports / stuck states) | GAP | 4 |
| `lockers` | membership | — | GAP | 2 |
| `lodge` | lodge | `ARCHITECTURE.md` (lodge kiosk / operations) | GAP | 3 |
| `lodge-instructions` | lodge | `src/lib/token-catalogue.ts`, `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP | 3 |
| `lodges` | lodge | `multi-lodge/README.md`, `multi-lodge/feature-overview.md` | Feature hub (extend in #2050) | 3 |
| `member-applications` | membership | `ARCHITECTURE.md` (membership application / nominations) | GAP | 2 |
| `member-fields` | membership | — | GAP | 2 |
| `members` | membership | `ARCHITECTURE.md` (members, CSV import, roles) | GAP | 2 |
| `membership-cancellation` | membership | `CANCELLATIONS.md` | GAP | 2 |
| `membership-cancellations` | membership | `CANCELLATIONS.md`, `ARCHITECTURE.md` (cancellation review queue) | GAP | 2 |
| `membership-setup` | membership | `ARCHITECTURE.md` (membership types) | GAP | 2 |
| `membership-types` | membership | `ARCHITECTURE.md` (seasonal membership types) | GAP | 2 |
| `modules` | support | `CONFIGURATION.md` (module flags) | GAP | 4 |
| `mountain-conditions` | content | — | GAP | 4 |
| `notification-recipients` | support | `ARCHITECTURE.md` (email / notifications) | GAP | 4 |
| `notification-rules` | support | `ARCHITECTURE.md` (email / notifications) | GAP | 4 |
| `notifications` | support | email registry, `ARCHITECTURE.md` (email) | GAP | 4 |
| `page-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP | 4 |
| `payments` | finance | `ARCHITECTURE.md` (Stripe), `finance-dashboard/README.md` | GAP | 1 |
| `promo-codes` | bookings | `ARCHITECTURE.md` (promo codes / redemptions) | GAP | 1 |
| `refund-requests` | finance | `CANCELLATIONS.md`, `ARCHITECTURE.md` (refund recovery) | GAP | 2 |
| `reports` | finance | `finance-dashboard/README.md` | GAP | 1 |
| `rooms-beds` | lodge | `CAPACITY_MODEL.md`, `ARCHITECTURE.md` (bed inventory) | GAP | 3 |
| `roster` | lodge | `ARCHITECTURE.md` (roster/chores) | GAP | 3 |
| `seasons` | bookings | `ARCHITECTURE.md` (seasons / season rates) | GAP | 1 |
| `security` | support | `SECURITY.md`, `docs/SECURITY.md` | GAP | 4 |
| `setup` | support | `CONFIGURATION.md`, `IMPLEMENTATION_GUIDE.md` | GAP | 4 |
| `site-banners` | content | `ARCHITECTURE.md` (SiteBanner) | GAP | 4 |
| `site-content` | content | `PUBLIC_PAGE_CONTENT_TOKENS.md` | GAP | 4 |
| `site-style` | content | — | GAP | 4 |
| `stuck-states` | support | `ARCHITECTURE.md` (stuck-state dashboard) | GAP | 4 |
| `subscription-lockout` | finance | `ARCHITECTURE.md` (subscription lockout) | GAP | 2 |
| `subscriptions` | finance | `ARCHITECTURE.md` (membership subscription billing) | GAP | 2 |
| `waitlist` | bookings | `ARCHITECTURE.md` (waitlist), `E2E_PLAYWRIGHT.md` | GAP | 1 |
| `work-parties` | lodge | — | GAP | 3 |
| `xero` | finance | `xero/ARCHITECTURE.md`, `XERO_MEMBER_GROUPING_RUNBOOK.md` | GAP | 2 |

## Summary

- **69** admin route areas total.
- **2** areas are already served by a **feature hub** (`display` → lobby-display,
  `lodges` → multi-lodge). #2050 should extend, not duplicate, those hubs.
- **~16** areas have **no reference coverage at all** (`—` above): `appearance`,
  `book`, `booking-messages`, `bookings-setup`, `chores`, `health`,
  `image-manager`, `induction`, `lockers`, `member-fields`,
  `mountain-conditions`, `site-style`, `work-parties`, and the thin
  `*-setup`/config surfaces. These are the highest-value operator-guide targets.
- **Every** area needs a task-focused operator guide (with screenshots) — none
  exist yet. That is the #2050 deliverable; this file is its checklist.

### Notes vs the ~20 gaps the initial audit named

The audit's gap list mapped cleanly onto real route dirs with two nuances worth
flagging for #2050 scoping:

- **"school-bookings" is not its own route area.** School group handling is a
  behaviour spread across `bookings`, `booking-requests`, and the
  `school-attendee-confirmations` cron (`ARCHITECTURE.md`), not a
  `/admin/school-bookings` page. Cover it as a cross-cutting topic within the
  bookings-cluster guide rather than expecting a standalone page.
- **"membership-types/setup" is two adjacent routes**, `membership-types` and
  `membership-setup` (plus `member-fields`). Decide in #2050 whether they are
  one guide or three; they share the Membership permission area.
- The audit under-counted: there are **69** areas, not ~20 — the ~20 was the
  "obviously uncovered" subset. This matrix is the exhaustive version.

## Delivery batches (#2050)

The operator-guide programme ships in **five batches**. Every admin row above
carries its batch number in the **Batch** column, so an orchestrator can derive
a batch's worklist directly from this file (filter the table by batch). Batches
1–4 are admin areas; batch 5 is the member-facing/public surface, which has no
`/admin/*` rows and is scoped separately below.

| Batch | Theme | Scope | Admin areas |
| --- | --- | --- | --- |
| **1** | Bookings & capacity | The booking lifecycle, capacity/beds, seasons, promos, and booking money (payments, booking reports). | 15 |
| **2** | Membership & applications | Members, applications, family/committee, membership lifecycle & cancellations, and membership billing (fees, subscriptions, refunds, Xero, internet banking). | 20 |
| **3** | Lodge operations | Physical-lodge day-to-day: rooms/beds inventory, chores, roster, work parties, hut leaders, lodge kiosk/instructions, and multi-lodge management. | 8 |
| **4** | Comms & content | Outbound comms (email/notifications), public content & appearance, and the platform/support admin surfaces (access roles, audit, security, health, modules, integrations, setup, config-transfer, dashboard). | 26 |
| **5** | Member-facing journeys | The public and member-facing routes (`/`, booking flow, member dashboard, applications, self-service) — **not** admin areas, so not enumerated in the matrix above. Scope this batch from `UX_FLOW_MAP.md` and the public route tree, not from this table. | — |

To pull one batch's admin worklist, take every row whose **Batch** equals that
number. Batch sizes: **1 → 15**, **2 → 20**, **3 → 8**, **4 → 26** (total 69).
Where a permission area does not map 1:1 to a batch (finance splits between batch
1 booking-money and batch 2 membership-billing; support/content platform surfaces
sit in batch 4), the Batch column is authoritative — read it, don't re-derive
from the permission area.
