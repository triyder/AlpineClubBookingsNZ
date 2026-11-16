# File-size allowances for fork #118 (work parties: calendar, dashboard, Join)

Four already-over-budget files grow by wiring only. The logic itself went to
new modules written to their own ceilings: `work-party-calendar.ts`,
`calendar-work-party-entries.ts`, `work-party-member.ts`,
`work-party-access.ts`, `work-party-dashboard-card.tsx`,
`use-work-party-prefill.ts`, and `event-details-view.tsx` (which also takes the
calendar dialog's read-only view out of `event-dialog.tsx`, leaving that file
shorter than its base). `calendar-service.ts` stays under its budget.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 664
reason: the work party card gains an "On calendar" badge, an "Add to calendar"
  button and its click handler, and a notice when a save could not update the
  calendar. They sit beside the card's existing Edit, Activate and Delete
  buttons and handlers, which this page keeps inline; moving only the new one
  out would split one row of buttons across two files.

file: src/app/(authenticated)/book/page.tsx
lines: 650
reason: one status line for a Join link that could not be filled in, placed
  with the page's other top-of-page notices.

file: src/app/(authenticated)/dashboard/page.tsx
lines: 1039
reason: the members-only gate and one query for the new Work Parties card (the
  card is its own component), and the Events card query now hides an inactive
  work party's entries. The gate and query sit with the other cards' gates and
  queries in this page, which reads everything once for the whole dashboard.
  Fork #121's Order food card (its own component) adds two imports and its
  module- and organisation-gated render beside "Report an issue".

function: src/app/(admin)/admin/work-parties/page.tsx#AdminWorkPartiesPage
lines: 499
reason: the same badge, button, handler and calendar notice, inside the page
  component that holds every other card action and its handler.

function: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts#useBookingWizard
lines: 2468
reason: the call to `useWizardWorkPartyPrefill` (the prefill and its wizard
  adapter live in `use-work-party-prefill.ts`), the one-line tick inside the
  working-bee response handler, whose sequence guard stops a stale response
  from ticking it, and the notice in the hook's return. The file itself is
  under its base length: two pure helpers moved to `booking-wizard-guest-list.ts`.

function: src/app/(authenticated)/book/page.tsx#BookPage
lines: 624
reason: the Join notice, with the page's other top-of-page notices.

function: src/app/(authenticated)/dashboard/page.tsx#DashboardPage
lines: 863
reason: the Work Parties and Order food cards' gates, queries and renders,
  which sit with every other card's in this one page component.
