# ADR-002: Core Data Model With a Module-Gated Configuration Surface

## Status

Accepted (owner direction, 2026-07-02). Implemented on
`feature/multi-lodge-support`: the `Lodge` table is core and always seeded,
the `multiLodge` Admin Module (default OFF) gates only the lodge-management
configuration routes, the module cannot be disabled while more than one
active lodge exists, and the single-lodge presentation rule is enforced and
test-covered.

## Context

AlpineClubBookingsNZ has an Admin Modules system (`ClubModuleSettings`,
`src/config/modules.ts`, `src/config/feature-routes.ts`) used for optional
features such as kiosk, chores, bed allocation, and the finance dashboard.
Modules work by boolean flags that gate route families: when a module is
off, its routes return 404 through the proxy/module gates and its UI is
hidden. Modules are presentation and route-level switches over a shared
core data model.

Multi-lodge support is a different shape. It adds a dimension (`lodgeId`)
to core booking data — bookings, rooms, capacity, seasons, pricing — that
every booking read/write must respect. A route-prefix toggle cannot express
"this booking belongs to lodge A"; there is no meaningful state where the
multi-lodge data model is "off" once bookings carry a lodge.

However, the `bedAllocation` module establishes a useful precedent: rooms
and beds are core schema, while the module flag gates only the
configuration surface (`/admin/rooms-beds`, `/admin/bed-allocation`). The
same split works here.

## Decision

Split the concern in two: the data model is core, and the ability to
configure multiple lodges is an Admin Module.

### Core schema and service layer (not module-gated)

- The `Lodge` table always exists and always has at least one active row.
  Fresh installs seed one lodge; the migration backfills existing
  deployments to one lodge (ADR-001).
- All lodge-scoped reads and writes require a `lodgeId` unconditionally.
  There is no "module off" code path in capacity, pricing, or booking
  logic — single-lodge clubs are simply clubs whose `Lodge` table has one
  row.
- **Single-lodge presentation rule:** when exactly one active lodge
  exists, the UI must look and behave as it does today — no lodge selector
  in the booking flow, no lodge picker on admin pages, no lodge column in
  lists. The lodge dimension appears in the UI only when a second active
  lodge is added. This keeps the public project's out-of-box experience
  unchanged for single-lodge clubs, which are the common case.

### `multiLodge` Admin Module (configuration surface only)

- A new `multiLodge` module flag (default OFF, a "capability" module like
  `kiosk` and `bedAllocation`) gates the lodge-management admin routes:
  creating a second lodge, renaming, deactivating, and per-lodge settings
  pages that only make sense with several lodges.
- Clubs that leave the module off keep their single seeded lodge and never
  see lodge management, selectors, or copy. They do not have to think
  about lodges at all.
- Enabling the flag exposes configuration but does not by itself change
  member-facing behaviour; only actually creating a second active lodge
  does (the presentation rule keys off lodge count, not the flag).
- The module cannot be disabled while more than one active lodge exists,
  so a multi-lodge club can never strand itself without the UI to manage
  its lodges. Runtime booking logic never reads the flag — bookings at
  existing lodges keep working regardless of its state.

### Module boundary for everything else

- Existing modules that touch lodge-scoped data (kiosk, chores, bed
  allocation, lockers) keep their module flags exactly as today. The flags
  remain club-wide switches; whether a club has one lodge or three, the
  chores module is on or off for the whole club. Per-lodge module state is
  out of scope until a real need is identified.

## Consequences

### Positive

- No dual code paths: capacity, pricing, and booking logic have one shape,
  always lodge-scoped, which is simpler to test and keeps the invariant
  surface small.
- Single-lodge clubs (including upstream and every existing fork) see no
  behaviour change and no new configuration burden; with the module off,
  nothing lodge-related is even discoverable in admin.
- The module flag doubles as the rollout gate: the schema and service
  changes can merge and soak in production while the flag stays off,
  before a second lodge is ever created. No temporary "coming soon" guard
  is needed.
- Module semantics stay clean and consistent with `bedAllocation`:
  modules gate configuration surfaces and route families, not data
  dimensions.

### Negative

- Every lodge-scoped service function takes a mandatory `lodgeId` even in
  single-lodge deployments — slightly more ceremony at call sites for
  clubs that never add a second lodge.
- The single-lodge presentation rule adds a conditional to member and
  admin UI ("show the selector only when active lodge count > 1") that
  needs its own test coverage, as does the module-state validation
  (cannot disable with more than one active lodge).
- Downstream forks with schema customisations must take a real migration,
  not opt out via a module flag.
