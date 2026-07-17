# Public PageContent Data Tokens

Content editors can place authoritative server-rendered blocks in any rich
`PageContent` body, including home, code-backed pages, catch-all pages, and the
database-backed 404. The supported data tokens are:

- `{{hut-fees}}` — nightly hut fees (all lodges, or one named lodge).
- `{{joining-fees}}` — one-off joining fees, grouped by membership type or age.
- `{{annual-fees}}` — annual membership fee totals (own visibility opt-in).
- `{{booking-policy-summary}}` or `{{booking-policy-summary:lodge-slug}}`
- `{{cancellation-policy}}` or `{{cancellation-policy:lodge-slug}}`

Deprecated aliases (kept for existing pages; each renders **identically** to its
replacement through the same grouped-table renderer — prefer the new name):

- `{{entrance-fees}}` → alias of `{{joining-fees}}`.
- `{{membership-types}}` → alias of `{{annual-fees}}`.

## Fee embed parameters (#1933, E7)

The three fee embeds — `{{hut-fees}}`, `{{joining-fees}}`, `{{annual-fees}}`
(and their aliases) — accept an optional parameter after a colon. The parameter
is a comma-separated list of segments; each segment is either `key=value` or a
bare positional value:

- A **bare positional** is the lodge slug, for `{{hut-fees}}` back-compat:
  `{{hut-fees:whakapapa-river-lodge}}` still works.
- Recognised keys are `lodge=`, `type=`, `age=`, and `group-by=`.
- A value may list **multiple entries joined with `+`**, e.g.
  `group-by=type+age`.
- `by-age` (bare) is shorthand for `group-by=age`.

Examples:

- `{{hut-fees:lodge=whakapapa-river-lodge, group-by=age}}`
- `{{joining-fees:type=full}}` — one publicly-listed membership type.
- `{{joining-fees:group-by=age}}` (or `{{joining-fees:by-age}}`).
- `{{annual-fees}}` shows the fee **total** by default;
  `{{annual-fees:components}}` opts into the per-invoice-line breakdown (E6).

`type=` resolves **only** against publicly-listed membership types. An unknown
key, an unknown/unlisted `type=`, or any value the block cannot satisfy renders
the safe **no-information state** — never another group's data. The single-brace
capture is unchanged; the parameter grammar is parsed from the captured text by
`parseTokenParameters` in `src/lib/token-parameters.ts`, shared by the renderer
and the admin token-help validation.

## Block placement (D-R8)

Every fee embed renders correctly at **any position** on the page and may be
repeated. `buildEmbeddedBody` splits the page HTML at each embed token and emits
the parts in document order, so a fee block before all other content, between
two paragraphs, or twice on one page each render independently and in order. Do
not assume a fee block sits last on the page.

Inline **text** tokens are also available in page bodies, lodge instructions,
and the site footer (they render an escaped string in place, not a block):

- `{{club-name}}` — the DB-first club name (Admin > Club Identity).
- `{{hut-leader}}` / `{{hut-leader-lower}}` — the configured hut-leader role
  label (never a person's name).
- `{{lodge-capacity}}` or `{{lodge-capacity:lodge-slug}}` — a lodge's capacity.
- `{{lodge-name}}` or `{{lodge-name:lodge-slug}}` — a lodge's name.
- `{{lodge-address}}` or `{{lodge-address:lodge-slug}}` — a lodge's address
  (renders nothing when the lodge has no address set).
- `{{currency}}`, and `{{facebook-url}}` (footer only).

For the lodge text tokens the bare form resolves the **default lodge**; a
`:lodge-slug` parameter targets a named lodge, and an unknown slug falls back to
the default lodge. Edit lodge name/address under Admin > Club Identity > Lodge
details (single-lodge) or Admin > Setup > Lodges (multi-lodge).

## Publishing workflow

1. In Admin > Page Content, enable only the data families the club intends to
   publish. Every family defaults off, and inserting a token does not enable it.
   Joining fees use the **Joining fees** toggle; annual membership fees have
   their **own** dedicated **Annual membership fees** toggle (a double-opt-in,
   default off, that also governs the `{{membership-types}}` alias); hut fees use
   the **Hut fees** toggle.
2. For annual fees, also mark each membership type for public listing in Admin >
   Membership Types (only publicly-listed types appear).
3. Insert the token with the editor token picker and publish the page.
4. Check the signed-out page. Missing current schedules and empty policies show
   a safe no-information state. An unknown or inactive lodge slug never falls
   back to another lodge.

Joining- and annual-fee amounts come from current effective-dated schedules;
public fee blocks never use deprecated Xero mappings. Hut fees use active
lodge seasons/rates and configured age-tier labels. Booking summaries include
only customer-facing periods, provisional holds, minimum stays, and enabled
group discounts. Cancellation blocks include persisted default and named-period
rules, including distinct card/credit percentages and fixed fees. Their labels
mirror the settlement threshold ranges, including implicit no-refund gaps and a
separate post-check-in no-refund fallback. Disabled provisional holds are stated
explicitly rather than silently omitted.

Content-area view roles can inspect visibility but cannot change it. Content
edit roles can save it. Saves are audited with before/after state and invalidate
all PageContent-backed public routes. Authority editors for fees, seasons, and
policies likewise audit their normal writes and invalidate those routes. There
is no unauthenticated management API.

Rendering uses narrow display-only view models. Database ids, provider codes,
door codes, internal queue settings, and private descriptions are never passed
to the public renderer. Rich HTML is sanitised, while database strings render
as React text and are escaped.
