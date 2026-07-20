# Changing or cancelling a booking

Audience: Member

## What it is

How to change a booking (dates, guests, or a promo code), how to cancel one, and
how to tell whether you get money back to your card or as **account credit**. You
do all of it from the booking's own page, opened from **My Bookings**
(`/bookings/<id>`). Booking changes follow the
[modification lifecycle](../STATE_MACHINES.md#booking-modification-lifecycle) and
settlements follow the
[refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle).

This is about cancelling a **lodge booking**. Cancelling your **membership** is a
different journey — see [Cancelling your membership](#cancelling-your-membership)
at the end.

## When you'd use it

- Your plans changed and you need different dates or a different number of
  guests.
- You want to apply a promo code to an existing booking.
- You need to cancel a stay and want to know what you get back.

## Step-by-step

### Change a booking

1. Open the booking from **My Bookings** (`/bookings`) and choose to edit it.
2. Change the **dates**, **guests**, or **promo code** as allowed. Some nights
   are **locked** close to check-in and may need club review before a change
   takes effect.
3. Review the **delta** — the difference in price. If the change costs more, you
   settle the extra (see [Paying for your stay](paying-for-your-stay.md)); if it
   costs less, you may be due a refund or credit.

A member editing their own booking always triggers the standard change-notice
email, so you have a record of what changed.

### Cancel a booking — and check the refund first

1. Open the booking. Its help/status dialog shows the **booking status glossary**
   and, once a payment has been captured, the **cancellation refund schedule**
   that applies — so you can see the refund consequence **before** you start the
   cancellation.
2. Start the cancellation and confirm. Whether you get money back, and how much,
   depends on how close to check-in you cancel and your club's policy:
   - **Refund to card** or **account credit** for a paid booking, per the
     schedule.
   - If the booking is **unpaid** but still cancellable, you simply see "no
     payment received / no refund" instead of refund tiers — there is nothing to
     refund.
3. The booking footer reminds you that the booking page is the **live source of
   truth** if a confirmation, payment, or cancellation email goes missing.

### Refund versus account credit

Depending on the club's settings and how the booking was paid, a cancellation
either refunds your **card** or adds **account credit** to your profile (shown in
the **Account Credit** section, `/profile`). Account credit is applied toward
what you owe on a future booking — see
[Paying for your stay](paying-for-your-stay.md#use-account-credit). The exact
tiers (how many days before check-in return what percentage) are a club policy;
your booking's dialog shows the schedule that applies to you, and operators set
it in the [Booking Policies](../guides/booking-policies.md#default-cancellation-policy)
guide.

## What to expect

| Situation | What to expect |
| --- | --- |
| Change costs more | You settle the extra (delta) before the change is complete |
| Change costs less | A refund or account credit for the difference |
| Nights are locked (near check-in) | The change may need club review before it applies |
| Cancel a paid booking | Refund to card or account credit, per the cancellation schedule |
| Cancel an unpaid booking | No payment was taken, so no refund — the booking is simply cancelled |
| Confirmation/cancellation email missing | The booking page always shows the true current state |

All amounts are shown in dollars. Refund/credit timing and eligibility follow the
[refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle).

## Cancelling your membership

Cancelling your **membership** (leaving the club) is separate from cancelling a
booking. You start it from the **Membership Cancellation** section of your
[profile](your-account.md) (`/profile`); adult participants confirm their own
inclusion where required, and an admin reviews it.

The money rules are set out in
[`CANCELLATIONS.md`](../CANCELLATIONS.md#refund-policy): **paid** membership
subscriptions are **not refunded** — cancelling stops future obligations but
money already paid stays with the club — while **unpaid or overdue** subscription
invoices are cleared in the club's accounting (a Xero credit note) so they are no
longer due. A family cancellation processes each participant independently. The
full lifecycle is in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#membership-cancellation-archive-and-delete-lifecycle).
If you instead want your data removed entirely, see the privacy and
account-deletion rights in [Managing your account](your-account.md#privacy-and-data).

## Troubleshooting

| Symptom | Why it happens | What to do |
| --- | --- | --- |
| You cannot change the dates | The nights are locked close to check-in | The change may need club review — contact the club office |
| A date change is rejected mentioning a locked period | The booking has an issued invoice in a locked accounting period | Contact an administrator, as the message says |
| You expected a card refund but got account credit (or vice versa) | The outcome depends on how the booking was paid and club settings | Check the **Account Credit** section on your profile; contact the office if it looks wrong |
| Cancelling shows "no refund" | The booking was never paid | Nothing to refund — the booking is simply cancelled |
| Your membership-cancellation request is stuck | It is waiting on participant confirmations or admin review | Confirm your own inclusion; ask the club office if a link expired |

## Related links

- Back to the [Member & Guest Guide](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Booking a stay](booking-a-stay.md),
  [Paying for your stay](paying-for-your-stay.md),
  [The waitlist & offers](waitlist-and-offers.md).
- Reference: the
  [booking modification lifecycle](../STATE_MACHINES.md#booking-modification-lifecycle),
  the [refund & credit lifecycle](../STATE_MACHINES.md#refund-and-credit-lifecycle),
  and the [membership cancellation policy](../CANCELLATIONS.md). Operators use the
  [Booking Policies](../guides/booking-policies.md) and
  [Refunds & Credits](../guides/refund-requests.md) guides.
