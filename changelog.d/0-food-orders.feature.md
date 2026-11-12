- **Food orders: members can order food for a lodge stay, and the food officer
  is emailed each order** (fork #121). A new **Food orders** module, off until an
  admin turns it on under **Admin → Setup → Modules**, adds an **Order food** page
  (a dashboard card beside **Report an issue**) where a signed-in member chooses
  the lodge and the date the food is needed by, adds one line per item (a
  description and a whole-number quantity from 1 to 999, up to 50 lines) and an
  optional note. The order is saved as Open and then emailed to the address in
  the new **Food Orders** settings (**Admin → Lodge Operations → Food Orders**),
  which also holds what the club calls the role ("Food officer" by default). The
  address is checked only as a valid email address; with none set, the page says
  ordering is not set up and takes no orders. Organisation accounts cannot order.
- **Hut leaders and committee members close food orders and record what they
  cost.** The **Food orders** history shows members their own orders, and shows
  committee members, a hut leader at a lodge today and Lodge Operations admins
  every order, filterable by lodge, status and needed-by dates, with the order
  count and the total of recorded prices for the filter. A committee member, a
  hut leader whose access window covers today at that order's lodge, or a Lodge
  Operations edit admin can mark an order **Received** (two clicks at once close
  it once) and can record or change its price at any time. Every price change is
  audited with the old and new amounts. The price is a record only: nothing is
  charged, invoiced, posted to the booking ledger or sent to Xero. The four new
  audit writers (order placed, received, price changed, settings saved) are all
  in the `lodge` category.
