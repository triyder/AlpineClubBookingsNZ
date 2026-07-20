# Paying for your stay

Audience: Member, Guest

## What it is

How you settle what a booking costs — by **card** (Stripe) or by **internet
banking** against a Xero invoice, where your club offers it — plus how **account
credit** and **split charges** for non-member guests work. You pay either inside
the booking wizard's **Pay** step or later from the booking's **Complete
Payment** card (`/bookings/<id>`). The payment states are in
[`STATE_MACHINES.md`](../STATE_MACHINES.md#payment-lifecycle).

## When you'd use it

- You have just finished the booking wizard and money is due.
- You closed the wizard before paying and need to finish from your booking page.
- Your club uses internet banking and you want to pay a Xero invoice by bank
  transfer instead of by card.
- You have **account credit** from an earlier cancellation and want it applied.

## Step-by-step

### Pay by card (Stripe)

1. On the **Pay** step of the wizard, or the **Complete Payment** card on your
   booking page, choose the card option and enter your card details.
2. The headline shows exactly what you are being charged now:
   - A normal booking shows **Total: $X** — the whole amount.
   - A **split** booking (a Members First hold, see below) shows **Charged today:
     $X** — only your **member** portion — with a second line naming the
     non-member guest portion that is "charged closer to your stay".
3. Confirm the payment. On success the booking moves to a paid state and you get
   a booking-confirmation email. The booking page is always the live source of
   truth if a confirmation, payment, or cancellation email goes missing.

The figures come from the server, not from arithmetic in your browser, so the
"charged today" amount always matches what is actually taken.

### Pay by internet banking (Xero invoice)

If your club has internet banking enabled and your stay is far enough ahead of
the club's lead-time cutoff, you can choose **Internet Banking** instead of card:

1. Choose the internet-banking option. The club raises a **Xero invoice** and
   emails you the payment instructions. That invoice email is always sent — it is
   your instruction to pay — regardless of any other notification choice.
2. Pay the invoice by bank transfer using the reference on it. Your bed is held
   under the club's internet-banking lead-time rules while the transfer clears.

Operators manage the bed-hold and lead-time settings with the
[Internet Banking](../guides/internet-banking.md) guide.

### Use account credit

If you hold **account credit** (for example from a cancelled paid booking), your
current balance shows on your profile under **Account Credit** (`/profile`, the
Account Credit section). Credit is applied toward what you owe the club; your
dashboard's **Account Credit** card links straight to it. How a cancellation
produces credit rather than a card refund is covered in
[Changing or cancelling a booking](changing-or-cancelling-a-booking.md).

## Split charges for non-member guests

When a **Members First** hold splits a mixed party (your members are booked now,
your non-member guests are held provisionally), the money is split too:

- **Today** you are charged only your **member** portion — the pay screen reads
  "Charged today: $X".
- The **non-member guest portion** is **auto-charged to the same card around the
  hold deadline**, if beds still remain. If no bed remains, those guests are
  bumped and you are not charged for them.
- If you paid your own place by **internet banking** (so there is no card on
  file for the later guest charge), the club warns you and can email you a secure
  **pay link** (`/pay/<token>`) to settle the guest portion yourself. If a guest
  portion reaches its deadline still unpaid, the club emails you a payment link
  and extends the hold; if it is still unpaid at the end of check-in day, that
  provisional guest booking is automatically cancelled — **your own place is
  untouched**.

The booking side of this split is described in
[Booking a stay](booking-a-stay.md#3-review-confirm-and-the-hold-policies).

## What it costs / what to expect

| Payment path | What to expect |
| --- | --- |
| Card (Stripe) | Charged immediately; booking confirmed on success |
| Card, split booking | "Charged today" is your member portion; guest portion charged near the hold deadline |
| Internet banking | Xero invoice emailed; pay by transfer; bed held per lead-time rules |
| Account credit | Applied toward what you owe; balance shown on your profile |
| Payment failed | Booking stays unpaid with a **Complete Payment** card — retry from there |

All amounts are shown in dollars, formatted from the integer cents the club
stores. Settlement rules are in
[`DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md#payment-and-settlement).

## Troubleshooting

| Symptom | Why it happens | What to do |
| --- | --- | --- |
| Booking still says "Payment required" after you paid | The card step was interrupted, or payment did not complete | Open the booking and retry from the **Complete Payment** card |
| You do not see an internet-banking option | Your club has not enabled it, or your stay is inside the lead-time cutoff | Pay by card instead |
| Your card was declined | A normal card failure | Try another card from the **Complete Payment** card |
| The invoice email never arrived | It may be in spam | Check spam; the booking page always shows what is owed even without the email |
| You expected credit to be applied | Credit shows but was not used | Check the **Account Credit** section on your [profile](your-account.md); contact the club office if it looks wrong |
| Your non-member guests were bumped | No bed remained at the hold deadline | Their provisional hold lapsed; your own place stands — re-add them if beds free up |

## Related links

- Back to the [Member & Guest Guide](README.md) and the
  [documentation hub](../README.md).
- Sibling guides: [Booking a stay](booking-a-stay.md),
  [Changing or cancelling a booking](changing-or-cancelling-a-booking.md).
- Reference: the [payment lifecycle](../STATE_MACHINES.md#payment-lifecycle) and
  [payment & settlement invariants](../DOMAIN_INVARIANTS.md#payment-and-settlement).
  Operators use the [Payments](../guides/payments.md) and
  [Internet Banking](../guides/internet-banking.md) guides.
