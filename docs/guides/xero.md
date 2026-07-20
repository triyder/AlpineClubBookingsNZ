# Xero Sync

Audience: Operator

## What it is

The dashboard for the club's operational **Xero** integration: monitor the
connection, run contact and membership syncs, work the outbound operations queue
and inbound webhook events, audit contact-group and link mismatches, and watch the
daily API budget. Day-one **account/item mappings and one-time import** live on a
separate **Xero Setup** page, and auto-grouping rules on the **Xero member
grouping** page. Find the dashboard at **Admin → Finance → Xero Sync**
(`/admin/xero`).

Xero is a **finance** permission area: finance view to read, finance **edit** to
run syncs, retry operations, replay events, or change mappings and rules. Most
panels appear only once Xero is connected. Xero pushes and reconciliation are
idempotent — retrying the same work never double-charges.

## When you'd use it

- You are connecting Xero for the first time, or reconnecting it.
- A booking invoice, payment, or subscription did not sync and you need to retry or
  investigate it.
- You want to import members from Xero contacts, repair link mismatches, or audit
  contact-group membership.
- You are checking the daily Xero API budget or reconciliation health.

## Step-by-step

### Check the connection and health

1. Go to **Admin → Finance → Xero Sync**. The **Connection Status** panel shows
   whether Xero is connected (and the tenant/token), and the **Health Snapshot**
   summarises unlinked members, failed issues, pending operations, group/link
   mismatches, and API budget.

   > The whole Xero area (`/admin/xero`, `/admin/xero/*`, `/admin/internet-banking`)
   > is gated by the **Xero integration** module (`src/config/feature-routes.ts`)
   > and returns *Not Found* when it is off. The demo seed leaves Xero disabled,
   > so no screenshots are captured for these pages; enable the module to see them.

2. Use **Connect Xero** / **Disconnect Xero** on the connection panel.
   Disconnecting stops invoicing, payment reconciliation, subscription paid-status
   detection, and finance syncs until you reconnect (your data inside Xero is not
   changed).

### Run syncs and work the queues

1. **Contact Sync** runs a broad link pass (**Sync Contacts from Xero**) or a
   **Targeted force sync** to repair a single member, invoice, or membership.
2. **Membership Status Refresh** checks Xero invoices for active members
   (**Incremental Refresh** or **Repair Backfill**) — this also runs as a daily
   cron, and only linked members are refreshed.
3. **Xero Operations** lists outbound sync attempts; retry active failures, reset
   stale running jobs, or mark an individual operation non-replayable / resolved.
   **Inbound Events** lists stored webhooks with a per-event **Replay**.

### Create or link a member's Xero contact

1. On a member's admin page (or the members-list editor), the **Xero** panel lets
   you **link** an existing Xero contact or **create** a new one.
2. **Creating a contact needs only a first name, last name, and email.** Email is
   required because Xero uses it for invoice delivery and contact matching;
   everything else — phone, date of birth, joined date, and both the postal and
   physical addresses — is optional. Xero's contact-create API itself requires
   only a unique contact name.
3. When optional profile fields are blank the panel shows a small note (e.g.
   *"Profile incomplete: postal address, joined date — missing details will
   simply be left off the Xero contact"*) and still lets you create the contact. Blank
   addresses and an all-blank phone are simply omitted from the payload rather
   than sent as empty blocks. Date of birth and joined date are never sent to
   Xero on create; the joined date round-trips only through Xero's *company
   number* field on the import/backfill path.
4. Before a brand-new contact is created the app checks for **similar existing
   Xero contacts** and asks you to confirm if any are found, so link an existing
   contact where one already exists.

### Set up mappings and import (Xero Setup)

1. Open **Xero Setup** (`/admin/xero/setup`, back-linked from **Integrations**) to
   configure account and item **mappings** and run one-time import/link tools.
2. **Import Members from Xero** maps each contact group to an age tier and can send
   invite emails; **Repair Canonical Links** and **Scan for Duplicates & Family
   Groups** clean up the link ledger.

### Manage auto-grouping (Xero member grouping)

1. **Xero member grouping** (`/admin/xero/member-grouping`, also linked from the
   sidebar) chooses the grouping **mode** (None / Membership Type / Membership Type
   + Age) and the **rules**. Each rule can target a **set of age tiers** — tick
   any subset, or tick none for **"All age tiers"** (the wildcard). When rules
   overlap, the **most specific wins**: `type + tiers` beats `type-only` beats
   `tiers-only`, and among tiered rules **fewer tiers is more specific** (an
   "all age tiers" rule is the least specific). A **"Refresh from Xero"** button
   re-pulls the contact-group cache and a **"Last synced"** header shows when it
   last refreshed; a read-only **dry-run diff** must be reviewed before any
   heavyweight **bulk re-sync**. Changing a mode or rule (including a tier set),
   or refreshing from Xero, never re-groups existing members automatically and
   invalidates any prior dry-run. For the full cutover procedure, follow the
   [Xero member grouping runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md).

## Settings reference

| Area | What it does | Notes / constraints |
| --- | --- | --- |
| Connect / Disconnect Xero | Establish or remove the operational Xero connection | Finance edit; disconnect stops invoicing/reconciliation/paid-status |
| Contact Sync / Targeted force sync | Broad or single-record contact link/repair | Finance edit |
| Membership Status Refresh | Refresh current-season paid status from Xero | Also a daily cron; linked members only |
| Xero Operations | Retry / reset / mark non-replayable / resolve outbound work | Finance edit; idempotent |
| Inbound Events | Replay stored webhook events | Finance edit |
| Xero Setup → Mappings | Account/item code mappings and hut/joining fee item codes | Finance edit; joining-fee amounts live in [Fees](fees.md) |
| Member grouping | Grouping mode + rules, dry-run, bulk re-sync | Finance edit; never auto-re-groups; runbook-driven cutover |
| API budget / Usage | Daily call volume, rate limits, recent failures | Read-only meter |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Only the Connection panel shows | Xero is not connected | Click **Connect Xero**; the sync/health panels appear once connected |
| Operations/events are read-only ("… can view Xero operations but cannot retry…") | Your finance role is view-only | Ask a finance-edit admin |
| An outbound operation is stuck **Failed** | A push failed and needs a replay (or was fixed directly in Xero) | **Retry in background**, or **Resolve (fixed in Xero)** with a reason |
| A member's grouping looks wrong | The mode/rules changed but existing members were not re-grouped automatically | Run the **dry-run diff**, then **bulk re-sync** per the [runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md) |
| A bulk re-sync halted | The daily Xero API limit was reached | Use **Resume re-sync** the next day |
| Subscription paid-status isn't updating | The member has no Xero contact link | Link/create a contact, then run a membership refresh |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: the [Xero subsystem architecture](../xero/ARCHITECTURE.md) and the
  [Finance dashboard](../finance-dashboard/README.md).
- Sibling guides: [Subscriptions](subscriptions.md), [Payments](payments.md),
  [Internet Banking](internet-banking.md), [Members](members.md).
- Reference: the
  [Xero outbox and reconciliation lifecycle](../STATE_MACHINES.md#xero-outbox-and-reconciliation-lifecycle),
  the [Xero member grouping runbook](../XERO_MEMBER_GROUPING_RUNBOOK.md),
  [operational Xero](../ARCHITECTURE.md#operational-xero) and the
  [Xero member grouping](../../CONFIGURATION.md#xero-member-grouping) reference,
  and the [Xero member grouping invariants](../DOMAIN_INVARIANTS.md#xero-member-grouping-e8-1934).
