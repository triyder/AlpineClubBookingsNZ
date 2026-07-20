# Integrations

Audience: Operator

## What it is

The hub for connected external services used by accounting and other
provider-backed workflows. Today it holds one card — **Xero Setup** — which
opens the Xero connection and accounting configuration used by finance. Find it
at **Admin → Setup & Configuration → Integrations** (`/admin/integrations`).

> **Feature-gated — no screenshot in the demo seed.** This route is gated by the
> `xeroIntegration` module (see [Modules](modules.md) and
> `src/config/feature-routes.ts`). The demo/staging seed leaves Xero **off**
> (the `xeroIntegration` module defaults off), so `/admin/integrations` returns
> a 404 there and the documentation screenshot harness captures nothing for it —
> exactly like the [Xero Sync](xero.md) and [Internet Banking](internet-banking.md)
> guides. This guide therefore describes the screen in prose; enable the Xero
> integration module to reach the live page.

## When you'd use it

- You're connecting the club's Xero organisation for the first time.
- You need to re-authorise or reconfigure the Xero connection or its accounting
  mappings.
- You're checking which provider integrations are available to enable.

## Step-by-step

### Open Xero setup

1. Enable the **Xero integration** module on [Modules](modules.md) (the
   Integrations sidebar entry and route stay hidden until it is on).
2. Go to **Admin → Setup & Configuration → Integrations**. The hub shows the
   **Xero Setup** card.
3. Open **Xero Setup** (`/admin/xero/setup`) to connect Xero and configure the
   accounting settings finance workflows rely on. The connection, sync,
   reconciliation ledger, and records browser are documented in the
   [Xero Sync](xero.md) guide and [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md).

## Settings reference

| Card | What it opens | Requires |
| --- | --- | --- |
| Xero Setup | The Xero connection and accounting configuration (`/admin/xero/setup`) | The `xeroIntegration` module; Xero OAuth credentials and tenant tokens configured server-side |

Integrations is a **support**/**finance** area hub; the Xero credentials
themselves are configured outside this table (see [`CONFIGURATION.md`](../../CONFIGURATION.md)
and [`DEPLOYMENT.md`](../../DEPLOYMENT.md)).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/admin/integrations` shows a 404 | The `xeroIntegration` module is off | Enable it on [Modules](modules.md) |
| No Integrations entry in the sidebar | Same — the module gates the sidebar link too | Enable the module and reload |
| Xero Setup won't connect | Xero OAuth credentials/tenant tokens aren't configured server-side | Configure them per [`CONFIGURATION.md`](../../CONFIGURATION.md); see [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md) |

## Related links

- Back to the [documentation hub](../README.md).
- Sibling guides: [Modules](modules.md), [Setup](setup.md),
  [Xero Sync](xero.md), [Internet Banking](internet-banking.md).
- Reference: [`xero/ARCHITECTURE.md`](../xero/ARCHITECTURE.md),
  [`CONFIGURATION.md`](../../CONFIGURATION.md), and [`DEPLOYMENT.md`](../../DEPLOYMENT.md).
