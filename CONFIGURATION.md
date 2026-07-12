# Configuration

This reference covers the public configuration contract for AlpineClubBookingsNZ.
Start from `.env.example` and `config/club.example.json`, then replace values
for your club before running a shared or production deployment.

Do not commit `.env`, production credentials, payment/accounting tokens, or
database backups.

## Club Config

`src/config/club.ts` loads `config/club.json` first and falls back to
`config/club.example.json` when `club.json` is absent. For a new club, copy the
example and edit it:

```bash
cp config/club.example.json config/club.json
```

You can also run:

```bash
npm run setup:wizard
```

The wizard writes `config/club.json` only. It does not write `.env` files and
does not store API keys, OAuth secrets, SMTP secrets, or bearer tokens.

`config/club.json` is validated by `src/config/schema.ts`.

| Field                                              | Required | Description                                                                                                      |
| -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `name`                                             | yes      | Full public club name.                                                                                           |
| `shortName`                                        | no       | Short label used where space is limited.                                                                         |
| `supportEmail`                                     | yes      | Main support address and default sender fallback.                                                                |
| `contactEmail`                                     | no       | Contact-form recipient; falls back to `supportEmail`.                                                            |
| `publicUrl`                                        | yes      | Canonical public origin with no trailing slash.                                                                  |
| `emailFromName`                                    | yes      | Display name for outbound email sender headers.                                                                  |
| `lodgeTravelNote`                                  | no       | Email reminder travel/location note.                                                                             |
| `hutLeaderLabel`                                   | no       | User-facing label for the hut-leader role (e.g. `Lodge Leader`, `Warden`, `Duty Manager`). Defaults to `Hut Leader`. |
| `socialLinks.facebook`                             | no       | Facebook URL used by public pages/footer. Must be an http(s) URL, like `publicUrl`.                              |
| `beds[].id`                                        | yes      | Stable bed or lodge identifier.                                                                                  |
| `beds[].name`                                      | yes      | User-facing bed/lodge name.                                                                                      |
| `beds[].capacity`                                  | yes      | Positive integer fallback/import capacity.                                                                       |
| `beds[].type`                                      | yes      | One of `dormitory`, `private`, or `shared`.                                                                      |
| `ageTiers[].id`                                    | yes      | One of `INFANT`, `CHILD`, `YOUTH`, or `ADULT`. (`NOT_APPLICABLE` is the fixed organisation/school tier — server-managed, never configured here.) |
| `ageTiers[].label`                                 | yes      | User-facing age-tier label.                                                                                      |
| `ageTiers[].minAge`                                | yes      | Minimum age, inclusive.                                                                                          |
| `ageTiers[].maxAge`                                | yes      | Maximum age, inclusive, or `null` for no upper bound.                                                            |
| `ageTiers[].subscriptionRequiredForBooking`        | yes      | Whether the tier must hold a subscription to book as a member.                                                   |
| `ageTiers[].familyGroupRequestCreateMemberAllowed` | yes      | Whether admins may create a non-login dependant from a pending family group request whose DOB maps to this tier. |
| `ageTiers[].nightlyRates.winter.memberCents`       | yes      | Winter member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.winter.nonMemberCents`    | yes      | Winter non-member nightly rate in integer cents.                                                                 |
| `ageTiers[].nightlyRates.summer.memberCents`       | yes      | Summer member nightly rate in integer cents.                                                                     |
| `ageTiers[].nightlyRates.summer.nonMemberCents`    | yes      | Summer non-member nightly rate in integer cents.                                                                 |

When the bed allocation module is effectively enabled and at least one active
bed exists in Admin -> Configuration -> Rooms & Beds, booking capacity is the
active bed count from that configurator — unless a per-lodge capacity is set
below that count, which caps it (the lower of the two applies, so a lodge may
have more beds than it is allowed to sleep). If the module is disabled, or the
module is enabled but no active beds exist yet, the system falls back to the
per-lodge capacity, else the `beds[].capacity` total in `config/club.json`. Use
the Rooms & Beds import action to seed the configurator from `config/club.json`
during transition. See `docs/CAPACITY_MODEL.md` for the full resolution table.

Keep all money values in integer cents.

## Branding Assets

Shared public-website, member-area, and admin-area brand colours and fonts are
managed by administrators at `/admin/site-style`. The existing primary accent
and neutral-ramp fields theme all three surfaces; the app does not maintain a
second accent setting. The occupancy meter follows the primary accent. Semantic
success, warning, information, danger/error, and waitlist colours stay curated,
contrast-locked light/dark pairs and are not editable brand fields. Fresh
deployments show a neutral public-site holding page until an admin finishes that
wizard. The logo is public-site only and is stored in the database as a validated
image data URL; there is no runtime upload directory to preserve.

Saved palettes must meet the **WCAG AA 4.5:1** minimum text-contrast ratio on
the key public/app pairs — body and muted text on the page background, app text
on the secondary/mist surface, header text on the navigation bar, button text on
the primary-action colour, the app
accent on dark app chrome, and the contrast-safe dark accent-text role on the
light app background. App text-bearing surfaces use only the directly gated
snow/mist/deep/charcoal endpoints rather than interpolated colour mixes. The
editable primary accent remains visible as filled controls, decorative borders,
and the occupancy meter; it is not used directly for app text or focus rings.
App controls keep those text/background endpoints opaque on hover and selected
states; shadows or direct semantic endpoints provide interaction feedback rather
than `/NN` transparency utilities that could cross between accepted endpoints.
Bed-allocation booking colours are likewise confined to decorative strips and
rings; their text-bearing cards and Held badges use the gated card/secondary
pairs.
App keyboard focus uses deep on light surfaces and snow in dark mode, with a
two-pixel offset outline that remains visible on opacity-reduced controls. The wizard
disables its Save/Finish buttons and the `/admin/site-style` API rejects the
request (`400`) while any pair falls short, so an admin cannot ship an unreadable
theme. Both accepted colour formats are measured — hex directly, and `oklch()`
values via an oklch→linear-sRGB conversion — so pasting a low-contrast oklch
colour into the value field is blocked the same as a hex one. The current render
fallback uses glacial teal `#57b3ab`; the fresh-seed colour choice remains
unresolved and separately tracked in issue #1832. Site Style raw CSS is appended
to the public website stylesheet only. Authenticated/admin shells receive only
generated, validated brand/font variables, so raw CSS cannot override their
curated semantic status tokens.

Transactional and admin **emails** derive their brand palette from the same club
theme, so a colour change in `/admin/site-style` also restyles the emails
(header bar, accents, buttons, tables). Emails read the palette through a
process-level cache that refreshes at most every five minutes, so a theme change
propagates to newly sent emails within that window; a freshly started process (or
a database read failure) renders with the site default palette until the cache
warms. Emails render **hex** colours only: because email clients cannot render
`oklch()`, a Site Style colour saved as oklch falls back to the site-default hex
for that slot in email (a full oklch→hex conversion is a possible follow-up), so
emails never emit unrenderable oklch. Status colours in warning/success callouts
stay fixed.

The remaining public image assets are still file-based. Replace the default
assets in `public/branding/`:

- `favicon.ico`
- `favicon.png`
- `og-image.png`
- `lodge.jpg`
- `ski-field.jpg`
- `snowboarder.jpg`
- `sunset.jpg`

The matching `*.example.*` files are placeholders for forks and public docs.

Existing Tokoroa deployments can preserve the former look during the transition
by running the seed with `SEED_TOKOROA_THEME_COMPLETE=1`. That path records the
current palette (`#ffcb05`, `#4d4d46`, `#2f2f2b`, `#6a6a63`, `#d9d5c2`,
`#f7f5ed`, `#ff7c12`), marks site style setup complete, and stores
`public/branding/logo.png` as the database logo when that file exists and is
900KB or smaller.

## Website Page Content

Public website pages are database-backed (`PageContent`) and edited in
Admin > Page Content. The website header menu is generated from each page's
menu title and menu order; pages with an empty menu title stay out of the
menu.

- Seeding creates starter pages (`home`, `about`, `join`, `join/apply`,
  `rules`, `contact`, `committee`, `privacy`, `terms`, `faq`) only when they
  do not already exist, so re-running the seed never overwrites edited
  content.
- The home route (`/`) renders the `home` page record. `/contact`, `/join`,
  and `/join/apply` are code-backed routes that render their matching record;
  all other records, including `/privacy`, `/terms`, and `/faq`, are served by
  the dynamic catch-all route.
- Admin-created pages can be hidden from the public site with the
  **Hide**/**Publish** toggle in Admin > Page Content (no permanent delete):
  hidden pages drop out of the menu and return a 404 on the catch-all route.
  System pages (`home`, `404`) and the built-in starter pages above cannot be
  hidden, because code routes, the footer, and the sitemap link to them.
- Slugs use lowercase letters, numbers, and hyphens, with optional forward
  slashes between segments (`trip-reports`, `trips/2026`). Application
  route names (`admin`, `api`, `book`, `dashboard`, `login`, and similar)
  are reserved and rejected in every segment position.
- Page HTML supports embed tokens that render interactive sections across
  PageContent-backed public routes, including code-backed starter routes.
  Supported tokens are `{{committee-members-cards}}`,
  `{{member-application-form}}`, `{{join-apply-form}}`, `{{contact-form}}`,
  `{{skifield-whakapapa}}`, `{{skifield-conditions:dataHash}}`,
  `{{photo-gallery}}`, `{{photo-gallery:path}}`, `{{photo-slideshow}}`, and
  `{{photo-slideshow:path}}`. Legal and help-copy pages can also use text
  tokens `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}` (a named lodge's capacity; unknown slug falls
  back to the default lodge), `{{hut-leader}}`, and `{{hut-leader-lower}}`, which
  are resolved server-side
  from the current club/runtime settings (`{{hut-leader}}` renders the
  configured hut-leader label, default `Hut Leader`; `{{hut-leader-lower}}`
  renders its lower-cased form for mid-sentence prose). The `dataHash`
  parameter is the Snow.nz widget hash. Photo token `path` parameters are
  normalised relative to
  `public/images/` and load images from that shared image-manager storage tree:
  a committed `public/images/` directory in a source checkout, or the mounted
  `public/images` volume in containerised deployments. Without a path, photo
  tokens use inline images already inserted in the page body. Photo tokens
  require double braces. Legacy single-brace syntax remains accepted only for
  non-photo tokens.
- Content and header HTML are sanitised on save and again on render. The
  allowlist lives in `src/lib/page-content-html.ts`. It includes native
  `<details>`/`<summary>` elements (plus the boolean `open` attribute on
  `<details>`), which the starter FAQ page uses for its collapsible
  question-and-answer accordion.
- The editor's image picker can insert images from three sources:
  database-backed image-library uploads, deployed branding files under
  `public/branding/`, and filesystem/image-manager files under the shared
  `public/images` tree. The root picker view combines the latest database
  uploads, branding images, and root-level filesystem images; choosing another
  Images folder shows filesystem images from that folder only.
- The picker Upload button stores one image at a time in the database-backed
  image library. Those images are served publicly from `/api/images/[id]`; the
  picker can delete those database records, while branding files are managed by
  deployment/repository asset updates and filesystem images are managed through
  Admin > Image Manager.
- Database-backed image-library uploads accept PNG, JPEG, GIF, WebP, AVIF, and
  SVG files up to 2MB. The server validates the stored content type from the
  file bytes rather than trusting the browser-declared type or filename. SVG is
  allowed only through the `/api/images/[id]` serving route, which adds
  `Content-Security-Policy` and `X-Content-Type-Options: nosniff` response
  headers.
- Admin > Image Manager uploads filesystem images into the shared
  `public/images` tree/volume and serves them from `/api/images/uploaded/...`.
  Those uploads accept PNG, JPEG, GIF, WebP, and AVIF files up to 10MB. SVG is
  intentionally rejected there because filesystem uploads are served as static
  image assets without the database image route's restrictive CSP.

## Website Site Content

Shared public website chrome is database-backed (`SiteContent`) and edited in
Admin > Site Content. This is separate from `PageContent`: page records still
own per-page header/body content and menu entries, while site content owns
reusable layout fragments that are not routable pages.

- The first site-content sections are the three public footer columns:
  `FOOTER_BLURB`, `FOOTER_QUICK_LINKS`, and `FOOTER_AFFILIATIONS`.
- The public footer keeps the logo, current year, copyright line, and
  privacy/terms links code-managed. Admins can edit or clear the three column
  HTML fragments; clearing either link column hides that column.
- The migration backfills starter footer rows with the previous hardcoded
  footer copy, so deploy-only environments keep the same footer without
  running the seed. The seed also creates the starter rows when missing and
  never overwrites existing admin edits.
- Footer section HTML is sanitised on save and again on render with the same
  allowlist as page content (`src/lib/page-content-html.ts`). Footer text
  tokens include `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}`, and `{{facebook-url}}`; embed tokens are not
  supported in footer sections.
- URL-bearing tokens are scheme-validated when they resolve: `{{facebook-url}}`
  only renders http, https, or mailto values. Anything else is replaced with
  the configured `publicUrl` (or `#`) and logged as a server warning.

## Website Site Banners

Admin > Site Banners manages site-wide notification banners stored as
`SiteBanner` records. Banners are plain text only and render above the public
website, public-auth, and signed-in member headers while active and while the
current New Zealand date-only value falls inside the inclusive display window.

- Priorities are `URGENT`, `WARNING`, and `NOTIFY`, displayed with faded red,
  amber, and blue styling respectively.
- Admins can create, edit, activate/deactivate, and delete banners. The admin
  page groups banners into current, upcoming, and the 50 most recent past
  banners by their date-only display windows.
- Visitors can dismiss a banner per browser. Dismissal is stored in
  localStorage and is invalidated when an admin edits the banner, so updated
  wording is shown again.
- Banner create/update/delete actions write structured audit logs. Messages are
  rendered as escaped plain text; HTML and tokens are not supported.

## Lodge Instructions

Lodge opening, closing, and day-to-day instructions for hut leaders are
database-backed (`LodgeInstruction`, one row per document) and edited in
Admin > Lodge Instructions. They are protected content, deliberately separate
from `PageContent`: they never appear in the public menu or the dynamic
public page route.

- Readers: admins, plus members with a current or upcoming hut leader
  assignment, at `/lodge-instructions` (printable). The lodge kiosk shows
  the documents to the signed-in hut leader tier.
- HTML is sanitised on save and again on render with the same allowlist as
  page content (`src/lib/page-content-html.ts`).
- Text tokens `{{club-name}}`, `{{currency}}`, `{{lodge-capacity}}`,
  `{{lodge-capacity:lodge-slug}}`, `{{hut-leader}}`, and `{{hut-leader-lower}}` are
  resolved on the reader and kiosk surfaces (embed tokens are not supported here). The admin editor shows
  the literal tokens; the editor's token help button lists what is available.
- The migration backfills the three empty documents, so deploy-only
  environments get editable rows without running the seed.

## Lodge Settings

Admin > Setup includes lodge-wide settings stored in the singleton
`LodgeSettings` row:

- Capacity: optional per-lodge maximum sleeping capacity. Leave blank to use the
  active bed count (Bed Allocation on) or the club-config bed total. When set
  alongside configured beds it acts as a ceiling — the lower of the capacity and
  the active bed count applies (`docs/CAPACITY_MODEL.md`).
- Hut-leader lookahead: defaults to 14 days and controls how far ahead
  unassigned hut-leader dates are reported on the admin dashboard, stuck-state
  dashboard, the hut-leader assignment API, and the queue-driven Needs
  Attention sidebar item.

For a club that runs more than one lodge, each lodge gets its own
`LodgeSettings` row (capacity override, school-group soft cap); the hut-leader
lookahead stays a single club-wide value. See "Adding a Second Lodge" below.

## Adding a Second Lodge

A club can run more than one lodge property under one membership, one finance
backend, and one admin. The lodge data model is always present, but a
single-lodge club never sees it. This section walks an admin through turning
on and setting up a second lodge. Design rationale lives in
`docs/multi-lodge/` (start with `feature-overview.md`); this is the operator
how-to.

### 1. Enable the Multiple lodges module

Admin > Modules > **Multiple lodges** (default OFF). Enabling it exposes the
lodge-management admin surface (the Lodges page and per-lodge settings). It
does **not** by itself change anything members see — member-facing screens
only gain a lodge dimension once a *second active lodge actually exists*. The
module cannot be turned off again while more than one active lodge exists, so a
multi-lodge club can never strand itself without the UI to manage its lodges.

### 2. Create the lodge

On the Lodges page, create the new lodge: name, and optionally its door code
and travel note (these are the per-lodge identity fields used in that lodge's
confirmation and pre-arrival emails). The club's original lodge already exists
as the seeded default lodge.

### 3. Run the setup wizard

Creating a lodge lands in a guided setup wizard (`/admin/lodges/[id]/setup`):
identity → rooms/beds → lockers → seasons/rates → chores. Every step is
skippable, and rooms/beds/lockers support bulk seeding ("8 rooms of 4 beds",
"N lockers" with a name prefix) plus copy-from-another-lodge for seasons/rates
and chores. The lodge configuration hub (`/admin/lodges/[id]`) is the
"what does this lodge still need?" view and links into each editor pre-filtered
to that lodge. Wizard and hub cards for module-gated areas (bed allocation,
lockers, chores) appear only when that module is enabled.

### 4. Capacity and the 0-capacity fail-safe (read this first)

**A newly created lodge is unbookable until you give it beds or a capacity
override.** This is deliberate, and it will look like a bug the first time:
a lodge with no configured beds and no override resolves to **capacity 0**, so
the booking flow refuses all bookings at it rather than risk overbooking an
unconfigured lodge.

Each lodge's capacity resolves in this order (`getLodgeCapacityStatus`):

1. Active configured beds, when the Bed Allocation module is on and the lodge
   has active beds.
2. Otherwise, the per-lodge **capacity override** on the lodge's
   `LodgeSettings` (set it on the lodge hub or Admin > Setup). This works even
   with Bed Allocation off.
3. Otherwise, the club-config bed total — but **only for the original default
   lodge**. Any *additional* lodge falls through to 0.

So to make a new lodge bookable, either configure its beds (Bed Allocation
module) or set its capacity override. Until then it correctly shows as
unavailable.

Per-lodge overrides *replace*, they do not merge: setting a lodge's capacity
override does not add to the club-config total, it substitutes for it at that
lodge.

### 5. Bind the kiosk account to the lodge

Each lodge's shared kiosk device signs in with a lodge-operational (kiosk)
account bound to that lodge. On the **Lodge Kiosk** admin page (`/admin/lodge`)
you can see every kiosk account with its bound lodge, create an additional
kiosk account bound to the new lodge in one step, and rebind or unbind existing
accounts (an unbound account falls back to the default lodge). The kiosk shows
only its bound lodge's arrivals, departures, and roster, and its header names
the lodge it is operating. Binding is a `STAFF` grant in `MemberLodgeAccess`;
you can also manage a member's STAFF grants from their member page.

### 6. Per-lodge hut-leader PINs

A hut-leader assignment belongs to one lodge. A hut leader's PIN works only at
that lodge's kiosk and surfaces only that lodge's roster, chore sign-off, and
guest lists — it does nothing at another lodge's kiosk. Assign hut leaders per
lodge in Admin > Hut leaders; each assignment carries its lodge, and PIN
matching is scoped to the kiosk's bound lodge.

### 7. Per-lodge policy overrides ("replace, not merge")

Cancellation, minimum-stay, and booking-period rules are **club-wide by
default**. Most clubs never need per-lodge rules. When a lodge does need its
own (for example a remote lodge with a longer cancellation window), you set
that lodge's own rules on the policy pages via the per-lodge override path.

The key semantic: a lodge's own rules **replace** the club-wide set for that
policy type — they are not merged with it. If you give Lodge B a cancellation
tier set, Lodge B uses *only* those tiers; it does not also inherit the
club-wide tiers. Lodges with no override keep using the club-wide rules. The
booking flow shows a member the rules for the lodge they booked. Lodge
opening/closing/day-to-day kiosk instructions follow the same replace-not-merge
rule per document.

### 8. Eligibility restrictions and cross-lodge waitlist

- **Eligibility is default-open.** Every active member can book every active
  lodge unless you configure a restriction. On a member's page you can add a
  booking restriction limiting them to specific lodges; a restricted member
  simply never sees the other lodges offered. Admin bookings made on behalf of
  a member deliberately bypass the restriction (the audited override path).
- **Promo codes** are club-wide by default; each promo can optionally be
  restricted to selected lodges. An unrestricted promo works at every lodge,
  including lodges created later.
- **Cross-lodge waitlist (ADR-004).** When a member waitlists a full lodge,
  they can opt in to alternate lodges they would also accept. When a bed frees,
  the processor may offer an opted-in alternate. The queue order is a single
  club-wide setting on the booking-policies page,
  `BookingDefaults.waitlistCrossLodgeOrder`:
  - `OWN_LODGE_FIRST` (default): the freeing lodge's own queue is served first
    in join order, then cross-lodge opt-ins, so no one is overtaken in a queue
    they joined.
  - `MERGED`: everyone who could be satisfied at that lodge — its own queue
    plus opt-ins — is ranked purely by join time.
  A cross-lodge offer states the alternate lodge and its price and requires the
  member to confirm; accepting creates a fresh booking at that lodge rather
  than moving the original. (Waitlist entries carrying a promo redemption are
  not offered cross-lodge — a documented limitation.)

Every one of these follows the single-lodge presentation rule: with only one
active lodge, none of the selectors, columns, or lodge names appear, and the
club behaves exactly as it does today.
## Hut Leaders

A hut-leader assignment (`/admin/hut-leaders`) is a date-ranged roster record
that issues a dedicated lodge kiosk PIN for the assigned member (the plaintext
PIN is shown only once, when it is issued or reset) — it is not a role or
access-role capability. Assignment is admin-controlled; completing a Hut Leader
Induction only sets `Member.hutLeaderEligible` and never creates or dates an
assignment.

The New Assignment picker is **booking-derived**. It lists only adult members
who both hold the standard member (`USER`) access role and have an operational
booking overlapping the selected date range, so a season-long custodian who has
no booking never appears — and the create API rejects any member who lacks the
`USER` role.

To roster a custodian who has no booking of their own (the ratified workaround):

1. On Promo Codes, create a 100%-off code covering the custodian's stay.
2. On Book on Behalf, book the custodian's lodge nights and apply the free code
   so the stay costs nothing.
3. Confirm the custodian's account still has the standard member (`USER`) role
   ticked — a member whose only roles are custom (definition-backed) roles
   cannot be assigned as hut leader.
4. Return to `/admin/hut-leaders`, choose the matching dates, and assign the
   custodian as normal; they now appear in the picker and receive a lodge PIN.

## Required Local Setup Variables

These are enough for a local database-backed app with external services left in
test/demo mode or disabled:

| Variable                | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string used by Prisma.                     |
| `DB_PASSWORD`           | PostgreSQL password used by Docker Compose.                      |
| `AUTH_SECRET`           | Auth.js session secret.                                          |
| `NEXTAUTH_SECRET`       | Legacy Auth.js secret fallback; keep aligned with `AUTH_SECRET`. |
| `NEXTAUTH_URL`          | Exact app origin, for example `http://localhost:3000`.           |
| `AUTH_TRUST_HOST`       | Set `true` behind trusted proxies/Compose.                       |
| `CRON_SECRET`           | Shared secret for cron and deploy status endpoints.              |
| `SEED_ADMIN_EMAIL`      | Email for the first seeded admin account.                        |
| `SEED_ADMIN_PASSWORD`   | Initial password for the first seeded admin account.             |
| `SEED_ADMIN_FIRST_NAME` | Optional first name for the seeded admin; defaults to `Admin`.   |
| `SEED_ADMIN_LAST_NAME`  | Optional last name for the seeded admin; defaults to `User`.     |
| `SEED_LODGE_PASSWORD`   | Initial password for the seeded shared lodge kiosk account.      |
| `ALLOW_DEMO_SEED`       | Local-only opt-in; must be `1` for `npm run db:seed:demo`.       |
| `DEMO_SEED_PASSWORD`    | Optional local-only password for `npm run db:seed:demo` users.   |
| `DEMO_SECOND_LODGE`     | Local-only; set to `1` to also seed a second demo lodge (rooms + a few bookings) so two-lodge flows are demoable. Default demo dataset is unchanged when unset. |

`prisma/seed.ts` fails before seeding if `SEED_ADMIN_EMAIL` or
`SEED_ADMIN_PASSWORD` is unset, and fails before creating the lodge kiosk
account if `SEED_LODGE_PASSWORD` is unset. The seeded admin is created with
`role: ADMIN`, `canLogin: true`, `emailVerified: true`, and a `NOT_REQUIRED`
membership subscription for the current season, and is forced through
`/change-password` on first login. The seed also writes the normalized
`MemberAccessRole.ADMIN` row for the seeded admin and
`MemberAccessRole.LODGE` row for the seeded lodge kiosk account. Re-running
the seed repairs those missing normalized access-role rows without overwriting
the existing accounts. The seed only creates the admin when no `ADMIN` member
exists yet, so changing `SEED_ADMIN_*` later has no effect on an existing
database.

The whole seed is create-if-missing: re-running it against a populated
database never deletes, overwrites, or duplicates data. Committee entries and
chore templates are seeded as generic placeholders only when their tables are
empty; replace them through the admin screens after first login.

The seed also creates built-in seasonal membership types: Full, Associate,
Life, School, Non-Member, and Family. Associate is the built-in
Associate/Reserve-style type and can be renamed by the club. It backfills the
current membership season from current and historical role values (`USER`,
historical `MEMBER`, `ADMIN`, and `LODGE` to Full, historical `ASSOCIATE` and
legacy `RESERVE` to Associate, historical `LIFE` to Life, `SCHOOL` to School,
and `NON_MEMBER` to Non-Member) using create-if-missing assignments. Re-running
the seed does not overwrite existing seasonal assignments.

`npm run db:seed:demo` is separate from the first-run seed. It is intended only
for disposable local demo databases and must never be run on a deployment host.
It requires `ALLOW_DEMO_SEED=1`, refuses `NODE_ENV=production`, refuses
non-local `DATABASE_URL` hosts, and refuses to run when the `Member` table
contains any email outside `demo.alpineclub.test`. The demo seed then deletes
demo plus transactional rows before rebuilding a broad sample dataset. The demo
seed uses fake emails under `demo.alpineclub.test` and fake provider
identifiers only. Set `DEMO_SEED_PASSWORD` to override the default local demo
password.

## Setup Readiness

Run this before bootstrapping a new install:

```bash
npm run setup:check
```

The check validates `config/club.json`, environment variable presence/format,
module capability flags, and first-install readiness. Database-backed checks,
including Admin Modules activation, are reported inside the admin setup wizard
after migrations and seed data run.

After signing in as an administrator, open `/admin/setup` to review:

- readiness KPIs, blockers, setup hub cards, club config, and module controls
- first admin and seeded database settings
- booking policies, membership cancellation settings, age tiers, seasons, and rates
- Stripe, SES/email, Sentry, operational Xero, and finance-dashboard readiness
- Xero account and item-code mappings from the `/admin/setup/finance` drill-down

Provider tests on `/admin/setup` run only when an admin clicks the relevant test
button. They should use test/demo provider credentials until the environment is
ready for production.

## Membership Cancellation Settings

Membership cancellation setup is stored in database settings, not environment
variables. `/admin/setup` exposes:

- cancellation warning text shown by future member-facing request flows
- rejoin-process text for cancelled members
- operational Xero contact groups that represent cancelled members
- whether approved cancellation processing should archive the Xero contact

These settings are audited when saved. They do not call Xero on save; future
approval processing must keep Xero writes outside long database transactions.

## Membership Type Settings

Seasonal membership type settings are database-backed and managed from
`/admin/membership-types`. Access roles, seasonal membership type, age tier,
Xero contact-group rules, and committee assignment are separate axes:

- `MemberAccessRole` is the normalized access source for login permissions.
  Rows carry the legacy enum value (`USER`, `ADMIN`, `ADMIN_READONLY`,
  `ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`, `LODGE`,
  `FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to a club-editable
  `AccessRoleDefinition` (managed at `/admin/access-roles`, Full Admin only).
  Runtime authorization must read these rows (with the definition joined)
  only. `ADMIN` is the protected full-admin bundle and is never editable;
  the six seeded defaults — read-only admin, booking officer, membership
  officer, content manager, finance viewer, and treasurer — are definition
  rows that can be renamed, re-permissioned, or deleted, and new custom roles
  can be created. Multiple rows may be combined for a custom mix; finance
  portal access derives from the merged finance area level.
  `session.user.role` is kept only for display and older serialized shapes.
  `Member.role` remains a compatibility/classification field with only
  `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and `SCHOOL`; Associate, Life, and
  club-created categories live in `MembershipType`. `financeAccessLevel`
  remains synchronized for compatibility/export visibility, but does not grant
  runtime finance access.
- `MembershipType` stores admin-configurable seasonal categories and policy:
  Full, Associate (renameable, including Reserve naming), Life, School,
  Non-Member, Family, or club-created types. The `/admin/membership-types`
  page shows these as a compact ordered list; creating or editing a type opens
  a dedicated editor for identity fields, booking behavior (`MEMBER_RATE`,
  `NON_MEMBER_RATE`, `BLOCK_BOOKING`), subscription behavior (`REQUIRED`,
  `NOT_REQUIRED`), allowed age tiers, and optional Xero contact-group rules.
  Display names must be unique: creating or renaming a type to a
  case-insensitive exact match of an existing name is rejected.
- `AgeTierSetting` remains separate because a member can be Adult Full, Adult
  Life, Adult Associate, Child Family, Youth School, and so on. Age tiers still
  drive age-based rates and age-based default Xero grouping. Use Age Tier Xero
  groups for broad age cohorts such as Adult or Youth, use Membership Type Xero
  groups for status/policy groups such as Life or Associate, and use both when
  Xero needs both labels.
- `SeasonalMembershipAssignment` records one membership type per member per
  membership `seasonYear`, including the assignment source (`ADMIN`, `IMPORT`,
  `FAMILY_SUBSCRIPTION`, `ROLL_FORWARD`, or `SYSTEM`) and an optional
  date-only `applyFrom` changeover for mid-season moves between membership
  types.
- Admin member detail pages show access roles separately from seasonal
  membership type. The Admin > Members list also shows the current seasonal
  Membership Type beside Access. Changing the seasonal type requires a preview
  and admin reason; the preview counts future confirmed bookings, drafts,
  waitlist records, and subscription history before the save is audited.
  Existing future bookings are not automatically repriced by changing the type
  or `applyFrom` date. Production preview tokens require `AUTH_SECRET` or
  `NEXTAUTH_SECRET`; setup readiness blocks when neither secret is configured.
- `/admin/membership-types` includes a separate idempotent roll-forward section
  that previews and then copies missing assignments from one season to another
  while leaving existing target assignments unchanged and flagging missing or
  inactive-type exceptions.
- Committee assignment remains public/contact metadata and does not grant app
  access.

## Committee Settings

Committee settings are database-backed and managed from `/admin/committee`.
`CommitteeRole` stores reusable master roles such as President, Secretary, or
Booking Officer, including the role email alias used for committee contact
delivery. `CommitteeAssignment` links a member to one of those roles and stores
presentation controls: blurb, sort order, published, show-phone, contactable,
and active/deactivated state. Multiple members can hold the same master role.

Committee assignment is separate from `Member.role` and
`SeasonalMembershipAssignment`; it never grants admin, lodge, booking, finance,
or subscription privileges. Member detail pages show committee assignments in
their own card alongside access role and seasonal membership type controls.

Public committee and contact-form recipient data is derived from published,
active `CommitteeAssignment` rows whose master role is also active. The public
API returns the linked member's display name, the role name, the assignment
blurb or role description, and an opaque assignment contact key only when the
assignment is contactable. Member email addresses are never returned to the
browser; `/api/contact` resolves contactable assignment keys server-side and
delivers to the role email alias configured on `CommitteeRole`, falling back to
the linked member's email when the role has no alias, then to the configured
club contact address when no published, contactable assignment or recipient
email is available. Committee-routed contact emails use an opaque
committee-contact marker in EmailLog rows instead of persisting the recipient
address. Phone numbers come from the linked member profile and display only when
the assignment's show-phone flag is enabled.

The legacy `CommitteeMember` table remains editable for historical/public
migration reference, but it no longer powers `/api/committee` or committee
recipient routing. Seed and migration steps create master roles and hidden
member-linked assignments where a legacy committee email exactly matches a
member email, but they do not delete or blank existing legacy rows. Assignment
changes and master role changes are audited with before/after metadata.

Booking and subscription enforcement is season-aware:

- `MEMBER_RATE` keeps normal member pricing for linked member guests.
- `NON_MEMBER_RATE` prices the member at non-member nightly rates while keeping
  the member identity on booking guests, audit records, and promo checks.
- `BLOCK_BOOKING` prevents the member from booking as owner or linked member
  guest and returns a structured policy error with safe member ids/names.
- `NOT_REQUIRED` makes subscription lockout display and booking gates effective
  `NOT_REQUIRED` for that season without deleting or hiding raw Xero invoice or
  subscription history.

`ADMIN` and `LODGE` operational subscription exemptions still come from
`roleNeverRequiresSubscription()`. Seasonal membership type changes do not
automatically reprice existing future bookings, rewrite
subscription/Xero/payment history, or call external providers.

## Member Import And Addresses

Admin member CSV import treats a member identity as the normalized email plus
normalized first and last name. Rows are skipped as duplicates when that same
identity already exists in the database or earlier in the same import, even
when dates of birth differ or one row has a blank date of birth. Date of birth
is not part of the duplicate key; a blank date of birth is unknown and cannot
prove a distinct identity. Different names may share an email address,
including rows with the same or blank date of birth.

Only one login-enabled member can use an email address. If an existing member
with `canLogin: true` already has the email, every new shared-email import is
created with `canLogin: false`. If the email first appears in the CSV, the first
allowed identity can log in and later same-email identities are imported as
non-login members. Setup invite emails and setup/password tokens are created
only for imported rows that can log in.

Address forms default "Postal same as physical" on for new or blank postal
addresses. Existing members keep it off only when a saved postal address has
material postal fields that differ from the physical address. Server routes
remain authoritative: when `postalSameAsPhysical` is submitted, physical address
fields are copied into postal fields before the member or application is saved.

## App Defaults

| Variable                           | Description                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `CURRENCY`, `NEXT_PUBLIC_CURRENCY` | Currency display and server default.                                                                 |
| `TZ`, `NEXT_PUBLIC_TZ`             | Time zone; this app expects New Zealand date-only booking semantics unless a feature says otherwise. |
| `LOCALE`, `NEXT_PUBLIC_LOCALE`     | Locale for formatting.                                                                               |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID`    | Optional GA4 measurement id. Google Analytics still requires the Admin Modules toggle and visitor consent before loading. |
| `LOG_LEVEL`                        | Pino log level such as `debug`, `info`, `warn`, `error`, or `fatal`.                                 |
| `APP_RUNTIME_ROLE`                 | Runtime label used by health/status reporting, usually set by Compose.                               |
| `NODE_ENV`                         | Runtime mode set by Node/Next.                                                                       |
| `NEXT_RUNTIME`                     | Runtime marker set by Next.js instrumentation.                                                       |
| `npm_package_version`              | Package version exposed by npm scripts.                                                              |

## Module Controls And Admin Modules

Optional modules are activated from Admin > Modules and stored in the
`ClubModuleSettings` database table. There are no module `FEATURE_*`
environment variables. Admin Modules do not store secrets, tokens, tenant ids,
bank account details, or provider credentials; Stripe, Xero, email, cron, and
other operator-owned credentials stay in environment variables and provider
setup screens.

The effective module state is the saved Admin Modules value. Missing module
settings use the hardened first-install defaults below. If the settings table
cannot be read, optional modules fail closed.

| Module | Default | Description |
| --- | --- | --- |
| Lodge kiosk | off | Guest arrival, departure, and lodge access screens. |
| Chores and roster | off | Roster generation, chore templates, and guest chore tracking. |
| Finance dashboard | off | Finance reports, sync diagnostics, and finance-only dashboards. |
| Waitlist | off | Waitlist booking state, admin queue, offer handling, and waitlist cron. |
| Xero integration | off | Operational Xero linking, sync actions, reconciliation tools, Xero cron, and Xero webhooks. |
| Bed allocation | off | Room and bed inventory, guest-to-bed allocation, auto-allocation, and allocation approvals. |
| Internet Banking payments | off | Member Internet Banking payment option backed by Xero invoices. Operational Xero still needs credentials and a tenant connection before invoices can be issued and reconciled. |
| Address autocomplete | off | Addy-powered suggestions on address fields. Manual address entry remains available whenever the module is off, credentials are missing, Addy fails, or rate limiting applies. |
| Group bookings | on | Group-booking organiser, join, and settlement surfaces. |
| Lockers | on | Physical locker records and member allocations. |
| Lodge induction | on | Lodge induction templates, assigned signers, and single-Pass sign-off. |
| Work parties | on | Volunteer work-party events and the internal booking discounts they grant. |
| Promo codes | on | Promo-code administration and promo-aware booking flows. |
| Hut leaders | on | Hut-leader assignments, kiosk access, and auto-assignment. |
| Communications | on | Admin bulk email to members. Transactional notifications are unaffected. |
| Ski-field conditions | on | Live mountain/road status panel, public API routes, and admin cache controls. |
| Multiple lodges | off | Lodge-management admin surface for clubs with more than one lodge property. The lodge data model is core and always present; member-facing screens only change once a second active lodge exists. Cannot be turned off while more than one active lodge exists. See `docs/multi-lodge/README.md`. |
| Two-factor authentication | off | Requires users to complete authenticator-app, email-code, or recovery-code verification after password login. |
| Google Analytics | off | Consent-gated GA4 tracking on public website and public account pages. Requires `NEXT_PUBLIC_GA_MEASUREMENT_ID`; GA scripts load only after a visitor accepts the analytics banner. |

Cron-backed optional module schedules are still registered when
`CRON_ENABLED=true`; each run checks the effective module state before doing
module work. If an Admin Modules setting is disabled, the cron runner records a
clean skipped result rather than running the module task.

## Admin Module Activation

The Admin dashboard includes `/admin/modules` for club-level activation of the
optional modules above. These settings are stored in the `ClubModuleSettings`
database table as booleans only.

## Two-Factor Authentication

The Two-factor authentication Admin Modules toggle is a global enforcement
switch. It defaults off. When enabled, password sign-in creates a limited JWT
session with `twoFactorVerified=false`; protected route-group layouts and API
guards redirect or reject that session until the user completes `/login/enroll`
or `/login/verify`. A session becomes verified only when the Auth.js jwt
callback consumes a single-use, short-lived challenge token minted server-side
after a successful code check (stored hashed in `TwoFactorSessionChallenge`);
client-initiated session updates cannot flip the flag.

The member Profile page shows its Two-factor authentication security card only
when the module is enabled or the member is already enrolled. If the club later
turns the module off, enrolled members still see their enabled state and recovery
code controls, while non-enrolled members do not see an enrollment prompt.

Users enroll either an authenticator app (TOTP) or an email one-time code. TOTP
secrets are encrypted at rest using key material derived from `AUTH_SECRET` (or
`NEXTAUTH_SECRET` fallback), so rotating that secret invalidates stored TOTP
secrets and recovery-code hashes. Email codes are short-lived, hashed at rest,
and the `two-factor-code` email template is marked sensitive so rendered code
content is not retained in email logs. Recovery codes are generated on
enrollment and profile regeneration, shown once, hashed at rest, and consumed
once.

> **Operational note — rotating `AUTH_SECRET`/`NEXTAUTH_SECRET` is a planned
> event, not a casual credential refresh.** Because members' TOTP secrets and
> recovery-code hashes are bound to key material derived from the secret,
> rotating it **invalidates every member's enrolled authenticator and recovery
> codes at once** — on their next sign-in each member is forced back through
> two-factor enrollment. Schedule rotation as a maintenance action with advance
> member communication and a support plan for anyone who cannot immediately
> re-enroll (e.g. members who no longer have their authenticator device); never
> rotate ad hoc. Short-lived email one-time codes are unaffected (re-issued per
> attempt).

Invalid two-factor attempts are rate-limited and tracked per member. Five
invalid app, email, or recovery-code attempts lock the two-factor challenge for
15 minutes. Accounts that still have `forcePasswordChange=true` must finish
`/change-password` before enrolling or verifying two-factor authentication.

## Stripe

| Variable                             | Description                                               |
| ------------------------------------ | --------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                  | Stripe server key; use test mode outside production.      |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe browser publishable key.                           |
| `STRIPE_WEBHOOK_SECRET`              | Stripe webhook signing secret for `/api/webhooks/stripe`. |

## Operational Xero

| Variable                                   | Description                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `XERO_CLIENT_ID`                           | Operational Xero OAuth client id.                                      |
| `XERO_CLIENT_SECRET`                       | Operational Xero OAuth client secret.                                  |
| `XERO_REDIRECT_URI`                        | Must match the deployed `/api/admin/xero/callback` URL.                |
| `XERO_ENCRYPTION_KEY`                      | 64-character hex key for encrypted token storage.                      |
| `XERO_WEBHOOK_KEY`                         | Xero webhook signing key.                                              |
| `XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH`     | Enables daily membership refresh behavior when operational Xero is on. |
| `XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS`    | Enables live Xero member group lookups.                                |
| `XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS` | Enables automatic Xero contact-group loading.                          |
| `XERO_INBOUND_FAILED_RETRY_BACKOFF_MS`     | Optional retry backoff for failed inbound Xero reconciliation.         |
| `XERO_HTTP_TIMEOUT_MS`                     | Optional OAuth-layer HTTP timeout (identity discovery and token requests) in ms; default 10000, overriding xero-node's 3500ms. |

## Finance dashboard

The finance dashboard reads its revenue, cost, and balance figures from the
single operational Xero connection configured above. There are no separate
finance Xero credentials. The finance report sync requires these granular Xero
OAuth scopes:

- `accounting.reports.profitandloss.read`
- `accounting.reports.balancesheet.read`
- `accounting.reports.banksummary.read`

Before reconnecting, update the Xero developer app allowed scopes to include the
exact app request, and verify that `XERO_REDIRECT_URI` matches the deployed
`/api/admin/xero/callback` URL. Then reconnect Xero from `/admin/xero` so fresh
tokens carry the current scope set. Access is controlled per member by
`MemberAccessRole` rows. `FINANCE_USER` can read the finance dashboard and
finance viewer APIs; `FINANCE_ADMIN` is the Treasurer bundle and can also run
manager-only finance actions such as manual sync, report mapping writes, and
finance admin routes. `ADMIN` has full admin access, while `LODGE` does not
grant finance access by itself. Mixed-role accounts such as `LODGE` plus
`FINANCE_USER` are valid. The legacy `financeAccessLevel` field is kept
synchronized for compatibility only; finance page and API guards ignore it and
read `MemberAccessRole` rows.

## Email Delivery

| Variable                                 | Description                                                                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USE_AWS_SES`                            | Boolean toggle (`true`/`false`) to use AWS SES SMTP credentials.                                                                                             |
| `USE_SMTP_RELAY`                         | Boolean toggle (`true`/`false`) to use an external SMTP relay. Exactly one provider flag should be `true` (legacy default is AWS SES when both are omitted). |
| `SMTP_HOST`                              | SMTP host for AWS SES SMTP mode (defaults to `email-smtp.ap-southeast-2.amazonaws.com` when unset).                                                          |
| `SMTP_PORT`                              | SMTP port for AWS SES SMTP mode (defaults to `587` when unset).                                                                                              |
| `AWS_SES_ACCESS_KEY_ID`                  | SES SMTP/API access key (required when `USE_AWS_SES=true`).                                                                                                  |
| `AWS_SES_SECRET_ACCESS_KEY`              | SES SMTP/API secret key (required when `USE_AWS_SES=true`).                                                                                                  |
| `EMAIL_SERVER_HOST`                      | SMTP relay host (required when `USE_SMTP_RELAY=true`).                                                                                                       |
| `EMAIL_SERVER_PORT`                      | SMTP relay port (required when `USE_SMTP_RELAY=true`).                                                                                                       |
| `EMAIL_SERVER_USER`                      | SMTP relay username (required when `USE_SMTP_RELAY=true`).                                                                                                   |
| `EMAIL_SERVER_PASSWORD`                  | SMTP relay password (required when `USE_SMTP_RELAY=true`).                                                                                                   |
| `EMAIL_FROM`                             | Sender email address.                                                                                                                                        |
| `EMAIL_FROM_NAME`                        | Optional sender display name override.                                                                                                                       |
| `SUPPORT_EMAIL`                          | Optional support email override.                                                                                                                             |
| `CONTACT_EMAIL`                          | Server-side contact-form recipient override.                                                                                                                 |
| `NEXT_PUBLIC_CONTACT_EMAIL`              | Public contact email displayed in client-rendered UI.                                                                                                        |
| `SES_SNS_TOPIC_ARN`                      | SNS topic ARN for SES bounce/complaint webhooks (required for full SES feedback handling when `USE_AWS_SES=true`).                                           |
| `SES_SNS_ALLOW_UNSAFE_MISSING_TOPIC_ARN` | Local/dev escape hatch only; never enable for deployed SES feedback ingestion.                                                                               |
| `SES_SNS_ALLOW_SIGNATURE_V1`             | Temporarily permit legacy SNS SignatureVersion 1 (SHA1). Default rejects v1; enable SignatureVersion 2 on the SNS topic and leave this unset in production.   |
| `BULK_SENDMAIL_LIMIT`                    | Admin bulk-communication sends allowed per hour (default `1`).                                                                                               |

## Address Autocomplete

| Variable          | Description                                     |
| ----------------- | ----------------------------------------------- |
| `ADDY_API_KEY`    | Addy API key for server-side address search.    |
| `ADDY_API_SECRET` | Addy API secret for server-side address search. |

Address autocomplete is also controlled by Admin > Modules and defaults off.
The server-side `/api/address-autocomplete/**` proxy is unavailable while the
module is disabled, before any Addy call can run. If the module is enabled but
either Addy credential is missing, Admin Setup reports the module as blocked.
The credentials stay server-side and are never returned in setup/module JSON
payloads. Address fields remain normal editable inputs in every state, so users
can save a full manual address when autocomplete is disabled, unconfigured,
rate-limited, or temporarily unavailable.

## Sentry

| Variable                                  | Description                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`                              | Server/edge Sentry DSN.                                                                                          |
| `NEXT_PUBLIC_SENTRY_DSN`                  | Browser Sentry DSN.                                                                                              |
| `SENTRY_ORG`                              | Sentry organization slug for source map uploads.                                                                 |
| `SENTRY_PROJECT`                          | Sentry project slug for source map uploads.                                                                      |
| `SENTRY_AUTH_TOKEN`                       | Sentry auth token for source map uploads during build.                                                           |
| `OBSERVABILITY_SENTRY_DEDUP_COOLDOWN_MS` | Optional in-process cooldown for Sentry event deduplication, shared by the cron/webhook bridge and the auth-bounce anomaly alert (#1669); defaults to 300000 ms. |
| `AUTH_BOUNCE_AUDIT_MAX_WRITES_PER_MINUTE` | Optional per-process cap on durable auth-bounce `AuditLog` rows per minute (#1669); suppressed rows are tallied onto the next written row. Defaults to 10. |

## Cron, Waitlist, And Backups

| Variable                              | Description                                                                 |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `CRON_ENABLED`                        | Enables scheduled jobs in a runtime. Blue/green web slots set this `false`. |
| `CRON_LEADER_RUNTIME_STATUS_URL`      | Optional internal URL Admin > System Health uses to query the cron leader's runtime status (Compose defaults to the `app` service). |
| `WAITLIST_OFFER_HOURS`                | Waitlist offer expiry window; defaults to 48 hours.                         |
| `GROUP_SETTLEMENT_REAP_HOURS`         | Stale organiser-pays group settlement window; defaults to 48 hours (clamped to the group's check-in, 2-hour floor). |
| `GROUP_CANCEL_RESUME_GRACE_MINUTES`   | Grace before the group-settlement-reaper resumes a crash-interrupted organiser-cancel cleanup (#1236); defaults to 15 minutes. |
| `WAITLIST_TRANSACTION_RETRY_ATTEMPTS` | Optional waitlist transaction retry count.                                  |
| `WAITLIST_TRANSACTION_RETRY_DELAY_MS` | Optional waitlist transaction retry delay.                                  |
| `BACKUP_ENABLED`                      | Enables scheduled PostgreSQL backup job.                                    |
| `BACKUP_S3_BUCKET`                    | Optional S3 bucket for backup uploads.                                      |
| `BACKUP_S3_REGION`                    | S3 region, default `ap-southeast-2`.                                        |
| `BACKUP_S3_ACCESS_KEY_ID`             | S3 access key for backup uploads.                                           |
| `BACKUP_S3_SECRET_ACCESS_KEY`         | S3 secret key for backup uploads.                                           |
| `BACKUP_RETENTION_DAYS`               | Local backup retention window in days.                                      |
| `BACKUP_CRON_SCHEDULE`                | Cron expression for backup schedule.                                        |
| `BACKUP_RESTORE_VALIDATION_URL`       | Optional disposable database URL for restore smoke validation.              |
| `AUDIT_ARCHIVE_DATABASE_URL`          | Preferred optional archive database for audit retention.                    |
| `AUDIT_LOG_ARCHIVE_DATABASE_URL`      | Backward-compatible archive database alias.                                 |
| `SHADOW_DATABASE_URL`                 | Optional Prisma shadow database URL for migration validation.               |

## Legacy Finance Bridge

| Variable                        | Description                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEGACY_DASHBOARD_EXPORT_TOKEN` | Shared bearer token for the legacy dashboard export bridge. Leave empty to disable the export bridge unless you still run it; do not store this token in the database or client-side code. |

## Deployment And Compose

| Variable                               | Description                                                           |
| -------------------------------------- | --------------------------------------------------------------------- |
| `DOMAIN`                               | Public domain used by Caddy.                                          |
| `COMPOSE_PROJECT_NAME`                 | Docker Compose project name; defaults vary by script.                 |
| `APP_IMAGE`                            | Prebuilt app image override for blue/green deployment.                |
| `MIGRATE_IMAGE`                        | Prebuilt migration image override for blue/green deployment.          |
| `GHCR_APP_IMAGE_REPOSITORY`            | App image repository used by the production wrapper.                  |
| `GHCR_MIGRATE_IMAGE_REPOSITORY`        | Migration image repository used by the production wrapper.            |
| `GHCR_READ_TOKEN`                      | Example token name for logging a host into GHCR with `read:packages`. |
| `SOURCE_REPO`                          | Source checkout used by the production wrapper.                       |
| `DEPLOY_REF`                           | Git ref deployed by the production wrapper, default `origin/main`.    |
| `FETCH_LATEST`                         | Whether the wrapper fetches before resolving `DEPLOY_REF`.            |
| `DEPLOY_WORKSPACE_ROOT`                | Parent directory for clean deploy workspaces.                         |
| `SYNC_SOURCE_REPO_AFTER_DEPLOY`        | Whether the wrapper syncs the source checkout after deploy.           |
| `PRUNE_STALE_DEPLOY_WORKSPACES`        | Whether the wrapper removes stale deployment workspaces.              |
| `PROJECT_DIR`                          | Low-level blue/green deploy project directory.                        |
| `HEALTH_TIMEOUT_SECONDS`               | Readiness wait timeout for blue/green deploy.                         |
| `PRUNE_UNTIL`                          | Docker prune age window used by deploy scripts.                       |
| `FORCE_NO_CACHE`                       | Forces local Docker rebuilds without cache.                           |
| `SKIP_APP_IMAGE_BUILD`                 | Skips local app image build when using prebuilt images.               |
| `BLUE_GREEN_DRAIN_SECONDS`             | Drain window for previous blue/green slot.                            |
| `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` | Explicit migration safety override.                                   |
| `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` | Required explanation when allowing a breaking migration.              |
| `MIGRATION_SAFETY_LEDGER`              | Path to the migration safety ledger.                                  |

## Staging And Accessibility

| Variable                | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `STAGING_HTTP_PORT`     | Host port for the staging app.                           |
| `STAGING_POSTGRES_PORT` | Host port for the staging PostgreSQL service.            |
| `STAGING_APP_URL`       | Base URL for staging checks.                             |
| `STAGING_CADDY_SITE`    | Caddy site address for local staging.                    |
| `STAGING_A11Y_PATHS`    | Comma-separated paths for Lighthouse checks.             |
| `STAGING_A11Y_OUT_DIR`  | Output directory for Lighthouse reports.                 |
| `LIGHTHOUSE_BIN`        | Optional Lighthouse command override.                    |
| `PRODUCTION_APP_URL`    | Optional guard URL that staging checks refuse to target. |

## Public CI And Forks

Public forks should keep live provider credentials out of GitHub Actions. Use
Stripe test mode, Xero demo tenants, SES sandbox credentials, and non-production
databases for validation.
