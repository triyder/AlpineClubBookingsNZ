# Integrations

Audience: Operator

## What it is

The hub for connected external services used by accounting and other
provider-backed workflows. It holds a card per integration — **Xero Setup**,
**Stripe Setup**, **Google sign-in Setup**, and **Database Backups** — and each
card opens that provider's own setup page. Find it at **Admin → Setup &
Configuration → Integrations** (`/admin/integrations`).

> **The hub itself is not feature-gated (#2216).** `/admin/integrations` is
> deliberately *not* listed under any module flag in
> `src/config/feature-routes.ts`, so the hub renders whenever any integration
> module is on. Each card is feature- and permission-filtered individually by
> `AdminHubPage`, and every destination keeps its own gate — so the hub simply
> shows whichever integrations are enabled for the current admin. In particular
> the **Xero Setup** card (and the `/admin/xero/*` routes behind it) stays gated
> by the `xeroIntegration` module: with Xero off the card is absent but the hub —
> and the other cards / their back-links to it — remain reachable. The
> demo/staging seed leaves Xero **off** (the `xeroIntegration` module defaults
> off), so the documentation screenshot harness captures the hub without its Xero
> card; this guide describes the Xero flow in prose. Enable the Xero integration
> module to reach the live Xero Setup page.

## When you'd use it

- You're connecting the club's Xero organisation for the first time.
- You need to re-authorise or reconfigure the Xero connection or its accounting
  mappings.
- You're checking which provider integrations are available to enable.

## Step-by-step

### Open Xero setup

1. Enable the **Xero integration** module on [Modules](modules.md) (the Xero
   Setup card and the `/admin/xero/*` routes stay hidden until it is on; the
   Integrations hub itself remains reachable regardless).
2. Go to **Admin → Setup & Configuration → Integrations**. With Xero enabled the
   hub shows the **Xero Setup** card.
3. Open **Xero Setup** (`/admin/xero/setup`) to connect Xero and configure the
   accounting settings finance workflows rely on. The connection, sync,
   reconciliation ledger, and records browser are documented in the
   [Xero Sync](xero.md) guide and [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md).

## Settings reference

| Card | What it opens | Requires |
| --- | --- | --- |
| Xero Setup | The Xero connection and accounting configuration (`/admin/xero/setup`) | The `xeroIntegration` module; Xero OAuth credentials and tenant tokens configured server-side |
| Database Backups | The guided backup setup wizard (`/admin/backups/setup`): S3 credentials, destination, nightly schedule, and a verification run | Support view; the S3 credentials and destination writes require Full Admin. See [Database Backups](backups.md) |

Integrations is a **support**/**finance** area hub; the Xero credentials
themselves are configured outside this table (see [`CONFIGURATION.md`](../../CONFIGURATION.md)
and [`DEPLOYMENT.md`](../../DEPLOYMENT.md)).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| No **Xero Setup** card on the Integrations hub | The `xeroIntegration` module is off (the hub still renders; only its Xero card is hidden) | Enable it on [Modules](modules.md) |
| `/admin/integrations` shows a 404 | No integration surfaces are reachable at all, or the admin layout gate blocks you | Confirm you have an integration/finance/support area role; the hub itself is not module-gated (#2216) |
| Xero Setup won't connect | Xero OAuth credentials/tenant tokens aren't configured server-side | Configure them per [`CONFIGURATION.md`](../../CONFIGURATION.md); see [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md) |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Modules](modules.md), [Setup](setup.md),
  [Xero Sync](xero.md), [Internet Banking](internet-banking.md).
- Reference: [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md),
  [`CONFIGURATION.md`](../../CONFIGURATION.md), and [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
