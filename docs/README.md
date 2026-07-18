# Documentation

This is the documentation hub for AlpineClubBookingsNZ. It is organised
**audience-first**: find your role below, follow its "Start here" path, then
branch into the reference and feature docs. Every document in `docs/` is
reachable from this page, directly or through a feature hub.

New to the docs? Read [`STYLE_GUIDE.md`](STYLE_GUIDE.md) to see how these pages
are written and structured, and [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) for
what is and is not yet documented per admin area.

## Pick your audience

| You are… | Start here |
| --- | --- |
| **Adopting / forking** the platform for your club | [New Adopters](#new-adopters) |
| **Operating** a live club day to day | [Operators](#operators) |
| **Developing** / changing the code | [Developers](#developers) |
| An **automated agent** (Claude Code, Codex) | [Agents](#agents) |

---

## New Adopters

Evaluating or configuring a fork for your own club.

**Start here, in order:**

1. [`../README.md`](../README.md) — product scope, stack, and quick setup.
2. [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md) — configure a fork for
   your own club.
3. [`../CONFIGURATION.md`](../CONFIGURATION.md) — the environment and
   `config/club.json` reference.
4. [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — read before putting a shared or
   production environment online. (This file lives at the repository root, not
   in `docs/`.)
5. [`UPGRADING.md`](UPGRADING.md) — how to take downstream releases into your
   fork.

Then skim [Developers](#developers) for the architecture and [Operators](#operators)
for the runbooks you will use once you are live.

## Operators

Running a live club: admins, treasurers, and committee members.

**Start here:** [`../DEPLOYMENT.md`](../DEPLOYMENT.md) for bootstrap and
blue/green deployment, then the runbook for whatever you are doing.

Per-area, task-focused **operator guides** (with screenshots) are being produced
under issue #2050 on the foundation this hub establishes. See
[`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) for the per-admin-area status; the
guides that have landed are linked below.

**Bookings & capacity guides** (batch 1 — the booking lifecycle, capacity/beds,
seasons, promos, and booking money):

- [Bookings](guides/bookings.md) — the master booking list, filters, and
  availability calendar.
- [Book on Behalf](guides/book.md) — create a booking for a member or
  non-member.
- [Booking Requests](guides/booking-requests.md) — approvals, locked-period
  change requests, and public (non-member) requests. (Also covers the
  `booking-approvals` and `booking-change-requests` routes, which redirect
  here.)
- [Booking Policies](guides/booking-policies.md) — cancellation refunds,
  date-specific periods, group discount, minimum stay, and public-request
  settings.
- [Booking Messages](guides/booking-messages.md) — member-facing booking,
  payment, and cancellation copy.
- [Bookings Setup](guides/bookings-setup.md) — the rooms/beds and booking-copy
  setup hub.
- [Seasons](guides/seasons.md) — season windows per lodge.
- [Age Groups](guides/age-tier-settings.md) — membership age tiers and their
  booking rules.
- [Promo Codes](guides/promo-codes.md) — discount codes and vouchers.
- [Bed Allocation](guides/bed-allocation.md) — the drag-and-drop bed board.
- [Waitlist](guides/waitlist.md) — the waitlist queue and force-confirm.
- [Payments](guides/payments.md) — the booking-payment ledger and Xero invoice
  state.
- [Reports](guides/reports.md) — occupancy, revenue, and member analytics.

**Membership & applications guides** (batch 2 — members, applications,
family/committee, the membership lifecycle, and membership billing):

- [Members](guides/members.md) — the member directory, search, CSV import,
  roles, seasonal membership, and merge.
- [Member Applications](guides/member-applications.md) — the join/nomination
  review queue and how approval maps people to member records.
- [Member Fields](guides/member-fields.md) — which extra profile fields are
  collected from members and applicants.
- [Membership Types](guides/membership-types.md) — seasonal membership
  categories, their booking and subscription policy, and roll-forward.
- [Membership & Members setup](guides/membership-setup.md) — the setup hub for
  types, fields, and subscription lockout.
- [Subscription Lockout](guides/subscription-lockout.md) — the unpaid-subscription
  booking lockout, financial year, and Xero paid-detection.
- [Cancellation Requests](guides/membership-cancellations.md) — the membership
  cancellation and archive review queue, plus the cancellation copy/Xero
  settings.
- [Committee](guides/committee.md) — committee roles, assignments, and the
  public contact routing.
- [Family Groups](guides/family-groups.md) — households, the billing member, and
  the family-link request queue.
- [Family Suggestions](guides/family-suggestions.md) — auto-detected family
  groupings to confirm or dismiss.
- [Induction](guides/induction.md) — the induction register, sign-offs, and
  induction settings.
- [Deletion Requests](guides/deletion-requests.md) — member self-service
  deletions and admin-initiated hard-delete review (two-admin rule).
- [Lockers](guides/lockers.md) — locker inventory and member allocation
  (lodge-scoped).
- [Fees](guides/fees.md) — the consolidated hut, joining, and annual fee console
  and family billing. (Also covers the `fee-configuration` route, which
  redirects here.)
- [Subscriptions](guides/subscriptions.md) — annual membership-fee billing,
  family billing mode, and manual mark-paid.
- [Refunds & Credits](guides/refund-requests.md) — the refund-appeal and
  credit-approval review queue.
- [Internet Banking](guides/internet-banking.md) — bed holds and lead-time rules
  for Xero-invoiced bank-transfer payments.
- [Xero Sync](guides/xero.md) — the Xero connection, sync, reconciliation
  ledger, and records browser.

Until the remaining batches land, use the reference docs below for other areas.

- [`../DEPLOYMENT.md`](../DEPLOYMENT.md) — bootstrap and blue/green deployment
  reference (repository root).
- [`UPGRADING.md`](UPGRADING.md) — downstream release upgrades for deployment
  forks.
- [`PRODUCTION_UPGRADE_RUNBOOK.md`](PRODUCTION_UPGRADE_RUNBOOK.md) — owner-driven
  runbook for upgrading a live deployment across a release (pre-flight backup,
  blue/green migrate, post-upgrade checklist, and rollback).
- [`BLUE_GREEN_MIGRATION_POLICY.md`](BLUE_GREEN_MIGRATION_POLICY.md) — how
  migrations must be structured for safe cutover.
- [`CANCELLATIONS.md`](CANCELLATIONS.md) — membership cancellation refund,
  credit-note, and GST policy.
- [`AUTHORITATIVE_FEES.md`](AUTHORITATIVE_FEES.md) — membership/entrance fee
  schedules, public listing review, and family billing exceptions.
- [`AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](AUDIT_RETENTION_ARCHIVE_RUNBOOK.md) —
  audit-log retention and optional archival.
- [`TOKEN_HASHING.md`](TOKEN_HASHING.md) — the current hash-at-rest token design.
- [`XERO_MEMBER_GROUPING_RUNBOOK.md`](XERO_MEMBER_GROUPING_RUNBOOK.md) —
  operating the Xero member-grouping cutover.
- [`PUBLIC_PAGE_CONTENT_TOKENS.md`](PUBLIC_PAGE_CONTENT_TOKENS.md) — content
  editor/operator guide for publishing authoritative membership, fee, booking,
  and cancellation blocks.
- [`MAINTENANCE.md`](MAINTENANCE.md) — the public validation and release
  checklist, and the documented operator CLIs.
- [`STAGING_ACCESSIBILITY.md`](STAGING_ACCESSIBILITY.md) — non-production browser
  and Lighthouse checks.
- [`LOAD_TESTING.md`](LOAD_TESTING.md) — the k6 HTTP load harness in
  [`../load/`](../load/README.md), thresholds, and safety rails.

## Developers

Changing the code.

**Start here:** [`ARCHITECTURE.md`](ARCHITECTURE.md) for the runtime shape,
module boundaries, data model, integrations, cron jobs, and the mermaid maps.

**Domain and review map:**

- [`DOMAIN_INVARIANTS.md`](DOMAIN_INVARIANTS.md),
  [`STATE_MACHINES.md`](STATE_MACHINES.md),
  [`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md), and
  [`UX_FLOW_MAP.md`](UX_FLOW_MAP.md) — the domain and review map used by issue
  work.
- [`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md) — the advisory-lock
  families (capacity, credit, member-night, single-domain), what each protects,
  and the ordering disciplines. Read before changing any lock key or capacity/
  credit write path.
- [`CAPACITY_MODEL.md`](CAPACITY_MODEL.md) — how each lodge's bookable capacity
  is decided in every configuration.

**Testing, security, and workflow:**

- [`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md) — the Playwright browser E2E suite
  driving the Critical journeys against the staging compose stack.
- [`SECURITY-ATTACK-SURFACE.md`](SECURITY-ATTACK-SURFACE.md) and
  [`SECURITY.md`](SECURITY.md) — the attack-surface map and security notes
  (see also [`../SECURITY.md`](../SECURITY.md) for the disclosure policy).
- [`ONGOING_DEVELOPMENT_WORKFLOW.md`](ONGOING_DEVELOPMENT_WORKFLOW.md) — how
  generic public changes and private deployment-fork changes flow.
- [`STYLE_GUIDE.md`](STYLE_GUIDE.md) — documentation style, the operator-guide
  skeleton, and screenshot/mermaid/linking conventions. Follow it whenever you
  add or change docs.
- [`COVERAGE_MATRIX.md`](COVERAGE_MATRIX.md) — every admin route area mapped to
  its documentation or gap.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — validation commands and the
  dead-code (knip) gate.

**Authoritative in-code references:** the TypeScript registry in
[`../src/lib/email-message-registry.ts`](../src/lib/email-message-registry.ts)
is the catalogue of admin-editable outbound email templates, approved tokens,
and subject/body safety rules.

## Agents

Automated coding agents working in this repository.

**Start here:** [`../AGENTS.md`](../AGENTS.md) — the agent contract and the
source of truth. [`../CLAUDE.md`](../CLAUDE.md) highlights the parts that matter
most for an interactive Claude Code session.

- [`agents/CODEX_WORKFLOW.md`](agents/CODEX_WORKFLOW.md) — the operating guide for
  Codex agents.
- [`agents/ISSUE_WORKFLOW.md`](agents/ISSUE_WORKFLOW.md) — issue contracts.
- [`agents/CODEX_PROMPTS.md`](agents/CODEX_PROMPTS.md) — invocation prompts.
- [`agents/PROFILE_GUIDE.md`](agents/PROFILE_GUIDE.md) — execution profiles.
- [`agents/SUBAGENT_GUIDE.md`](agents/SUBAGENT_GUIDE.md) — subagent use.
- [`agents/REVIEW_SEVERITY.md`](agents/REVIEW_SEVERITY.md) — review severity.
- [`agents/PROMPT_INJECTION_GUIDE.md`](agents/PROMPT_INJECTION_GUIDE.md) —
  prompt-injection handling.

---

## Feature hubs

Larger subsystems keep their own hub. Each links back to this page.

- **Finance dashboard** — reporting contracts, architecture decisions, data
  contracts, and test plan. Start with
  [`finance-dashboard/README.md`](finance-dashboard/README.md).
- **Multi-lodge support** — design, scoping contract, implementation plan, and
  test plan for more than one lodge property. Start with
  [`multi-lodge/README.md`](multi-lodge/README.md).
- **Lobby display** — the lobby/kiosk display subsystem brief, design, and
  operating guide. Start with [`lobby-display/README.md`](lobby-display/README.md).
- **Operational Xero** — module map, reconciliation-ledger data model, and
  sequence diagrams for the outbound, inbound, and repair flows. Start with
  [`xero/ARCHITECTURE.md`](xero/ARCHITECTURE.md).
- **Configuration export & import (planned)** — decision records for the
  portable configuration/content/lodge-setup tool. Start with
  [`config-transfer/README.md`](config-transfer/README.md).
- **Exclusive whole-lodge hold (design)** —
  [`exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md`](exclusive-booking/decisions/ADR-001-exclusive-whole-lodge-hold.md).

## Release notes

Per-release notes and the owner-review communication drafts are indexed in
[`releases/README.md`](releases/README.md) (newest first — currently
[`releases/v0.12.0.md`](releases/v0.12.0.md)).
