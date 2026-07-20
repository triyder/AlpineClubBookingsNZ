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

**Members are never double-billed.** The preview skips any member whose season
subscription is already **paid** *or* already carries a **live Xero invoice**
(status Unpaid, Overdue, or Paid — including invoices raised by the older Xero
sync path that pre-date the durable charge queue). A manually marked-paid member
(cash, no Xero invoice) is skipped too. Skipped members with a live invoice are
listed — with their invoice number — under the collapsed **Already invoiced**
panel below the preview, so you can see exactly who was suppressed and why, and
they are never included in a confirmed batch.

**Voided/deleted invoices re-open billing.** If you **void or delete** a
member's subscription invoice in Xero, the next paid-status refresh clears the
local invoice link, marks the underlying durable charge **Voided** (kept for
audit, never retried), and releases its coverage so the member becomes
**re-billable**. A fresh preview then lists them again, and confirming produces a
**new** charge and invoice. A voided invoice no longer counts as an outstanding
"Unpaid" subscription, so it also stops [locking the member out of
bookings](subscription-lockout.md) — void an invoice only when you intend to
re-bill or clear the obligation.

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
| A member is missing from the preview | They are already paid, or already hold a live Xero invoice for the season | Check the collapsed **Already invoiced** panel; record payment against the existing invoice in Xero, or void it there to re-bill |
| A voided-invoice member still won't re-bill | The paid-status refresh has not run since you voided the invoice in Xero | Run **Incremental Sync** (or the daily refresh), then refresh the preview — the member reappears with a new charge |
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
