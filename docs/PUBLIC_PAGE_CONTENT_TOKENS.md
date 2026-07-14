# Public PageContent Data Tokens

Content editors can place authoritative server-rendered blocks in any rich
`PageContent` body, including home, code-backed pages, catch-all pages, and the
database-backed 404. The supported data tokens are:

- `{{membership-types}}`
- `{{entrance-fees}}`
- `{{hut-fees}}` or `{{hut-fees:lodge-slug}}`
- `{{booking-policy-summary}}` or `{{booking-policy-summary:lodge-slug}}`
- `{{cancellation-policy}}` or `{{cancellation-policy:lodge-slug}}`

## Publishing workflow

1. In Admin > Page Content, enable only the data families the club intends to
   publish. Every family defaults off, and inserting a token does not enable it.
2. For membership types, also enable public listing and maintain the public
   description in Admin > Membership Types.
3. Insert the token with the editor token picker and publish the page.
4. Check the signed-out page. Missing current schedules and empty policies show
   a safe no-information state. An unknown or inactive lodge slug never falls
   back to another lodge.

Membership and entrance amounts come from current effective-dated schedules;
public entrance blocks never use deprecated Xero mappings. Hut fees use active
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
