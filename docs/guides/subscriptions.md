# Subscriptions

Audience: Operator

## What it is

Where you track and drive **annual membership-fee billing** — see each member's
subscription status per season, preview and confirm the annual billing batch,
reconcile paid status from Xero, and mark a member paid manually for cash/cheque
payments. Find it at **Admin → Members → Subscriptions** (`/admin/subscriptions`).

Subscriptions is a **finance** permission area: finance view to read status and
previews, finance **edit** to change settings, confirm billing, retry Xero
delivery, or mark a member paid. All amounts are integer cents; the season year
runs April–March by default (it follows the financial year-end month, which is
configurable — see [Subscription lockout](subscription-lockout.md)).

## When you'd use it

- It is time to invoice the year's annual membership fees.
- You are chasing unpaid or overdue subscriptions, or reconciling paid status from
  Xero.
- A member paid by cash or cheque (no Xero invoice) and you need to mark them paid.
- You are switching the club between family and individual billing.

## Step-by-step

### Review subscription status

1. Go to **Admin → Members → Subscriptions**. Summary cards show Total, Paid,
   Unpaid, Overdue, and Not Required; filter by **Season Year**, **Status**, **Age
   Group**, and **Xero Contact Group**.

   ![Subscriptions page: the season/status filters, summary cards, and the members table with subscription status and Xero invoice columns](../images/admin/admin-subscriptions.png)

2. Each row shows the member, age group, Xero contact group, status, Xero invoice
   link, and paid date. Only **linked** members are checked in Xero — unlinked
   members stay *Not Invoiced* until a Xero contact is linked or created.

> **Who shows as *Not Required*.** A member's **membership type** — not their
> login role — decides whether they owe a subscription. A member shows *Not
> Required* only when their season membership type opts out (Life, School,
> Non-Member, and the operational Admin/Lodge accounts), or their age group is
> not subscription-liable. An administrator who is also an ordinary fee-paying
> member (a normal membership type) shows their real Paid / Unpaid status here,
> on their profile, in the members list, and in the CSV export — all of which
> read the same rule. To exempt someone from subscriptions, change their
> membership type; changing only their admin permission does not.
>
> **Assignment changes reconcile the current-season row.** When you assign a
> REQUIRED-type season membership to a member who previously showed *Not Required*
> (for example an operational Admin/Lodge account being made a paying member),
> their current-season subscription row is re-derived on save from *Not Required*
> to *Not Invoiced*, so the members list, member detail, and subscription history
> immediately agree with the booking gate. Rows that carry a real Xero invoice, a
> charge/family coverage, or a manual mark-paid are never changed.
>
> The reconcile runs in the REQUIRED direction only: if you later reassign that
> member back to a Not Required type before any invoice exists, the row keeps
> showing *Not Invoiced* in the raw subscription history until the next Xero
> membership sync re-derives it. All status badges, list filters, exports, and
> the booking gate derive from the membership type and stay correct throughout —
> the stale value is visible only in the history ledger and can never cause a
> charge.
>
> **Before deploying #2149:** because membership type (not login role) now decides
> liability, audit for any operational-role accounts (Admin/Lodge) that hold a
> REQUIRED-type season assignment. The next Xero membership sync will begin
> reflecting their real subscription (Paid/Unpaid/Not Invoiced) state — this is
> intended, but worth a pre-deploy check so no operational account is unexpectedly
> invoiced. Give any such account a NOT_REQUIRED membership type (or remove the
> assignment) if it should stay exempt.

### Refresh paid status from Xero

1. Click **Incremental Sync** for the normal low-cost refresh, or **Repair Stale
   Linked Members** for a broader backfill of linked members that may be stuck.

### Run the annual billing batch

1. In **Annual Membership Fee billing**, set the **Decision date** and click
   **Refresh preview**. Confirm the **Invoice due days** (default 30) and the
   **Family billing mode** if needed.
2. Review the preview total, charges, and any exceptions, then click **Confirm and
   queue annual batch**. Confirmation **freezes** the fee, proration, recipient,
   family coverage, due days, and amount before Xero work is queued — it creates
   durable invoice work and cannot be undone by later fee or family changes.
3. In the **Durable charge queue**, use **Retry** on any charge that failed,
   conflicted, or is still queued.

### Mark a member paid manually

1. On a member's row (finance edit), **Mark as paid (manual)** records a payment
   made outside Xero (with an optional note) without creating an invoice. It is
   only offered when the member is unpaid and has no Xero invoice. **Mark as
   unpaid** reverses a manual payment.

## Settings reference

| Control | What it does | Default | Notes / constraints |
| --- | --- | --- | --- |
| Season Year / Status / Age Group / Xero Contact Group | Filter the member list | current season / all | Season year is April–March |
| Incremental Sync | Low-cost Xero paid-status refresh | — | Only checks linked members |
| Repair Stale Linked Members | Broader backfill for stuck linked members | — | Slower; linked members only |
| Decision date | The date the billing preview is computed for | today | NZ date-only |
| Invoice due days | Days until an annual invoice is due | 30 | Integer 1–365 |
| Family billing mode | Bill families via a billing member, or bill members individually | via billing member | Per-family fee schedules require billing-member mode |
| Confirm and queue annual batch | Snapshot the previewed charges and queue Xero work | — | Freezes fee/recipient/amount; cannot be undone by later changes |
| Retry (charge) | Re-attempt a failed/queued charge | — | Idempotent per charge |
| Mark as paid (manual) / unpaid | Record/reverse a non-Xero payment | — | Only when unpaid with no Xero invoice; never calls Xero |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| The billing panel and Actions column are read-only | Your finance role is view-only | Ask a finance-edit admin |
| A member stays "Not Invoiced" | They have no Xero contact link | Link or create a Xero contact in [Members](members.md), then run a refresh |
| A sync fails | Xero is disconnected or errored | Check the Xero connection in the [Xero Sync guide](xero.md) |
| **Mark as paid (manual)** isn't offered | The row already has a Xero invoice, is already paid, or is not required | Record the payment against the invoice in Xero instead |
| A per-family fee raised an exception | The club bills individually but the schedule is per-family | Re-base the schedule to per-member/no-invoice in [Fees](fees.md), or switch the family billing mode here |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [Finance dashboard](../finance-dashboard/README.md), and the
  [Xero subsystem](../xero/ARCHITECTURE.md).
- Sibling guides: [Fees](fees.md), [Members](members.md),
  [Subscription Lockout](subscription-lockout.md), [Xero Sync](xero.md),
  [Family Groups](family-groups.md).
- Reference: the
  [membership subscription charge lifecycle](../STATE_MACHINES.md#membership-subscription-charge-lifecycle)
  and
  [member subscription status transitions](../STATE_MACHINES.md#member-subscription-status-transitions),
  the [membership subscription billing](../../CONFIGURATION.md#membership-subscription-billing)
  and [manual mark-paid](../../CONFIGURATION.md#manual-mark-paid-clubs-that-do-not-use-xero-or-cash-payments)
  references, and the
  [subscription invoice workflow](../AUTHORITATIVE_FEES.md#subscription-invoice-workflow)
  in `AUTHORITATIVE_FEES.md`.
