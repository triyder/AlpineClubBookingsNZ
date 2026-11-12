# Food Orders

Audience: Operator

## What it is

A way for members to order food for a lodge stay, for the club's food officer
to receive each order by email, and for the people at the lodge to say the food
arrived. It has three parts:

- **Order food** (`/food-order`), in the members' area. A signed-in member picks
  the lodge and the date the food is needed by, adds one line per item (a
  description and a whole-number quantity), and can add a note. A card on the
  member dashboard, beside **Report an issue**, links to it.
- **Food orders** (`/food-orders`), the order history. Members see their own
  orders. Committee members, hut leaders at a lodge today and Lodge Operations
  admins see every order, with filters and the totals the club forecasts from.
- **Food Orders** settings (`/admin/food-orders`, **Admin → Lodge Operations →
  Food Orders**): the email address orders are sent to, and what your club calls
  the person who buys the food.

Food orders is the `foodOrders` module, **off by default**. Turn it on under
**Admin → Setup → Modules** once you have an address to send orders to. While it
is off, the order and history pages, their APIs and the settings page return Not
Found, and the dashboard card and sidebar entry are hidden. Orders already placed
are kept.

Orders are **not linked to bookings**. The food officer matches an order to a
stay by its lodge and needed-by date. Organisation accounts (schools and similar
groups) cannot order: their catering is arranged through the booking officer.

## When you'd use it

- You are setting up food ordering for the first time.
- The food officer has changed and orders need to go to a new address.
- You want to see what food was ordered for a lodge, whether it arrived, and what
  it cost.
- Food has arrived at the lodge and the order should be closed.

## Step-by-step

### Set up food ordering

1. Open **Admin → Lodge Operations → Food Orders** and click **Edit**.
2. Enter the **Email address for orders**, usually the food officer's committee
   address. The app checks only that it is a valid email address. It does not
   check it against your members or committee roles, so keeping it current when
   the role changes hands is the committee's job.
3. If your club calls the role something else, change **What your club calls
   them** (default "Food officer"). It is used on the order page, the history and
   the email.
4. Click **Save**, then turn on **Food orders** under **Admin → Setup → Modules**.

With no address saved, the order page tells members that ordering is not set up
and accepts nothing.

### Place an order (members)

1. From the dashboard, click **Order food**.
2. Choose the lodge and the **Needed by** date (today or later, in the club's own
   calendar).
3. Add one line per item. Put the unit in the description, for example "1 kg bags
   of flour", and a whole number from 1 to 999 as the quantity. Use **Add item**
   and **Remove**; an order holds 1 to 50 items.
4. Add a note if you need to, then **Send this order**.

The order is saved as **Open** first, and only then is the food officer emailed,
with every item and quantity, the note, and a link to the order. Each member can
place up to 10 orders an hour.

### Mark an order received

1. Open **Food orders** from the dashboard card.
2. Find the order and click **Mark received**. It closes: the history records who
   confirmed it and when.

Who can do this: any member with an active committee role, a hut leader whose
access window covers today **at that order's lodge** (from the day before their
first night to the day after their last), and admins with Lodge Operations
**edit**. If two people confirm at the same moment, the order is closed once and
the second is told it has already been received. A received order cannot be
reopened.

### Record the price

1. On the order in **Food orders**, enter the amount in **Price** and click
   **Save price**.
2. You can change it at any time, including after the order is received.

The same people who can mark an order received can record its price. Every
change is written to the audit log with who made it and the old and new amounts.
**The price is a record only**: it is never charged to the member, added to a
booking or invoice, posted to the booking ledger, or sent to Xero.

### Review the history and totals

Filter by **Lodge**, **Status** and a **Needed from / to** range, then **Apply**.
The summary shows how many orders match and the total of the recorded prices
(with how many of them have a price), across every page of the filter, which is
what forecasting next season's food spending needs.

## Settings reference

| Field | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| Email address for orders | Where every new order is emailed | empty | Checked only as a valid email address. Empty means ordering is not set up and orders are refused |
| What your club calls them | The officer label on the order page, history and email | Food officer | 1 to 60 characters |
| Food orders module | Whether the feature exists at all | **off** | Admin → Setup → Modules |

| Rule | Value |
| --- | --- |
| Items per order | 1 to 50 |
| Item description | Required, up to 200 characters |
| Item quantity | Whole number, 1 to 999 |
| Note | Optional, up to 1,000 characters |
| Needed by | A club calendar day, today or later |
| Orders per member | 10 an hour |
| Price | Zero or more, in cents; a record only |

The settings page is a **lodge** permission area: Lodge Operations view to read
it, edit to change it. The email to the food officer is the
`food-order-placed` template: its wording is editable under
[Email Messages](email-messages.md), and it can be muted under
[Delivery Rules](notification-rules.md) like other non-locked operational
emails; orders are still saved and shown in the history.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The pages 404 and the dashboard card is missing | The `foodOrders` module is off | Turn it on under **Admin → Setup → Modules** |
| Members see "Food ordering is not set up yet" | No email address is saved | Enter one on the Food Orders settings page |
| The food officer is not getting orders | The address is wrong or out of date, or the email is muted under Delivery Rules | Check the address on the settings page and the `food-order-placed` rule. Every order is still in the history |
| A hut leader cannot mark an order received | Their access window does not cover today, or the order is for a different lodge | A committee member or a Lodge Operations edit admin can close it |
| An organisation account cannot order | By design | Catering for organisation stays is arranged through the booking officer |
| A price save says somebody else changed it | Two people edited the price at once | Reload the history and enter the price again |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Lodge Maintenance](maintenance-reports.md),
  [Hut Leaders](hut-leaders.md), [Committee](committee.md),
  [Modules](modules.md).
- Reference: lodge scoping in
  [Lodge Scoping Contract](../multi-lodge/lodge-scoping-contract.md); integer
  cents in [money invariants](../invariants/money.md); the routes in
  [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md).
