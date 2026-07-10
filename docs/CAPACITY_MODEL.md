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

Double-bed shared occupancy (#1701) does **not** change any of this. A shared
`DOUBLE` counts as **one** bed of `activeBedCount`, and its two declared-partner
occupants are two guests / two person-nights against the ceiling — exactly as if
they slept in two beds. Availability (`checkCapacityForGuestRanges`) counts
guests against `getLodgeCapacity`, never `BedAllocation` rows, so a second
occupant is purely a *placement* detail and cannot inflate or deflate capacity.

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
resolved figure and its `source`, and the capacity field warns live when the
value entered is below the active bed count (it will cap the lodge). The
allocation board still shows all physical beds; a capped lodge simply leaves
some beds unbooked.

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
