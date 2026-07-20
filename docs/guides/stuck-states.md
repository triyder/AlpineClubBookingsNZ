# Stuck States

Audience: Operator

## What it is

A single operator queue for records that have got **stuck** — a payment that
never settled, a booking mid-transition, a Xero sync that didn't complete, an
email that exhausted its retries, a waitlist or bed-allocation edge case. Each
signal is grouped by domain, ranked by severity, given an owner, and linked
straight to the screen where you fix it. Find it at **Admin → Monitoring & Support → Stuck States**
(`/admin/stuck-states`).

The page is read-only and computed on each visit (it shows when it was
generated). It complements [System Health](health.md) (which watches services)
by watching **data** — see [`ARCHITECTURE.md`](../ARCHITECTURE.md)
(stuck-state dashboard).

## When you'd use it

- Your daily sweep for anything that silently fell out of a normal flow.
- A member reports a payment or booking that's "stuck" and you want to find and
  clear it fast.
- After an incident (provider outage, failed deploy) to catch records left
  mid-transition.

## Step-by-step

### Work the queue

1. Go to **Admin → Stuck States**. The summary tiles show the count of
   **Critical**, **Warning**, and **Info** records and the total open signals.

   ![Stuck States with severity summary tiles, per-domain cards, and the operator queue table linking each signal to its fix screen](../images/admin/admin-stuck-states.png)

2. Scan the **per-domain cards** (payment, booking, Xero, email, waitlist, bed
   allocation, lodge) for where the problem is.
3. In the **Operator Queue** table, each row names the signal, its severity, its
   owner, and a count. Click **Open** to go straight to the screen that resolves
   it. An empty queue shows "No stuck states found."

## Settings reference

The page has no settings. What it shows:

| Element | Meaning |
| --- | --- |
| Summary tiles | Counts of Critical / Warning / Info records and total open signals |
| Domain cards | Per-domain (payment, booking, Xero, email, waitlist, bed allocation, lodge) counts and highest severity |
| Operator Queue | One row per signal: domain, description, severity, owner, count, and an **Open** link to the fix screen |
| Generated timestamp | When the dashboard was last computed (shown in the header) |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| A signal reappears after you act | The underlying record is still in the stuck state | Follow the **Open** link and complete the resolution there; the signal clears on the next generation |
| A payment/Xero signal is Critical | A settlement or sync didn't complete | Open it and reconcile; see [Payments](payments.md) / [Xero Sync](xero.md) |
| An email signal shows exhausted failures | Delivery retries ran out | Investigate in [Email Deliverability](email-deliverability.md) |
| Counts look stale | The dashboard is computed per visit | Reload the page to regenerate |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling monitoring guides: [System Health](health.md),
  [Background Jobs](background-jobs.md), [Email Deliverability](email-deliverability.md),
  [Audit Log](audit-log.md).
- Reference: the stuck-state dashboard in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
