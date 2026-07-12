# Lobby TV Display — Feature Brief

**Status:** Living document — decisions marked settled are settled; open
questions are flagged. Decomposed into
[epic hoppers99#25](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/25).
See [`README.md`](README.md) for the feature overview and design gallery, and
[`design.md`](design.md) for the technical design.

---

## Problem and who it serves

Guests arriving at a lodge currently have no ambient, glanceable view of who is
arriving, departing, and staying, or of practical arrival information (wifi,
check-in reminders). Clubs typically run a lobby whiteboard for this — hand
written and stale the moment bookings change. A lobby TV per lodge shows the
next few days of lodge activity so guests can orient themselves without
touching the kiosk, and hut leaders can see the shape of the coming days at a
glance.

Audiences: arriving/staying guests (primary), hut leaders (secondary), the
booking officer (configures it, wants it low-maintenance).

## Goal

A read-only, per-lodge lobby display: a paired TV/device renders an
admin-chosen template of lodge activity and arrival information, driven by live
booking data, safe to show in a public physical space.

**Core principle — entirely data-driven.** Everything on screen derives from
data the system already holds (bookings, room assignments, chore rosters, lodge
instructions, per-lodge config). There is no display-specific content to author
or keep current beyond template choice and config values: once a screen is
paired and configured, it stays correct as bookings change, with zero ongoing
upkeep. The display introduces no second source of truth. (The one deliberate
exception is the committee notice board — an explicitly authored, admin-edited
free-text surface.)

## Non-goals

- Not interactive: no check-in, no editing, no touch input. The kiosk remains
  the interactive surface.
- Not a replacement for the kiosk, the admin lodge page, or lodge instructions.
- No new booking/membership behaviour — display only.
- Not a general digital-signage product: no arbitrary media playlists, no
  third-party content; scope is lodge activity + club-authored notes.
- No native app / hardware management beyond "a browser pointed at a URL".

## Operating context

- Public physical screen in a lodge lobby: anyone standing in the room can read
  it. This makes the display a **privacy surface** — what names appear, and at
  what granularity, is a first-class design concern, not styling.
- One or more display devices per lodge; a lodge might later add a second
  screen in another room.
- The device is a dumb browser (smart TV browser, Raspberry Pi, mini-PC). It
  must survive reboots and network blips without someone entering credentials
  on a TV remote.
- Multi-lodge aware from day one: every piece of data is lodge-scoped using the
  existing kiosk lodge-resolution machinery.

## Functional scope

### 0. Displayable content (v1 targets)

The display must be able to show, per lodge:

- **Bookings and room assignments** — in all three occupancy modes: bed
  allocation enabled (room-grouped views), allocation disabled (by-booking
  views), and whole-lodge/group bookings (blockout view, booking/group name
  only).
- **Chore list / assignments** — the day's roster, from the existing chore
  assignment data.
- **Lodge rules and arrival information** — club-authored content (lodge
  instructions / notes), plus lodge-specific values via config tokens (wifi
  code, check-in reminders).
- **Committee notice board** — free-text notice edited by suitably permitted
  admins (epic child LTV-011).
- **Skifield weather/conditions** — *later addition*: reuses the existing
  `{{skifield-conditions}}` embed; not a v1 blocker.

### 1. Display-state API (the data contract)

A read-only, lodge-scoped endpoint serving one JSON payload per lodge covering
the display window:

- Window dates (default 3 days out; window size configurable).
- Rooms and room assignments where allocation is enabled; whole-lodge /
  unallocated flag where it is not (e.g. school groups booking the entire
  lodge).
- Bookings with guests, stay ranges (check-in/check-out dates, including stays
  extending beyond the window), grouped by booking and room.
- Occupancy counts (arriving / departing / staying per day).
- Chore assignments for the window (names privacy-reduced like guest names).
- Lodge rules / arrival-information content, the notice board, and config
  values (see §3).

**Privacy is enforced at this layer.** Names are serialised already reduced to
the configured granularity (see §7). No template, module, or custom markup can
display more than the API serves. All layouts in the
[design gallery](README.md#design-gallery) are pure functions of this payload —
it is the single data contract everything renders from.

### 2. Display modules (embed tokens)

Extends the existing `{{token}}` catalogue (`src/lib/token-catalogue.ts`) with
a new **`lodge-display` token context** and a family of parameterised **embed
modules** — the same pattern as `{{skifield-conditions}}`:

- `{{display-arrivals-board:days=3}}` — the everyday bar board
  (arrivals/departures/staying bars, up to 5 names then "+N", check-out dates).
- `{{display-occupancy-grid}}` — whole-lodge blockout grid.
- `{{display-welcome}}` — rotating welcome panel content.
- `{{display-singles-board}}` — by-booking rows for all-singles occupancy
  (Room | Guest style).
- `{{display-chores-board}}` — the day's chore list and assignments.
- `{{display-lodge-rules}}` — lodge rules / arrival information.
- `{{display-notice-board}}` — the committee notice (LTV-011).
- `{{skifield-conditions}}` — already exists; gains the `lodge-display`
  context later.
- Text tokens for simple values: `{{lodge-name}}`, `{{display-date}}`, plus
  the config tokens in §3.

Module design principles:

- **Good defaults, options on top.** Each module renders sensibly with zero
  parameters; parameters tune behaviour (`days=3`, grouping, which columns).
- **Options-based styling.** Modules expose a small set of styling options
  (e.g. row colouring rules, accent placement, corner radius) rather than
  requiring CSS.
- The [mockups](mockups/) are the built-in modules' reference renderings.

### 3. Per-lodge config tokens

A per-lodge JSON config glob (admin-editable), e.g.
`{"wifi-code": "alpine1234", "checkin-note": "Check in at the kiosk before 8pm"}`,
whose keys resolve as text tokens in display templates:

- Syntax: `{{config:wifi-code}}` — reuses the existing `{{token:parameter}}`
  grammar (consistent with `{{lodge-capacity:lodge-slug}}`); no new parser.
- Keys are free-form (validated: key format, value length caps); values are
  plain text, escaped on render.
- Lets operators add lodge-specific dynamic values to any template region
  without code changes.
- Storage: new JSON field or small model keyed by lodge (architect decision).
- Unresolved keys render as an explicit placeholder (not silently blank) so
  misconfiguration is visible on the screen during setup.

Scope is **per-lodge only** (settled): `{{config:key}}` resolves from the
device's bound lodge.

### 4. Template model

Two layers (settled):

- **Templates define structure.** A template is a named set of regions (e.g.
  header band / main / footer band, or a two-panel split) plus the config
  options each region exposes. Provided templates ship in code — the approved
  mockups become the starter set — and more can be added in code over time. A
  technical operator can author a **custom template** (advanced path); a custom
  template still declares regions, so the admin configuration surface stays
  uniform regardless of who authored the template.
- **Region configuration populates a template.** Per region, admins place
  modules/tokens and set their options (§2) — the everyday path; no HTML
  required. The device binding stores which template it uses plus its region
  configuration.
- **Rotation is template-level and condition-aware.** A region may hold a
  rotation of panels; each panel declares an eligibility condition evaluated
  against the display-state payload (e.g. the whole-lodge blockout panel is
  eligible only while a whole-lodge booking is in the window; a welcome panel
  is always eligible). Ineligible panels are skipped, so a screen never rotates
  into a view that is wrong for the current data. Device-level playlists (a
  device cycling whole templates) are out of v1 scope.
- Templates/bindings are **DB-stored, admin-editable**, following the
  page-content / `EmailTemplateOverride` pattern: code defaults, DB overrides,
  no deploy needed to tweak a screen.
- Config-transfer compatibility: DB templates and lodge config globs should be
  exportable/importable via the config-transfer system in a follow-up if not
  day one.

### 5. Device pairing and display auth

A new, read-only auth surface — deliberately weaker-privileged than any
existing tier:

- **Pairing flow:** admin creates a display device record; the TV browser
  visits the display URL and shows a short pairing code; admin confirms the
  code in the admin UI (from any logged-in device, e.g. a phone); the TV
  receives a long-lived display token (httpOnly cookie or equivalent).
- Display token grants access **only** to the display-state API and display
  page for its bound lodge. It cannot reach kiosk, member, or admin routes.
  Read-only by construction.
- Devices are individually **revocable** from the admin UI; tokens are stored
  hashed; last-seen tracked so a dead screen is visible to admins.
- Survives reboot/network blips without re-auth; re-pairing required only on
  revocation or expiry.
- Feature-flagged via `ClubModuleSettings` (as kiosk/multiLodge are) so clubs
  that don't want it see nothing.

### 6. Admin UI

Modelled on the kiosk account management page (`/admin/lodge`):

- Device list per lodge: name, lodge binding, paired/unpaired state, last
  seen, revoke.
- Pair-new-device flow (enter/confirm pairing code).
- **Per-device template assignment** — each device selects which template it
  renders (two screens in one lodge can show different views).
- Template management: list built-ins, copy to custom, edit regions/tokens,
  preview (rendered with live-ish data, reusing the read-only preview pattern
  from the kiosk per-account preview work).
- Lodge config glob editor (the §3 JSON), with token-help copy derived from
  the catalogue as elsewhere.

### 7. Name-privacy setting

Configurable granularity for how guest names appear on the public screen
(club-wide default, per-lodge override):

- **Settled:** enforcement lives in the display-state API serialiser (§1),
  never in templates — no template can display more than the API serves.
- **Not locked in — exact naming rules to be settled during design/build:**
  - Granularity levels (working set): full name / full first name + surname
    initial (mockup default) / first name only / counts only.
  - Candidate: family bookings collapse to the family name (e.g. "Smith
    family +4") rather than listing individuals — a possible mechanism for
    keeping minors off the screen.
  - Candidate: school/group bookings display the booking/group name rather
    than individual names.
  - Intent (firm even while mechanics are open): minors should not be
    individually named on a public screen.

## Data and technical shape (sketch — firmed by ADRs)

- `LodgeDisplayDevice` model: id, lodgeId, name, pairing state, hashed token,
  template binding, last seen, revoked.
- Display template storage: code-default registry + DB override model.
- Per-lodge config: JSON field or keyed model.
- New display tier/guard in the lodge-auth layer, reusing the kiosk
  lodge-scoping; ambiguous bindings deny (per the established kiosk
  precedent).
- Display page: full-screen route rendering the bound template at 16:9,
  container-query sizing, dedicated display stylesheet sharing club branding
  tokens (palette/logo) with the site.
- Refresh: periodic poll of the display-state API (interval configurable; no
  websockets needed for v1); stale-data indicator if the last fetch is old.

**ADRs expected** (in [`decisions/`](decisions/)): (1) display device
pairing/auth model; (2) template model + storage.

## Constraints and invariants

- NZ English throughout (UI copy, docs).
- Booking dates remain NZ date-only lodge nights; no money surfaces on the
  display.
- Reuse kiosk data-scoping and lodge-resolution; no parallel scoping logic.
- Idempotent, read-only: the display surface performs no writes (beyond its
  own pairing/last-seen bookkeeping).
- Docs in lockstep; full validation gate; migration drift check for schema
  changes.
- Fork delivery on integration branch `feature/lobby-display`; single upstream
  PR at the end (owner approval before raising; merge-commit only).

## Risks

- **Privacy (highest):** guest names on a public screen. Mitigations:
  name-granularity setting, API-layer enforcement, minors/group intent,
  lodge-scoped data, weakest-privilege display token.
- **New auth surface:** pairing/token flow must not become a side door to
  kiosk/member data. Mitigations: separate tier, route allow-list, hashed
  revocable tokens, ADR + high-effort review on the auth task.
- **Schema/migrations:** additive only; drift-checked.
- **Upstream fit:** feature must be genuinely generic (any club, any lodge
  count) and feature-flagged off by default.

## Feature-level success criteria

1. A TV with no credentials can be paired by an admin in under a minute and
   thereafter renders its lodge's display unattended across reboots.
2. The display shows the next N days of arrivals/departures/stays for its
   lodge only, accurate against bookings, with names at the configured
   granularity — verified against the approved mockup layouts.
3. A revoked device renders nothing lodge-related within one refresh interval.
4. An admin can switch a device's template, tune module options, and change
   the wifi code via config tokens — all without a deploy.
5. With the module flag off, no display routes, UI, or tokens are reachable.
6. Full gate green; docs updated; single upstream PR raised with owner
   approval.

## Settled decisions (2026-07-11)

1. **Authoring model:** region-based, two-layer — provided templates define
   regions + region config populates them; technical operators can author
   custom templates (which still declare regions); more provided templates
   addable over time. No free-form-HTML-only mode.
2. **Rotation:** template-level, condition-aware panels (eligibility evaluated
   against display-state; ineligible panels skipped). Device-level playlists
   deferred.
3. **Config glob scope:** per-lodge only. `{{config:key}}` resolves from the
   device's bound lodge.
4. **Committee notice board:** in scope as a dedicated free-text notice edited
   by suitably permitted admins (LTV-011).

## Open questions (recommendations standing unless overruled)

1. **Styling option depth for v1:** minimal set (row colouring rules, accent
   side, corner radius) vs a broader theme editor. Recommendation: minimal,
   expand on demand.
2. **Window size bounds:** default 3 days; what maximum (privacy: how far
   ahead should a public screen reveal who is coming)? Recommendation: cap at
   7 days pending a privacy call.
3. **Panel-condition grammar:** how expressive are rotation eligibility
   conditions — a fixed set of named conditions (v1 recommendation: `always`,
   `whole-lodge-booking-in-window`, `arrivals-today`, `no-guests`) vs a
   general expression language (deferred).
4. **Exact naming/minors rules:** which granularity levels ship, whether
   family bookings collapse to family name, and how group bookings are
   labelled (see §7 — intent is firm, mechanics are not). Settled within the
   privacy task (LTV-003) before the display-state serialiser is built. Full
   names as a selectable level, per owner input on the upstream discussion.

## Artefacts and links

- Feature overview + design gallery: [`README.md`](README.md)
- Technical design: [`design.md`](design.md)
- Mockup catalogue: [`mockups/`](mockups/) (open `index.html` locally; all
  data fictional)
- Delivery epic: [hoppers99#25](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/25)
- Upstream heads-up + discussion:
  [thatskiff33 discussion #964](https://github.com/thatskiff33/AlpineClubBookingsNZ/discussions/964#discussioncomment-17602129)
- Related feature (separate from this epic): member phone-number visibility
  opt-in — [hoppers99#37](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/37)
- Pattern precedents: `src/lib/token-catalogue.ts` (tokens/embeds),
  `EmailTemplateOverride` (code default + DB override), kiosk per-account
  preview (upstream PR #1721, read-only admin preview).
