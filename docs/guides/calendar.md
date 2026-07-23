# Events Calendar

Audience: Operator

## What it is

A club-wide events calendar for meetings, working bees, social events, and
committee video meetings. It shows a Google-style month view and is available in
two places:

- **Admin → Lodge Operations → Calendar** (`/admin/calendar`) — for admins.
- The member **Events** card on the dashboard → **Events Calendar** (`/calendar`)
  — for every logged-in member.

Both surfaces render the same calendar; what differs is whether the viewer can
change anything.

The calendar is always on — there is no module toggle to enable it.

## Who can do what

| Action                  | Members (ordinary) | Committee members | Admins with lodge **edit** |
| ----------------------- | ------------------ | ----------------- | -------------------------- |
| View read-only calendar | ✅ read-only       | ✅                | ✅                         |
| Create an event         | ❌                 | ✅                | ✅                         |
| Edit an event           | ❌                 | ✅                | ✅                         |
| Delete an event         | ❌                 | ✅                | ✅                         |
| Open video-meeting link | ❌                 | ✅                | ✅                         |

- **Everyone who can log in** sees the calendar. Ordinary members get a
  read-only view: opening an event shows its details with only a **Close**
  button — no Save or Delete.
- **Committee members** may add, edit, and delete events. "Committee member"
  means the member holds at least one **active** committee assignment under an
  active committee role (**Admin → Members → [member] → Committee**, managed on
  the [Committee](committee.md) page). This is the one place a committee
  assignment grants an app privilege — everywhere else it is public contact
  metadata only.
- **Admins** with the **lodge edit** permission may also add, edit, and delete
  events (the calendar sits in the lodge permission area, like Work Parties and
  the Roster). Lodge **view** only is read-only.

The gate is enforced on the server for every create/edit/delete, so the buttons
a member cannot use are never shown — and even a stale page could not save.

> To check why a specific person can or cannot edit, run
> `npx tsx scripts/diagnose-calendar-access.ts their@email` — it prints their
> permission matrix, committee assignments, and the final decision.

## Step-by-step

### View the calendar

1. Open **Admin → Lodge Operations → Calendar**, or the **Events** card on the
   member dashboard.
2. Use **‹ ›** to move month to month, **Today** to jump back, and click any
   event chip to see its details. A ↻ icon marks a repeating event; a camera
   icon marks a video meeting.

### Create an event

1. Click **New event** (or click an empty day cell).
2. Fill in:
   - **Title** (required).
   - **All-day event**, or a **Date** with **Start time** and optional
     **End time**.
   - **Repeat** (see [Recurring events](#recurring-events) below).
   - **Location** and **Details** (both optional).
   - **Video meeting (MiroTalk)** — tick to attach a meeting link (see
     [Video meetings](#video-meetings-mirotalk)).
3. Click **Create event**.

### Edit or delete an event

1. Click the event, then change fields and **Save changes**, or **Delete**.
2. For a **repeating** event you are asked whether the change applies to **This
   event only** or **All events in the series** — see below.

## Recurring events

Set **Repeat** on an event to make it recur. The options are labelled from the
chosen date:

- **Daily**
- **Weekly on {weekday}**
- **Monthly on day {N}** (e.g. the 15th; clamps to the last day in shorter
  months)
- **Monthly on the {nth} {weekday}** (e.g. the 3rd Tuesday of every month)

You can also set **Repeat every N** (e.g. every 2 weeks) and an **Ends**
condition: **Never**, **On date**, or **After N times**. An open-ended ("Never")
series is generated for about two years ahead (capped at 366 occurrences); pick
an end date or a count for a specific span.

Each occurrence is stored as its own event, so it appears on every month it
falls in and each video meeting gets its own room link.

### Editing one occurrence vs the whole series

When you save or delete a repeating event you choose the scope:

- **This event only** — changes just that occurrence and marks it as an
  exception, so later series-wide edits leave it alone.
- **All events in the series** — applies to every occurrence. Changing the
  details or time updates them all (each keeps its own date); changing the
  **repeat pattern** (frequency, interval, end, or moving the day) rebuilds the
  series from the edited occurrence, preserving any exceptions you made.

Turning **Repeat** back to **Does not repeat** on a whole-series edit collapses
the series to a single event. Setting **Repeat** on an existing one-off event
converts it into a series.

## Video meetings (MiroTalk)

Ticking **Video meeting (MiroTalk)** on an event attaches a self-hosted
[MiroTalk](https://github.com/miroslavpejic85/mirotalk) meeting. Committee
members and admins then see an **Open meeting link** button on the event that
launches the meeting in a new tab; ordinary members do not (meetings are for the
people running them).

The app never embeds MiroTalk — it links out to it. Each meeting event stores an
unguessable room slug, and the join URL is built server-side as
`${MIROTALK_URL}/join/<room>`, so the same event resolves to the right host in
each environment.

### Installing MiroTalk

MiroTalk is a **separate service** you self-host; it is not bundled with this
app. Point the app at it with one environment variable:

| Variable                   | What it is                         | Default                 |
| -------------------------- | ---------------------------------- | ----------------------- |
| `MIROTALK_URL`             | Base URL of your MiroTalk instance | `http://localhost:3010` |
| `NEXT_PUBLIC_MIROTALK_URL` | Legacy fallback (build-time only)  | —                       |

- **Prefer `MIROTALK_URL`.** The join link is built server-side, so this is a
  **runtime** setting: set it in the app's environment and restart — no rebuild.
- `NEXT_PUBLIC_MIROTALK_URL` is still read as a fallback, but `NEXT_PUBLIC_*`
  values are inlined at **build time**, so a runtime `.env` change won't move a
  pre-built image — use `MIROTALK_URL` instead.
- **Include the scheme** — e.g. `https://meet.example.org`. A value with no
  scheme is assumed to be `https://` (a bare host would otherwise produce a
  broken relative link). Trailing slashes are ignored.

**Local development (Windows/macOS/Linux with Docker):**

```bash
docker run -d --name mirotalk-p2p -p 3010:3000 \
  -e API_KEY_SECRET=dev-secret-change-me \
  -e JWT_KEY=dev-jwt-change-me \
  mirotalk/p2p:latest
```

Open `http://localhost:3010` to confirm your camera and mic work (WebRTC is
allowed on `localhost` without HTTPS). Leave `MIROTALK_URL` unset to use the
`http://localhost:3010` default, then create a meeting event and click
**Open meeting link**.

**Production (single VM behind Caddy):**

1. Run MiroTalk as its own container on its **own subdomain** — e.g.
   `meet.<yourdomain>` — never iframed into the app (the app's security headers
   block camera/mic and framing on the main domain by design).
2. Reverse-proxy the subdomain through Caddy so it gets a TLS certificate, and
   give that subdomain a `Permissions-Policy` that **allows** `camera` and
   `microphone` (the app's main site deliberately disables them).
3. Set `MIROTALK_URL=https://meet.<yourdomain>` for the app (runtime env, then
   restart — no rebuild).
4. For members joining from home, run a **TURN server** (MiroTalk bundles
   coturn) and open its ports on the VM firewall (3478 UDP/TCP, 5349), so
   participants behind restrictive networks can connect.
5. For groups larger than ~6–8 people, use **MiroTalk SFU** (`mirotalk/sfu`)
   instead of P2P; it scales better but also needs a UDP media-port range opened
   on the firewall and the VM's public IP announced. See the club's video-meeting
   rollout notes for the SFU specifics.

Keep the MiroTalk image **unmodified** and separate (it is AGPL-licensed); the
app only links to it, which keeps the licence boundary clean.

### Secure, login-free join (JWT tokens)

If your MiroTalk is host-protected (`HOST_PROTECTED=true`, `HOST_USER_AUTH=true`
with `HOST_USERS`), members would normally hit a login prompt. Set the variables
below and the app appends a **short-lived signed `?token=`** to each meeting
link, so committee members join straight in while unauthorised people (who never
get the link, and could not forge a token) stay out. The token is minted fresh
per page load and the signing key never reaches the browser.

| Variable | What it is |
| --- | --- |
| `MIRO_JWT_KEY` | Must equal MiroTalk's own `JWT_KEY`. |
| `MIRO_MEETING_USERNAME` / `MIRO_MEETING_PASSWORD` | Must match one entry in MiroTalk's `HOST_USERS` (MiroTalk re-checks these). |
| `MIRO_MEETING_PRESENTER` | `true` = every joiner is a host; `false` (default) = the first to join hosts, the rest are participants. |
| `MIRO_JWT_EXP` | Token lifetime — `1h` (default), `30m`, `900` (seconds), etc. Minted fresh on each page load, so this only bounds a link left unopened. |

**On the MiroTalk side** nothing structural changes — you already have
`JWT_KEY`, `HOST_PROTECTED`, `HOST_USER_AUTH`, and `HOST_USERS`. Just make sure
the app's `MIRO_JWT_KEY` matches MiroTalk's `JWT_KEY`, and that
`MIRO_MEETING_USERNAME`/`PASSWORD` equal one of your `HOST_USERS` entries. The
app reproduces MiroTalk P2P's exact token format (an AES-encrypted
username/password/presenter payload inside an HS256 JWT), so a matching key is
all MiroTalk needs to accept it.

Leave these unset to keep the plain link (MiroTalk shows its own login prompt).

## Settings reference

| Field                        | What it controls                       | Default         | Notes / constraints                                     |
| ---------------------------- | -------------------------------------- | --------------- | ------------------------------------------------------- |
| Title                        | The event's display name               | —               | Required; up to 200 characters                          |
| All-day event                | Hides the times; shows on the day only | off             | —                                                       |
| Date / Start time / End time | When the event happens                 | Date required   | End must be on or after start                           |
| Repeat                       | Recurrence pattern                     | Does not repeat | Daily / Weekly / Monthly (day) / Monthly (nth weekday)  |
| Repeat every                 | Interval between occurrences           | 1               | 1–52                                                    |
| Ends                         | When recurrence stops                  | Never           | Never (≈24 months / 366 cap), On date, or After N times |
| Location                     | Free-text location                     | —               | Optional; up to 200 characters                          |
| Details                      | Agenda / notes                         | —               | Optional; up to 5000 characters                         |
| Video meeting (MiroTalk)     | Attaches a meeting link                | off             | Needs a MiroTalk instance (see above)                   |

## Troubleshooting

| Symptom                                               | Likely cause                                                                                    | Fix                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| An ordinary member sees **Save**/**Delete** on events | That account is actually a committee member or a lodge-edit admin                               | Confirm with `npx tsx scripts/diagnose-calendar-access.ts their@email`; committee assignment grants calendar edit by design       |
| A member should be able to edit but is read-only      | They have no active committee assignment and no lodge-edit role                                 | Add a committee assignment (**Admin → Members → [member] → Committee**) or grant lodge edit                                       |
| A repeating event shows on only one month             | The recurrence was not saved (older build)                                                      | Open the event, set **Repeat**, and **Save** (this converts it to a series), or delete and recreate; ensure the app is up to date |
| **Open meeting link** does nothing / wrong host       | `MIROTALK_URL` is unset or points at the wrong instance                                         | Set `MIROTALK_URL` to your MiroTalk base URL (with `https://`) and restart the app                                               |
| Camera/mic blocked in the meeting                     | MiroTalk is served over plain HTTP (not localhost) or without a camera/mic `Permissions-Policy` | Serve MiroTalk over HTTPS on its own subdomain with camera/mic allowed                                                            |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Committee](committee.md), [Work Parties](work-parties.md),
  [Hut Leaders](hut-leaders.md), [Lodges](lodges.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
