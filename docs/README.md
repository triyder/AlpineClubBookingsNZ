# Documentation

Start here when you are evaluating, adapting, or operating
AlpineClubBookingsNZ.

## New Adopters

1. Read `../README.md` for the product scope, stack, and quick setup.
2. Follow `IMPLEMENTATION_GUIDE.md` to configure a fork for your own club.
3. Use `../CONFIGURATION.md` as the environment and `config/club.json`
   reference.
4. Read `DEPLOYMENT.md` before putting a shared or production environment
   online.

## Developers

- `ARCHITECTURE.md` explains the runtime shape, module boundaries, data model,
  integrations, cron jobs, and deployment approach.
- `DOMAIN_INVARIANTS.md`, `STATE_MACHINES.md`,
  `END_TO_END_TEST_MATRIX.md`, and `UX_FLOW_MAP.md` capture the first-pass
  domain and review map used by Codex issue work.
- `agents/CODEX_WORKFLOW.md` is the operating guide for Codex agents, with
  issue, prompt, profile, subagent, severity, and prompt-injection references
  in the same directory.
- `ONGOING-DEVELOPMENT-WORKFLOW.md` explains how generic public changes and
  private deployment-fork changes should flow.
- `MAINTENANCE.md` records the public validation and release checklist.
- `E2E_PLAYWRIGHT.md` covers the Playwright browser E2E suite that drives the
  Critical journeys against the staging compose stack.
- `STAGING_ACCESSIBILITY.md` covers non-production browser and Lighthouse
  checks.

## Operators

- `DEPLOYMENT.md` is the bootstrap and blue/green deployment reference.
- `BLUE_GREEN_MIGRATION_POLICY.md` defines how migrations must be structured
  for safe cutover.
- `ACCESS_ROLE_MEMBERSHIP_CLEANUP_AUDIT.md` rehearses and audits the
  access-role and membership-type cleanup migrations on disposable data.
- `AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` covers audit-log retention and optional
  archival.
- `HASHED_TOKEN_MIGRATION.md` documents the historical token hashing migration.

## Finance Dashboard

The `finance-dashboard/` directory contains the finance reporting contracts,
architecture decisions, data-contract notes, and test plan. Start with
`finance-dashboard/README.md`.
