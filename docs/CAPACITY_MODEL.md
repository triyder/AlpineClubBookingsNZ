# Lodge Capacity Model

How a lodge's bookable capacity is decided, in every configuration. The single
source of truth is `getLodgeCapacityStatus` in `src/lib/lodge-capacity.ts`;
`getLodgeCapacity` returns just the number and every booking, availability,
finance, cron, and content-token path reads through it, so the rules below apply
uniformly.

## Two distinct quantities

- **Physical bed inventory** — `LodgeBed` rows in the lodge's `LodgeRoom`s,
  counted when the **Bed Allocation** module is on (`activeBedCount`). This is
  the set of beds guests are *placed into* by bed allocation.
- **Maximum sleeping capacity** — the per-lodge `LodgeSettings.capacity` value
  (editable on the lodge admin page). This is the *ceiling* on how many guests
  the lodge may sleep, independent of how many beds are installed.

A lodge can legitimately have more beds than it may sleep — e.g. extra beds
crammed into a room, but a lower whole-lodge cap for fire / consent / licence
reasons (#1653). Booking availability must respect the **ceiling**, while
bed allocation still places people across the **larger** physical bed set.

Double-bed shared occupancy (#1701) does **not** change the base figure. A
shared `DOUBLE` counts as **one** bed of `activeBedCount`, and availability
(`checkCapacityForGuestRanges`) counts guests against `getLodgeCapacity`,
never `BedAllocation` rows. What a shareable double adds is **partner-shared
headroom** on top of that base figure — see the dedicated section below
(#1745): extra admissions only the admin-initiated partner flow can use, so a
second occupant still cannot inflate what ordinary bookings see.

## Partner-shared double-bed headroom (#1745)

A shareable `DOUBLE` can sleep a second occupant (the primary's CONFIRMED
partner, #1742/#1744), so each active DOUBLE contributes one **partner-shared
slot** above the base capacity — **reserved and bounded**, not a blanket
ceiling bump:

- **Reserved:** only the admin-initiated partner-shared admission
  (`checkCapacityForPartnerSharedAdmission`, `src/lib/capacity.ts`) can use
  the slots; every public/member/system path keeps reading the unchanged
  base `getLodgeCapacity`. An ordinary guest can never be admitted into
  partner headroom. Initiation is admin-only (#1746): the admin edit-booking
  panel offers the confirmed partners of the booking's member guests as
  "partner (shares a double bed)" quick-adds (server-computed,
  `listBookingPartnerSharingCandidates` in `double-bed-sharing.ts`), and the
  modify/modify-quote routes accept the matching `partnerSharedGuests` flags
  from admins only — gated at route AND service, so the reserved slots are
  unreachable from member self-service. A rejected flag surfaces the check's
  reason verbatim and never falls back into the #1668 overbook confirm.
- **Bounded:** at most `activeDoubleBedCount` shared admissions per night.
  Each admitted sharer must hold a CONFIRMED partner link with a member
  staying every requested night (`mayShareDoubleBed` stays the single source
  of truth for the pair rule), and the partner must hold an ordinary,
  base-backed place: a sharer can never anchor another sharer, coverage from
  the same proposal must come from a non-sharing guest row carrying the
  partner's memberId, and otherwise coverage is read from the partner's
  capacity-holding bookings. Under those guards every shared admission maps
  to a distinct double, so a feasible placement always exists — though
  producing it stays the allocation board's job and may mean moving unlocked
  allocations. Known residual: a partner admitted above base via the #1668
  over-capacity override can anchor a sharer; combining the two admin
  overrides can exceed pairing feasibility (both are explicit admin acts,
  and forced overage otherwise only *shrinks* headroom — it counts as
  consumed shared slots).
- **Ceiling interplay (#1653):** an explicit `LodgeSettings.capacity` is a
  maximum *sleeping* capacity (fire/consent/licence) and binds people, not
  beds. Headroom is therefore
  `max(0, min(activeDoubleBedCount, capacity − activeBedCount))` when a
  capacity is set: a `capped_beds` lodge gets **no** partner headroom, and a
  capacity between `beds` and `beds + doubles` allows only the gap. With no
  explicit capacity, headroom = `activeDoubleBedCount`.
- **Resolution:** `getLodgePartnerSharedCapacityStatus`
  (`src/lib/lodge-capacity.ts`) returns the base status plus
  `activeDoubleBedCount` and `partnerSharedHeadroom`. It is a separate
  resolver so ordinary availability checks pay no extra query.

Per-night admission rule (owner decision, #1745): admit if a base slot is
free, OR the guest is an eligible partner-sharer **and**
`sharedSlotsUsed < partnerSharedHeadroom` for that night. Occupancy already
above the base ceiling counts as used shared slots.

**Stale-pair sweep interplay (#1756):** when a pair breaks (partner link
dissolved, member deactivated, ADULT→minor tier correction),
`sweepFuturePartnerSharedAllocations` removes the pair's future
`isSecondOccupant` *placements* — deliberately NOT the second occupant's
`BookingGuest` row, which stays on its booking in the awaiting-allocation
queue for an admin to resolve. Shared-slot accounting is occupancy-derived
(guest-nights above base), never `BedAllocation`-derived, so the sweep cannot
corrupt it: the swept guest keeps conservatively consuming their shared slot
(the same treatment as #1668 forced overage) until the admin removes them
from the booking or re-admits them. The reserved slot is therefore never
silently double-granted — a new couple's admission is refused while the
stale guest still occupies the headroom, and frees the moment the guest
leaves the booking — and `getLodgePartnerSharedCapacityStatus` (bed
inventory + ceiling) is untouched by the sweep by construction.

Two conservative implementation choices sit on top of that decided rule
(ratified via the #1745 PR review rather than the issue text): the ceiling
interplay above (an explicit capacity always wins, so a capped lodge gets no
headroom), and fail-loud sharers — a proposed sharer whose pair is not
CONFIRMED-linked, or whose partner misses any requested night, rejects the
whole proposal outright instead of silently falling back to an ordinary
slot the admin did not intend.

| Active beds | of which DOUBLE | Capacity set | Base figure | Partner headroom |
|---|---|---|---|---|
| 10 | 1 | unset | 10 (`configured_beds`) | 1 |
| 10 | 2 | 11 | 10 (`configured_beds`) | 1 |
| 10 | 2 | 10 | 10 (`configured_beds`) | 0 |
| 10 | 2 | 8 | 8 (`capped_beds`) | 0 |
| 0 (module off) | — | 30 | 30 (`capacity_override`) | 0 |

The admin lodge **Capacity** card shows the figure broken out — e.g.
"10 beds + up to 1 partner spot" — never a single combined number, so an
admin can see the extra is partner-only.

## Resolution

Effective capacity is decided in this order:

1. **Bed Allocation on, ≥1 active bed** → the beds are the inventory and the
   capacity value is a ceiling. Effective capacity = **`min(activeBedCount,
   capacity)`**:
   - capacity unset, or ≥ bed count → `activeBedCount` (source
     `configured_beds`).
   - capacity set below bed count → `capacity` (source `capped_beds`); the
     surplus beds stay available for allocation but cannot be booked into.
2. **Bed Allocation off, or on with no active beds** → the per-lodge
   `LodgeSettings.capacity` (source `capacity_override`).
3. **Neither** → for the club's default lodge only, the club-config bed total
   (`club.json` beds, source `club_config`). Additional lodges resolve to **0**
   (source `unconfigured_lodge`) so a freshly created lodge is unbookable rather
   than overbookable until configured.

Only an **explicit** per-lodge capacity acts as a ceiling. The club-config
fallback is never a ceiling, so enabling Bed Allocation on the default lodge
keeps using the bed count unless a capacity is set.

## Scenario table

| Bed Allocation | Active beds | Capacity set | Effective capacity | `source` |
|---|---|---|---|---|
| Off | — | 30 | 30 | `capacity_override` |
| Off | — | unset (default lodge) | club-config total | `club_config` |
| Off | — | unset (additional lodge) | 0 | `unconfigured_lodge` |
| On | 0 | 30 | 30 | `capacity_override` |
| On | 0 | unset (additional lodge) | 0 | `unconfigured_lodge` |
| On | 40 | unset | 40 | `configured_beds` |
| On | 40 | 40 | 40 | `configured_beds` |
| On | 40 | 50 (≥ beds) | 40 | `configured_beds` |
| On | 40 | 30 (< beds) | **30** | `capped_beds` |

## Admin surface

On the lodge admin page (`/admin/lodges/[id]`) the **Capacity** card shows the
resolved figure and its `source` — with any partner-shared headroom broken
out (`"10 beds + up to 1 partner spot"`, plus a short partner-only
explainer; #1745) — and the capacity field warns live when the value entered
is below the active bed count (it will cap the lodge). The allocation board
still shows all physical beds; a capped lodge simply leaves some beds
unbooked.

## Exceeding the ceiling (admin overbook overrides)

The resolved figure is a hard block for members: no member-facing path can
create or grow a booking past it. Admins can exceed it only through an
explicit, audited confirmation, via two distinct contracts:

The **warn-and-confirm contract** (`OverCapacityConfirmationRequiredError` →
409 `OVER_CAPACITY_CONFIRM_REQUIRED` → resubmit with
`confirmOverCapacity: true`, `capacityOverridden` audited):

- **admin date-edit override** (#1668) — `booking-modify-plan` /
  date-modification service under `adminOverride`;
- **admin on-behalf create** — retroactive (#1695) and forward-dated
  (#1767) creates on `/admin/book`, with two carve-outs: a create that
  opted into the waitlist fallback keeps the capacity-exceeded outcome and
  waitlists instead, and a non-member hold-eligible (PENDING) party keeps
  the hard block (v1 — the hold cron re-checks capacity with no knowledge
  of the override and would silently bump the confirmed booking).

The **explicit-overbook-flag contract** (409 `CAPACITY_EXCEEDED` +
`overbookDates`, resubmit with the overbook flag; separate audit actions):

- **confirm-pending-guests** on the booking detail page (#1366, flag under
  the advisory-locked re-check);
- **waitlist force-confirm** — "Confirm Anyway (Overbook)" on
  `/admin/waitlist` (`allowOverbook`, audited as
  `waitlist.force_confirmed_overbook`).

Partner-shared admissions (#1745/#1746) are *not* overrides — they consume
reserved headroom and reject rather than falling back into a confirm.

**Known limitation (all override surfaces):** the payment-time capacity
re-checks (`markBookingPaymentSucceeded`, payment links) and the
non-member-hold cron do not consult any override marker, so an overridden
booking that is still unpaid can be cancelled (and refunded) when payment
arrives while the lodge remains over capacity on its nights. $0 and
credit-covered overridden creates settle at create time and are unaffected.
Tracked as a follow-up: persisting the override on the booking and honouring
it in the re-check paths.

## Behaviour change (introduced with #1653)

Previously, when Bed Allocation was on with beds configured, an
`LodgeSettings.capacity` value was **ignored** — the bed count always won. It is
now honoured as a ceiling. A lodge that had both beds configured **and** a
capacity set *below* its bed count will see its bookable capacity drop to that
value. See `docs/UPGRADING.md` for the operator check.

To find affected lodges before upgrading (read-only):

```sql
SELECT r."lodgeId",
       COUNT(b.*) FILTER (WHERE b.active) AS active_beds,
       s.capacity
FROM "LodgeRoom" r
JOIN "LodgeBed" b ON b."roomId" = r.id
LEFT JOIN "LodgeSettings" s
  ON s.id = r."lodgeId" OR (s.id = 'default' AND (s."lodgeId" IS NULL OR s."lodgeId" = r."lodgeId"))
GROUP BY r."lodgeId", s.capacity
HAVING s.capacity IS NOT NULL
   AND s.capacity < COUNT(b.*) FILTER (WHERE b.active);
```

Any row returned is a lodge whose capacity will now be capped below its bed
count. Confirm that is intended (it usually is — that is the point of #1653).
