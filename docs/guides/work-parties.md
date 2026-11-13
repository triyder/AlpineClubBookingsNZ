# Work Parties

Audience: Operator

## What it is

Working-bee events with an automatic booking discount: you set a date window and a
discount percentage, and members who tick "I am attending a working bee" when they
book nights inside that window get the discount applied automatically. Find it at
**Admin → Lodge Operations → Work Parties** (`/admin/work-parties`).

Work-party events are a **lodge** permission area: lodge view to read, lodge
**edit** to create, edit, or delete. The feature is on by default (the
`workParties` module).

## When you'd use it

- You are running a spring or autumn working bee and want to reward attendees with
  discounted nights.
- You want to see how many bookings claimed a working-bee discount and the total
  given.
- A working bee's dates or discount changed and you need to update it.

## Step-by-step

### Review the working-bee events

1. Go to **Admin → Lodge Operations → Work Parties**. Each event card shows its
   date window, discount, active state, the number of attending bookings, and the
   total discount given so far.

   ![Work Parties page showing the "July Working Bee 2026" event card with its date window, discount, attending-bookings count, and total discount given](../images/admin/admin-work-parties.png)

2. On an event with attending bookings, click **Show bookings** to expand the
   member, stay, status, and per-booking discount.

### Create or edit an event

1. Click **New Event** (or **Edit** on a card).
2. Set the **Name**, **Discount %** (a whole number 1–100), the **Start date** and
   **End date (last discounted night)**, an optional **Description**, and, with
   more than one lodge, the **Lodge** (or all lodges, club-wide). Tick **Active** so
   members can select it when booking.
3. Click **Create Event** / **Save Changes**. The discount applies to every
   attending guest's nights inside the window.

### Deactivate or delete

1. Use **Deactivate**/**Activate** to control whether members can select the event.
2. **Delete** is available only while an event has **no** attending bookings; once
   bookings have claimed it, deactivate it instead to preserve the discount history.

### Add an existing booking to a work party

For a member who booked nights inside a work party but forgot to tick "I am
attending a working bee". You need **bookings edit** (a Booking Officer or Full
Admin).

1. Open the booking. In the **Admin tools** card, click **Add to work party**.
2. Choose the work party. Only active work parties that overlap the stay are
   listed. One that cannot be used says why: it is at another lodge, none of
   the booking's nights fall inside it, or the booking already has a work party.
3. Click **Show the new total**. You see the booking's new total and how much
   comes back to the member as **account credit**.
4. Leave **Email the member about the change** ticked (or untick it), then click
   **Add to work party**.

What happens:

- The booking is repriced exactly as if the member had ticked the box when
  booking. The discount applies to each guest's nights inside the window.
- **Unpaid:** the amount owed drops.
- **Paid:** what was paid above the new total goes back as **account credit**,
  in full. It is never refunded to the card, and no cancellation-policy tier
  cuts it. A joiner's booking that the group organiser paid goes back to the
  organiser instead, as every change to such a booking does.
- **No change fee** is charged: this is an officer correcting a missed tick, not
  the member changing their stay.
- It goes through the normal booking change, so the booking's history, the
  ledger and Xero (an account credit note for a paid booking) record it like
  any other change.
- If the booking changed between the preview and the save, you are shown the
  new figures and asked to confirm again; nothing is saved meanwhile.

A booking can only be added to one work party, and only while it is current:
not cancelled, finished, a draft or on the waitlist. A stay that has already
started keeps its agreed prices, so it cannot be added. Removing a booking from
a work party is not available.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Name | The event's display name | — | Required |
| Discount % | Percent off nights in the window | 100 | Whole number 1–100 |
| Start date | First night in the discount window | — | NZ date-only |
| End date (last discounted night) | Last night in the discount window | — | NZ date-only; inclusive |
| Description | A note shown on the card | — | Optional; up to 1000 characters |
| Lodge | Which lodge the working bee is at | All lodges (club-wide) | Only shown with more than one active lodge |
| Active | Whether members can select the event when booking | on | Inactive events cannot be selected |

> Discounts are computed and stored in **integer cents**; the totals shown (e.g.
> "Total discount given") are those cents formatted as currency.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Work Parties is missing from the sidebar / 404s | The `workParties` module is off | Enable it under **Admin → Setup → Modules** — see [`CONFIGURATION.md`](../../CONFIGURATION.md#module-controls-and-admin-modules) |
| Everything is read-only ("… can view work parties but cannot change them") | Your admin role has lodge view but not edit | Ask a full admin for **lodge edit** access |
| A work party is "not available" in **Add to work party** | The booking is at another lodge, has no night inside the window, or already has a work party | The dialog names the reason; a booking can carry only one work party |
| There's no Delete button on an event | It already has attending bookings | Deactivate it instead — delete is blocked to keep the discount history |
| A member says the discount didn't apply | The event is inactive, their nights fall outside the window, or they didn't tick the working-bee option | Check the event is Active, its dates cover their nights, and that they selected it when booking |
| "Discount must be a whole number between 1 and 100" | A non-integer or out-of-range discount was entered | Enter a whole number from 1 to 100 |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Chore Roster](roster.md), [Hut Leaders](hut-leaders.md),
  [Lodges](lodges.md), [Bookings](bookings.md).
- Reference: [Admin and Lodge](../ARCHITECTURE.md#admin-and-lodge).
