# ADR-005: Run the Finance Dashboard off the Single Operational Xero Connection

## Status

Accepted (2026-06-26). Supersedes ADR-003.

## Context

ADR-003 implemented finance reporting against a second, parallel Xero OAuth app
with its own environment variables, token store, OAuth state, daily-sync cron,
API-usage metering, and `/api/finance/xero/*` routes, all separate from the
operational Xero connection that bookings, payments, and subscriptions use.

In practice this added significant scaffolding (a separate consent flow,
encryption key, token table, and usage tables) for little benefit. The finance
report fetchers already meter their calls through the shared `callXeroApi`
path, so the second connection mostly duplicated lifecycle code and a second
re-consent burden for operators. The independent API budget that ADR-003 set out
to protect was not worth the operational and code complexity.

## Decision

Run the finance dashboard off the single operational Xero connection.

- The finance sync authenticates with `getAuthenticatedXeroClient`
  (`src/lib/xero-api-client.ts`), bound for finance use through
  `createFinanceXeroSyncConnection` (`src/lib/finance-sync-service.ts`).
- `accounting.reports.profitandloss.read`,
  `accounting.reports.balancesheet.read`, and
  `accounting.reports.banksummary.read` are included in
  `OPERATIONAL_XERO_OAUTH_SCOPES` (`src/lib/xero-config.ts`) for the
  profit-and-loss, balance-sheet, and bank-summary report fetchers. The
  chart-of-accounts dataset reuses the already-granted
  `accounting.settings.read` scope.
- The separate finance Xero stack was deleted: the `finance-xero*` modules, the
  `/api/finance/xero/*` routes, the `FINANCE_XERO_*` environment variables, and
  the `FinanceXeroToken` / `FinanceXeroApiUsage*` tables (dropped by migration
  `20260626121000_drop_finance_xero_storage_and_usage`).
- `FinanceSnapshot`, `FinanceSyncRun`, the operational `XeroToken` /
  `XeroApiUsage*` tables, and `Member.financeAccessLevel` are retained.

## Consequences

### Positive

- One Xero OAuth app, one consent flow, one token lifecycle, one usage metering
  path.
- A large amount of duplicated integration scaffolding is removed.
- Finance report data, booking data, and the reconciliation all live behind the
  same connection, which makes the revenue reconciliation straightforward.

### Negative

- The finance dashboard now depends on the operational Xero connection being
  connected; if it is not connected (or is token-expired or rate-limited) the
  finance sync run fails durably.
- A one-time re-consent is required after deploy: update the Xero developer app
  allowed scopes, verify the redirect URI, then reconnect Xero once from
  `/admin/xero` so existing tokens are replaced with tokens carrying the
  current scope set.
- The destructive table-drop migration must ship after the code that stops using
  the finance Xero tables (expand/contract; recorded in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`).
