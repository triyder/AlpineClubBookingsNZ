# Multi-Lodge Support

This directory tracks the design and delivery of multi-lodge support for
AlpineClubBookingsNZ: the ability for the club to operate more than one
physical lodge property (rooms, beds, capacity, pricing, chores, lockers)
under one club, membership, and finance backend.

The club currently operates two lodges, with a plausible future third. The
data model targets an arbitrary number of lodges rather than hardcoding two,
since the FK/scoping shape is the same either way.

## Current State

There is no `Lodge` model today. Rooms, beds, seasons/rates, cancellation and
minimum-stay policy, booking periods, chores, and several settings tables
(`LodgeSettings`, `BedAllocationSettings`, `BookingDefaults`,
`BookingRequestSettings`) are implicit club-wide singletons. Capacity is a
single scalar derived by summing all active beds; pricing is one rate table
keyed by season and age tier with no property dimension. See
[ADR-001](decisions/ADR-001-lodge-entity-and-scoping-model.md) for the full
inventory.

Membership, authentication (other than the `LODGE` staff access role),
Xero/finance integration, and payments are expected to remain club-wide and
are out of scope for lodge-scoping unless a specific need is identified.

## Delivery Plan

Work is sequenced so schema/service-layer changes land and prove out before
UI is retrofitted, and so the highest-risk piece (capacity and booking
transactions) gets isolated review rather than being bundled with lower-risk
work. The full phase breakdown, risk labels, and standing rules live in
[implementation-plan.md](implementation-plan.md); the short version:

0. **Decisions** — complete; owner decisions recorded in ADR-001.
1. **Lodge entity** and the `multiLodge` Admin Module flag (default OFF)
   gating lodge management (ADR-002).
2. **Scoping migrations** — `lodgeId` FKs and singleton-to-per-lodge
   conversions, staged per `BLUE_GREEN_MIGRATION_POLICY.md`.
3. **Capacity, pricing, and booking-transaction core** — the critical
   phase; per-lodge capacity and locks, lodge-filtered pricing.
4. **Access scoping and booking eligibility** — staff and member grants
   per lodge.
5. **Chores and roster** per lodge.
6. **Promo codes** with optional lodge scope.
7. **Admin UI retrofit** — one lodge-picker pattern applied across pages.
8. **Member UI and communications** — booking-flow lodge step, emails,
   copy.
9. **Validation and soak** — staged multi-lodge enablement per
   [test-plan.md](test-plan.md).

Each numbered phase is one or more separate PRs, not one large change.
Single-lodge behaviour is preserved at every merge point: the data model
is core, but lodge management sits behind the `multiLodge` Admin Module
(default OFF), and member-facing UI only changes once a second active
lodge actually exists (ADR-002).

## Documents

- [feature-overview.md](feature-overview.md) — what the feature does and
  how it behaves for members, admins, hut leaders, and finance. Start
  here for intent; the ADRs record why.
- [implementation-plan.md](implementation-plan.md) — phased delivery plan
  with risk labels and standing rules.
- [lodge-scoping-contract.md](lodge-scoping-contract.md) — which models are
  lodge-scoped, which stay club-wide, and the service rules. Update it
  before changing any model's scoping.
- [test-plan.md](test-plan.md) — required automated coverage and manual
  staging verification.
- [contract-release.md](contract-release.md) — the consolidated runbook for
  the phase-2 contract release (NOT NULL enforcement, policy-table
  null-partition partial unique indexes, `EmailMessageSetting` lodge-column
  drop): items, preconditions, sequencing, and migration-ledger entries.

## ADRs

- [ADR-001: Lodge entity and foreign-key scoping model](decisions/ADR-001-lodge-entity-and-scoping-model.md)
- [ADR-002: Core data model, not a module](decisions/ADR-002-core-data-model-not-a-module.md)
- [ADR-003: Lodge configuration hub over a lodge-centric navigation restructure](decisions/ADR-003-lodge-configuration-hub.md)
- [ADR-004: Cross-lodge waitlist opt-in](decisions/ADR-004-cross-lodge-waitlist.md)

## Maintenance Rules

- Do not add a `lodgeId` column or a new lodge-scoped table ad hoc; follow
  the entity shape and migration sequencing in ADR-001, or update the ADR
  first if the approach changes.
- Keep Xero/finance mappings club-wide unless a follow-up ADR records a
  decision to split them, consistent with the existing preference for one
  shared operational Xero connection
  (`docs/finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`).
  Money stays in integer cents and booking dates stay NZ date-only
  regardless of lodge scoping.
- Update this README and the relevant ADR in the same PR as any change to
  the lodge data model or delivery plan.
