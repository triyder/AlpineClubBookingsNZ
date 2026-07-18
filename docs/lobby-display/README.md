# Lobby TV Display

> Part of the [documentation hub](../README.md).

**A live, self-updating lodge noticeboard — the whiteboard that keeps itself current.**

Pair a TV's browser with the booking system and it shows guests and hut leaders
what's happening in the lodge: who's arriving, departing and staying over the
coming days, who's in which room, today's chores, and arrival information like
wifi details and check-in reminders. Everything on screen is driven by data the
system already holds — nothing to manually update, safe to hang on a public
wall and forget.

> **Status:** built and integrated on the `feature/lobby-display-v2` branch,
> awaiting the end-to-end owner review before the single upstream PR. The
> authoring model was rebuilt to the Layout / Template / Module design
> ([ADR-003](decisions/ADR-003-layout-template-authoring-model.md)); the v2
> rebuild spans the schema, render pipeline, admin hub, previews, seeds, and
> config-transfer — far more than the original MVP task list.
> Delivery is tracked in [epic hoppers99#25](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/25);
> the feature was proposed and discussed in
> [upstream discussion #964](https://github.com/thatskiff33/AlpineClubBookingsNZ/discussions/964#discussioncomment-17602129).

## Why

Most club lodges run a lobby whiteboard: room assignments, arrivals, reminders —
hand-written, and stale the moment bookings change. The kiosk (an interactive
tablet) covers check-in and chores for the person standing at it; the lobby TV
is its complement — a **dynamic but non-interactive** display the whole room can
read at a glance, always matching the booking system.

## What it does

- **Entirely data-driven, zero upkeep** — bookings, room assignments, chore
  rosters, and lodge content come straight from live system data. No second
  content system to maintain: once paired and configured, the screen stays
  correct as bookings change.
- **Simple device pairing** — point any TV browser (or a Raspberry Pi) at the
  site, confirm a short code from a logged-in device; displays are per-lodge,
  read-only, individually revocable, and survive reboots without anyone typing
  credentials on a remote.
- **Live occupancy views** — arrivals/departures/stays for the next few days:
  room-grouped when bed allocation is on, by-booking when it's off, and a
  whole-lodge view for full-lodge/group bookings.
- **Chores on screen** — the day's chore list and assignments from the existing
  roster data.
- **Lodge rules & arrival info** — club-authored content plus per-lodge values
  (e.g. `{{config:wifi-code}}`) editable without a deploy.
- **Committee notice board** — a free-text notice, edited by permitted admins,
  for reminders that don't live in booking data.
- **Templates, not hardcoding** — pick from provided layouts, configure what
  each screen area shows; panels rotate only when they make sense (e.g. the
  whole-lodge view appears only while the lodge actually has a full-lodge
  booking).
- **Admin preview** — administrators can open any device's board or any
  template full-screen in their own browser (read-only, same privacy rules,
  no effect on the device's "last seen") before it ever reaches a lobby wall.
- **Privacy-aware by design** — configurable name granularity (full name /
  first name + initial / first name / counts only), enforced at the data
  layer so no template can display more than the API serves; bookings that
  include children always collapse to a family label, and organisations
  (schools) show their group name only.
- **Optional module** — feature-flagged off by default; clubs that don't enable
  it see nothing.
- **Later** — skifield weather/conditions panel reusing the existing conditions
  widget.

## Design gallery

Selected concepts from the design exploration (mock data throughout — every
name, booking, and contact detail is fictional). The full interactive catalogue
is in [`mockups/`](mockups/) — open [`mockups/index.html`](mockups/index.html)
locally (download the folder, or serve it with any static file server) to
browse all variants and iterations.

### Everyday board — booking bars

The bread-and-butter view: each booking is one continuous bar across the nights
it covers, carrying its check-out date; bars wrap to show up to five names, then
"+N".

![Everyday board — booking bars](mockups/screenshots/everyday-bar-board.png)

### Whole-lodge bookings — blockout

When a group books the entire lodge (no room assignment), the board shows the
group label only — with a rotating variant that alternates blockout and welcome
panels.

![Whole-lodge blockout concepts](mockups/screenshots/whole-lodge.png)

![Whole-lodge rotating welcome](mockups/screenshots/whole-lodge-rotating.png)

### Full house of singles — by booking

When allocation is per-person, rows group by booking and room, each guest
keeping their own check-out date.

![Singles by booking](mockups/screenshots/singles-by-booking.png)

![Full lodge occupancy variants](mockups/screenshots/full-lodge-occupancy.png)

## Design documents

| Document | What it covers |
|---|---|
| [`brief.md`](brief.md) | The feature brief: goals, non-goals, settled decisions, open questions, success criteria |
| [`design.md`](design.md) | Technical design: data model, pairing/auth, display-state API, Layout/Template/Module model (with diagrams + a worked example), testing strategy |
| [`operating.md`](operating.md) | Runbook to set up a screen (pair, assign a template, per-lodge config) and a developer guide to extending (add a module / condition) |
| [`phone-visibility.md`](phone-visibility.md) | Member phone-number opt-in (#37): the two-sided consent gate, the staff-kiosk exemption, and where each control lives |
| [`config-transfer-workflow.md`](config-transfer-workflow.md) | Moving display config between environments as bundles |
| `decisions/` | ADRs (pairing/auth model; template model + storage) — authored with their keystone tasks |
| [`mockups/`](mockups/) | The full design-exploration catalogue, organised by concept |

## Delivery

Built and validated end-to-end on this fork: child tasks (see the
[epic](https://github.com/hoppers99/AlpineClubBookingsNZ/issues/25)) branch from
and merge into `feature/lobby-display-v2`, each passing the full validation gate.
When the feature is complete and proven, it is proposed upstream as a single
PR. Feedback is welcome at any stage — the epic and the
[upstream discussion](https://github.com/thatskiff33/AlpineClubBookingsNZ/discussions/964#discussioncomment-17602129)
are the places for it.
